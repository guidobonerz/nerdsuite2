package emu

// The HTTP API of the launcher: the status of the emulators, run a program, stop. One process per
// platform: a new run replaces the emulator running the platform.

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"nerdsuite/backend/core"
)

// maxBody: the largest request (a program in base64)
const maxBody = 32 * 1024 * 1024

// killWait: how long a kill waits for the process to end
const killWait = 3 * time.Second

// process: an emulator started for a platform; done is closed when it has ended
type process struct {
	cmd      *exec.Cmd
	emulator string
	done     chan struct{}
}

func (p *process) exited() bool {
	select {
	case <-p.done:
		return true
	default:
		return false
	}
}

// API: the launcher; the emulators it started, one per platform
type API struct {
	env    core.Env
	tmpDir string
	mu     sync.Mutex
	procs  map[string]*process // platform -> process
	runMu  sync.Mutex          // one run at a time: the kill, the files and the start belong together
}

// New: the launcher; its files go to env.TmpDir (else nerdsuite-emu in the temp folder)
func New(env core.Env) *API {
	tmp := env.TmpDir
	if tmp == "" {
		tmp = filepath.Join(os.TempDir(), "nerdsuite-emu")
	}
	return &API{env: env, tmpDir: tmp, procs: map[string]*process{}}
}

func (a *API) resolveExe(d core.ToolDef) string { return core.ResolveExe(a.env.Settings, d) }

// emuStatus: an emulator for a platform; Exe is null when it is not found
type emuStatus struct {
	ID        string  `json:"id"`
	Platform  string  `json:"platform"`
	Exe       *string `json:"exe"`
	Available bool    `json:"available"`
	Running   bool    `json:"running"`
}

type statusAnswer struct {
	Emulators []emuStatus `json:"emulators"`
}

// status: every emulator/platform pair, where it is and whether it runs
func (a *API) status() statusAnswer {
	emulators := []emuStatus{}
	for _, d := range Emulators {
		exe := a.resolveExe(d)
		var ep *string
		if exe != "" {
			ep = &exe
		}
		for _, platform := range d.Platforms {
			a.mu.Lock()
			cur := a.procs[platform]
			a.mu.Unlock()
			emulators = append(emulators, emuStatus{
				ID: d.ID, Platform: platform, Exe: ep, Available: exe != "",
				Running: cur != nil && cur.emulator == d.ID && !cur.exited(),
			})
		}
	}
	return statusAnswer{Emulators: emulators}
}

// killPlatform: stop the emulator of a platform, waiting up to 3 s for it to end
func (a *API) killPlatform(platform string) {
	a.mu.Lock()
	cur := a.procs[platform]
	delete(a.procs, platform)
	a.mu.Unlock()
	if cur == nil || cur.exited() {
		return
	}
	if cur.cmd.Process.Kill() != nil {
		return
	}
	select {
	case <-cur.done:
	case <-time.After(killWait):
	}
}

// killAll: stop the emulators of every platform
func (a *API) killAll() {
	a.mu.Lock()
	platforms := make([]string, 0, len(a.procs))
	for p := range a.procs {
		platforms = append(platforms, p)
	}
	a.mu.Unlock()
	var wg sync.WaitGroup
	for _, p := range platforms {
		wg.Add(1)
		go func(p string) { defer wg.Done(); a.killPlatform(p) }(p)
	}
	wg.Wait()
}

// Close: kill the running emulators (server shutdown)
func (a *API) Close() { a.killAll() }

// runAnswer: what was started; Note: what the user has to type (atari800 cannot type)
type runAnswer struct {
	OK       bool   `json:"ok"`
	Emulator string `json:"emulator"`
	File     string `json:"file"`
	Command  string `json:"command"`
	Note     string `json:"note,omitempty"`
}

// run: check the request, build the files, start the emulator
func (a *API) run(body map[string]any) (runAnswer, error) {
	platform, _ := body["platform"].(string)
	format, _ := body["format"].(string)
	fs, ok := formatsOf(platform)
	if !ok {
		return runAnswer{}, core.Errorf(400, "unknown platform '%s' (one of %s)", jsString(body, "platform"), platformList())
	}
	if !contains(fs, format) {
		return runAnswer{}, core.Errorf(400, "format must be one of %s for %s", strings.Join(fs, ", "), platform)
	}
	b64, ok := body["data"].(string)
	if !ok {
		return runAnswer{}, core.Errorf(400, "'data' must be a base64 string")
	}
	data := decodeBase64(b64)
	if len(data) == 0 {
		return runAnswer{}, core.Errorf(400, "'data' is empty")
	}

	var def core.ToolDef
	if truthy(body, "emulator") {
		id, _ := body["emulator"].(string)
		d, ok := emulatorByID(id)
		if !ok || !runsOn(d, platform) {
			return runAnswer{}, core.Errorf(400, "emulator '%s' does not support platform '%s'", jsString(body, "emulator"), platform)
		}
		def = d
	} else {
		// the emulator chosen in the settings first, then the others in their order
		order := append([]string{a.env.Settings.Preferred(platform)}, preferredOf(platform)...)
		found := false
		for _, id := range order {
			if id == "" {
				continue
			}
			if d, ok := emulatorByID(id); ok && runsOn(d, platform) && a.resolveExe(d) != "" {
				def, found = d, true
				break
			}
		}
		if !found {
			return runAnswer{}, core.Errorf(404, "no emulator for %s found", platform)
		}
	}
	exe := a.resolveExe(def)
	if exe == "" {
		return runAnswer{}, core.Errorf(404, "%s not found (set its path in the settings, or env %s)", def.ID, def.Env)
	}
	// atari800 with a listing: still launched, but auto-typing is not possible (see the note)

	name := ""
	if truthy(body, "name") {
		name = jsString(body, "name")
	}
	machine, _ := body["machine"].(string)
	p, err := planRun(runRequest{
		Platform: platform, Emulator: def.ID, Name: name, Data: data, Format: format,
		Load: jsInteger(body["load"]), Exec: jsInteger(body["exec"]), Machine: machine,
	}, a.tmpDir, exe)
	if err != nil {
		return runAnswer{}, err
	}

	a.runMu.Lock()
	defer a.runMu.Unlock()
	a.killPlatform(platform) // one process per platform; a new run replaces the old one
	for _, f := range p.Files {
		if err := os.MkdirAll(filepath.Dir(f.Path), 0o755); err != nil {
			return runAnswer{}, err
		}
		if err := os.WriteFile(f.Path, f.Data, 0o644); err != nil {
			return runAnswer{}, err
		}
	}
	// the emulator gets its own window (no HideWindow); its output is not read
	cmd := exec.Command(exe, p.Args...)
	cmd.Dir = p.Cwd
	if err := cmd.Start(); err != nil {
		return runAnswer{}, core.Errorf(500, "cannot start %s: %v", def.ID, err)
	}
	entry := &process{cmd: cmd, emulator: def.ID, done: make(chan struct{})}
	a.mu.Lock()
	a.procs[platform] = entry
	a.mu.Unlock()
	go func() {
		cmd.Wait()
		close(entry.done)
		a.mu.Lock()
		if a.procs[platform] == entry {
			delete(a.procs, platform)
		}
		a.mu.Unlock()
	}()
	res := runAnswer{OK: true, Emulator: def.ID, File: p.File, Command: core.FormatCommand(exe, p.Args)}
	if def.ID == "atari800" && format == "atascii-lst" {
		res.Note = `type ENTER "H1:` + dosStem(name) + `.LST" and RUN`
	}
	return res, nil
}

// ServeHTTP: the routes of /api/emu
func (a *API) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	if path != "/api/emu" && !strings.HasPrefix(path, "/api/emu/") {
		// not a route of the launcher: the 404 of the server
		core.WriteJSON(w, 404, map[string]any{"error": "not found"})
		return
	}
	route := strings.ToUpper(r.Method) + " " + strings.TrimRight(path, "/")
	switch route {
	case "GET /api/emu/status":
		core.WriteJSON(w, 200, a.status())
	case "POST /api/emu/run":
		body, err := readBody(r)
		if err == nil && body == nil {
			err = errors.New("Cannot destructure property 'platform' of 'body' as it is null.")
		}
		var res runAnswer
		if err == nil {
			res, err = a.run(body)
		}
		if err != nil {
			core.Fail(w, err)
			return
		}
		core.WriteJSON(w, 200, res)
	case "POST /api/emu/stop":
		body, err := readBody(r)
		if err == nil && body == nil {
			err = errors.New("Cannot read properties of null (reading 'platform')")
		}
		if err != nil {
			core.Fail(w, err)
			return
		}
		if truthy(body, "platform") {
			a.killPlatform(jsString(body, "platform"))
		} else {
			a.killAll()
		}
		core.WriteJSON(w, 200, map[string]any{"ok": true})
	default:
		core.Fail(w, core.Errorf(404, "no route %s", route))
	}
}

// readBody: the JSON of a request with the messages of the Node server; an empty body is {}, a
// JSON that is no object (an array, a number) has none of the fields, null is nil
func readBody(r *http.Request) (map[string]any, error) {
	data, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxBody {
		return nil, core.Errorf(413, "body too large")
	}
	t := strings.TrimSpace(string(data))
	if t == "" {
		return map[string]any{}, nil
	}
	var v any
	if json.Unmarshal([]byte(t), &v) != nil {
		return nil, core.Errorf(400, "invalid JSON body")
	}
	if v == nil {
		return nil, nil
	}
	if m, ok := v.(map[string]any); ok {
		return m, nil
	}
	return map[string]any{}, nil
}

// decodeBase64: base64 the way Node's Buffer.from(s, 'base64') reads it - the URL alphabet too,
// other characters skipped, the end at the first '=', the padding optional
func decodeBase64(s string) []byte {
	var b strings.Builder
	for _, c := range s {
		switch {
		case c == '=':
			goto done
		case c == '-':
			b.WriteByte('+')
		case c == '_':
			b.WriteByte('/')
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '+', c == '/':
			b.WriteRune(c)
		}
	}
done:
	t := b.String()
	if len(t)%4 == 1 { // a single character is no byte
		t = t[:len(t)-1]
	}
	out, err := base64.RawStdEncoding.DecodeString(t)
	if err != nil {
		return nil
	}
	return out
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// truthy: a field is there and not false, 0, "" or null (as JavaScript tests it)
func truthy(body map[string]any, key string) bool {
	switch v := body[key].(type) {
	case nil:
		return false
	case bool:
		return v
	case string:
		return v != ""
	case float64:
		return v != 0 && !math.IsNaN(v)
	}
	return true
}

// jsString: a field as JavaScript puts it into a string ("undefined" when it is not there)
func jsString(body map[string]any, key string) string {
	v, ok := body[key]
	if !ok {
		return "undefined"
	}
	return jsValue(v)
}

func jsValue(v any) string {
	switch v := v.(type) {
	case nil:
		return "null"
	case string:
		return v
	case bool:
		return strconv.FormatBool(v)
	case float64:
		return jsNumber(v)
	case []any:
		parts := make([]string, len(v))
		for i, x := range v {
			if x != nil {
				parts[i] = jsValue(x)
			}
		}
		return strings.Join(parts, ",")
	}
	return "[object Object]"
}

// jsNumber: a number as JavaScript writes it (1e+21 and 1e-7 in exponent form)
func jsNumber(f float64) string {
	abs := math.Abs(f)
	if f == 0 || abs >= 1e-6 && abs < 1e21 {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	s := strconv.FormatFloat(f, 'e', -1, 64)
	if i := strings.Index(s, "e"); i >= 0 {
		exp := s[i+2:]
		exp = strings.TrimLeft(exp, "0")
		s = s[:i+2] + exp
	}
	return s
}

// jsInteger: an integer field (Number.isInteger), nil otherwise; wrapped to 32 bits like the bit
// operators of JavaScript (the header keeps 16 of them)
func jsInteger(v any) *int {
	f, ok := v.(float64)
	if !ok || math.IsInf(f, 0) || math.IsNaN(f) || f != math.Trunc(f) {
		return nil
	}
	m := math.Mod(f, 4294967296)
	if m < 0 {
		m += 4294967296
	}
	n := int(int32(uint32(m)))
	return &n
}
