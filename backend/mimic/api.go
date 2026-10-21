package mimic

// The HTTP/JSON + Server-Sent-Events API of mimic, under /api/mimic - the routes and the JSON of
// /api/vice, so that the debugger of the IDE (vice.js, debugview.js) works with either:
//   GET  events                 the events: status, stopped, resumed, checkpoint, jam, exit, log
//   GET  status                 { available, exe, running, connected, stopped, pc, machine, version }
//   POST start { machine, model, args, exe }, stop, pause, continue, step { count, over }, return,
//        reset { hard }, joystick { port, value }, keyboard { text } (the CPC, the Atari XL)
//   POST load { name, prg (base64), run } - a .prg; or { name, data (base64), format, load, exec }: format
//        "prg", "xex" (the Atari), "amsdos-bin" (a CPC binary: poked and CALLed), "cpc-ascii" (a BASIC
//        listing on a disc, RUN), "atascii-lst" (an Atari BASIC listing, typed in, RUN), "a26" (a 2600
//        cartridge: inserted, the console powers up)
//   GET  registers, POST registers { a: 1, ... }; GET memory ?start&end&bank, POST memory { start,
//        data (base64), bank } - bank: a memory space of mimic (GET banks); GET display
//   GET  stream ?fps&screen     WebSocket: the raw stream of mimic's preview server, passed through (its
//        messages: crates/emu-preview/src/raw.rs of mimic - palette indices, only the changed lines)
//   GET/POST checkpoints, GET/POST/PUT/PATCH/DELETE checkpoints/<id>
// keyboard types on the CPC and the Atari only (key events of their keyboards): 501 for the others.
// Numbers may be sent as 49152, "49152", "$c000" or "0xc000"; flags as true, 1, "1" or "true".

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"nerdsuite/backend/core"
	"nerdsuite/backend/emu"
)

const prefix = "/api/mimic"

// maxBody: the largest request (a program in base64)
const maxBody = 32 * 1024 * 1024

// heartbeat: how often the event streams get a comment, so that no proxy closes them
const heartbeat = 15 * time.Second

// API: the bridge and the clients of its events
type API struct {
	env    core.Env
	tmpDir string
	b      *bridge

	mu      sync.Mutex
	clients map[*sseClient]struct{}

	closed    chan struct{}
	closeOnce sync.Once
}

// New: the API; the programs loaded go to env.TmpDir (else nerdsuite-mimic in the temp folder)
func New(env core.Env) *API { return newAPI(env, bridgeOptions{}) }

func newAPI(env core.Env, opts bridgeOptions) *API {
	tmp := env.TmpDir
	if tmp == "" {
		tmp = filepath.Join(os.TempDir(), "nerdsuite-mimic")
	}
	if env.Settings == nil {
		env.Settings = core.NewSettings("")
	}
	a := &API{env: env, tmpDir: tmp, clients: map[*sseClient]struct{}{}, closed: make(chan struct{})}
	a.b = newBridge(env.Settings, opts)
	a.b.listener = func(event string, data any) {
		if event == "status" {
			data = a.statusOf(data.(status))
		}
		a.broadcast(event, data)
	}
	go a.heartbeat()
	return a
}

// Close: the event streams end and mimic is stopped
func (a *API) Close() {
	a.closeOnce.Do(func() {
		close(a.closed)
		a.mu.Lock()
		for c := range a.clients {
			c.end()
		}
		a.clients = map[*sseClient]struct{}{}
		a.mu.Unlock()
		a.b.stop()
	})
}

// apiStatus: the status the IDE shows
type apiStatus struct {
	Available bool    `json:"available"`
	Exe       *string `json:"exe"`
	Running   bool    `json:"running"`
	Connected bool    `json:"connected"`
	Stopped   bool    `json:"stopped"`
	PC        *int    `json:"pc"`
	Machine   *string `json:"machine"`
	Version   *string `json:"version"`
}

func (a *API) status() apiStatus { return a.statusOf(a.b.status()) }

func (a *API) statusOf(s status) apiStatus {
	exe := s.Exe
	if !s.Running {
		exe = strp(FindExecutable(a.env.Settings))
	}
	return apiStatus{Available: exe != nil, Exe: exe, Running: s.Running, Connected: s.Connected, Stopped: s.Stopped,
		PC: s.PC, Machine: s.Machine, Version: s.Version}
}

// ---------------------------------------------------------------- the events

type sseClient struct {
	mu     sync.Mutex
	queue  [][]byte
	notify chan struct{}
	done   chan struct{}
	once   sync.Once
}

func newClient() *sseClient {
	return &sseClient{notify: make(chan struct{}, 1), done: make(chan struct{})}
}

func (c *sseClient) push(msg []byte) {
	c.mu.Lock()
	c.queue = append(c.queue, msg)
	c.mu.Unlock()
	select {
	case c.notify <- struct{}{}:
	default:
	}
}

func (c *sseClient) take() [][]byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	q := c.queue
	c.queue = nil
	return q
}

func (c *sseClient) end() { c.once.Do(func() { close(c.done) }) }

func (a *API) broadcast(event string, data any) {
	body, err := json.Marshal(data)
	if err != nil {
		return
	}
	msg := []byte(fmt.Sprintf("event: %s\ndata: %s\n\n", event, body))
	a.mu.Lock()
	defer a.mu.Unlock()
	for c := range a.clients {
		c.push(msg)
	}
}

func (a *API) heartbeat() {
	t := time.NewTicker(heartbeat)
	defer t.Stop()
	for {
		select {
		case <-a.closed:
			return
		case <-t.C:
			a.mu.Lock()
			for c := range a.clients {
				c.push([]byte(": ping\n\n"))
			}
			a.mu.Unlock()
		}
	}
}

// openStream: the WebSocket /stream of mimic's preview server for the page - the handshake goes to mimic
// as the browser sent it, then the bytes are copied both ways (the picture to the page, its input to
// mimic) until one side closes; mimic ending closes it as well
func (a *API) openStream(w http.ResponseWriter, r *http.Request) error {
	port := a.b.preview()
	if port == 0 {
		return mErr(409, "mimic is not running")
	}
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") || r.Header.Get("Sec-WebSocket-Key") == "" {
		return mErr(426, "WebSocket only")
	}
	hj, isHijacker := w.(http.Hijacker)
	if !isHijacker {
		return mErr(500, "the connection cannot be taken over")
	}
	up, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 5*time.Second)
	if err != nil {
		return mErr(502, "the picture of mimic: %v", err)
	}
	q := url.Values{}
	for _, k := range []string{"fps", "screen"} {
		if v := r.URL.Query().Get(k); v != "" {
			q.Set(k, v)
		}
	}
	req := fmt.Sprintf("GET /stream?%s HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n", q.Encode(), port)
	for _, k := range []string{"Sec-WebSocket-Key", "Sec-WebSocket-Version"} {
		if v := r.Header.Get(k); v != "" {
			req += k + ": " + v + "\r\n"
		}
	}
	if _, err := io.WriteString(up, req+"\r\n"); err != nil {
		up.Close()
		return mErr(502, "the picture of mimic: %v", err)
	}
	conn, rw, err := hj.Hijack()
	if err != nil {
		up.Close()
		return mErr(500, "the connection cannot be taken over: %v", err)
	}
	done := make(chan struct{})
	go func() {
		select {
		case <-a.closed:
		case <-done:
		}
		conn.Close()
		up.Close()
	}()
	go func() {
		io.Copy(up, rw) // what the browser sent after the request (buffered) and from now on
		up.Close()
	}()
	io.Copy(conn, up)
	close(done)
	return nil
}

func (a *API) openEvents(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-cache, no-transform")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	rc := http.NewResponseController(w)
	rc.SetWriteDeadline(time.Time{}) // the stream stays open
	c := newClient()
	st, _ := json.Marshal(a.status())
	c.push([]byte("retry: 2000\n\n"))
	c.push([]byte(fmt.Sprintf("event: status\ndata: %s\n\n", st)))
	select {
	case <-a.closed:
		return
	default:
	}
	a.mu.Lock()
	a.clients[c] = struct{}{}
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		delete(a.clients, c)
		a.mu.Unlock()
	}()
	for {
		for _, msg := range c.take() {
			if _, err := w.Write(msg); err != nil {
				return
			}
		}
		rc.Flush()
		select {
		case <-r.Context().Done():
			return
		case <-c.done:
			return
		case <-c.notify:
		}
	}
}

// ---------------------------------------------------------------- the values of a request

var hexNumber = regexp.MustCompile(`^(\$|0[xX])([0-9a-fA-F]+)$`)

// num: a number of a request (a JSON number, or a text: decimal, $hex, 0xhex) in [lo, hi]; def when absent
func num(v any, name string, lo, hi int, def *int) (int, error) {
	var f float64
	switch x := v.(type) {
	case nil:
		if def != nil {
			return *def, nil
		}
		return 0, mErr(400, "'%s' is missing", name)
	case float64:
		f = x
	case string:
		x = strings.TrimSpace(x)
		if x == "" && def != nil {
			return *def, nil
		}
		if m := hexNumber.FindStringSubmatch(x); m != nil {
			n, err := strconv.ParseInt(m[2], 16, 64)
			if err != nil {
				return 0, mErr(400, "'%s' must be a number", name)
			}
			f = float64(n)
		} else if n, err := strconv.ParseFloat(x, 64); err == nil {
			f = n
		} else {
			return 0, mErr(400, "'%s' must be a number", name)
		}
	default:
		return 0, mErr(400, "'%s' must be a number", name)
	}
	if math.Trunc(f) != f || f < float64(lo) || f > float64(hi) {
		return 0, mErr(400, "'%s' must be an integer from %d to %d", name, lo, hi)
	}
	return int(f), nil
}

// flag: a flag of a request
func flag(v any, def bool) bool {
	switch x := v.(type) {
	case nil:
		return def
	case bool:
		return x
	case float64:
		return x != 0
	case string:
		x = strings.ToLower(strings.TrimSpace(x))
		return x == "1" || x == "true" || x == "yes" || x == "on"
	}
	return def
}

func b64(v any, name string) ([]byte, error) {
	s, ok := v.(string)
	if !ok {
		return nil, mErr(400, "'%s' must be base64", name)
	}
	data, err := base64.StdEncoding.DecodeString(strings.TrimSpace(s))
	if err != nil {
		return nil, mErr(400, "'%s' must be base64", name)
	}
	return data, nil
}

// ---------------------------------------------------------------- the routes

// ServeHTTP: every route under /api/mimic
func (a *API) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	if path != prefix && !strings.HasPrefix(path, prefix+"/") {
		core.WriteJSON(w, 404, map[string]any{"error": "not found"})
		return
	}
	if err := a.route(w, r, path); err != nil {
		core.Fail(w, err)
	}
}

func ok(w http.ResponseWriter, v any) error {
	core.WriteJSON(w, 200, v)
	return nil
}

func answer[T any](w http.ResponseWriter, v T, err error) error {
	if err != nil {
		return err
	}
	return ok(w, v)
}

var okBody = map[string]any{"ok": true}

var checkpointPath = regexp.MustCompile(`^/checkpoints/([0-9]+)$`)

// load: a program into the machine, by its format
func (a *API) load(w http.ResponseWriter, body map[string]any) error {
	name, _ := body["name"].(string)
	format, _ := body["format"].(string)
	field := "data"
	if _, has := body["prg"]; has {
		format, field = "prg", "prg"
	}
	if format == "" {
		format = "prg"
	}
	data, err := b64(body[field], field)
	if err != nil {
		return err
	}
	if len(data) == 0 {
		return mErr(400, "'%s' is empty", field)
	}
	opt := func(k string) (*int, error) {
		if body[k] == nil {
			return nil, nil
		}
		n, err := num(body[k], k, 0, 0xffff, nil)
		return &n, err
	}
	machine := a.b.machineIs()
	stem := strings.TrimSuffix(filepath.Base(strings.ReplaceAll(name, "\\", "/")), filepath.Ext(name))
	if stem == "" || stem == "." || stem == "/" {
		stem = "program"
	}
	switch {
	case format == "prg" && slices.Contains(Commodore, machine), format == "xex" && machine == "atari800xl",
		format == "a26" && machine == "atari2600":
		if format == "prg" && len(data) < 3 {
			return mErr(400, "'prg' must contain a load address and data")
		}
		if format != "prg" {
			name = stem + "." + format
		}
		file, err := writeTemp(a.tmpDir, name, data)
		if err != nil {
			return err
		}
		_, err = a.b.load(file, flag(body["run"], true))
		return answer(w, a.status(), err)
	case format == "amsdos-bin" && machine == "cpc":
		load, err := opt("load")
		if err != nil {
			return err
		}
		exec, err := opt("exec")
		if err != nil {
			return err
		}
		code, at, start, err := emu.AmsdosBinary(data, load, exec)
		if err != nil {
			return mErr(400, "%v", err)
		}
		_, err = a.b.loadBinary(code, at, start)
		return answer(w, a.status(), err)
	case format == "atascii-lst" && machine == "atari800xl":
		_, err := a.b.loadListing(data)
		return answer(w, a.status(), err)
	case format == "cpc-ascii" && machine == "cpc":
		dsk, run, err := emu.CPCDisk(stem, "ascii", data, nil, nil)
		if err != nil {
			return mErr(400, "%v", err)
		}
		file, err := writeTemp(a.tmpDir, run+".dsk", dsk)
		if err != nil {
			return err
		}
		_, err = a.b.loadDisk(file, run)
		return answer(w, a.status(), err)
	}
	return mErr(400, "mimic's %s does not load the format '%s'", machine, format)
}

func (a *API) route(w http.ResponseWriter, r *http.Request, path string) error {
	method := strings.ToUpper(r.Method)
	sub := strings.TrimRight(path[len(prefix):], "/")
	q := r.URL.Query()
	query := func(name string) any {
		if !q.Has(name) {
			return nil
		}
		return q.Get(name)
	}
	switch method + " " + sub {
	case "GET /events":
		a.openEvents(w, r)
		return nil
	case "GET /status":
		return ok(w, a.status())
	case "GET /stream":
		return a.openStream(w, r)
	}

	body := map[string]any{}
	if method == "POST" || method == "PUT" || method == "PATCH" {
		if err := core.ReadJSON(r, maxBody, &body); err != nil {
			return err
		}
		if body == nil {
			body = map[string]any{}
		}
	}
	zero := 0
	switch method + " " + sub {
	case "POST /start":
		machine := "c64"
		if m, _ := body["machine"].(string); m != "" {
			machine = m
		}
		var args []string
		if v, has := body["args"]; has && v != nil {
			list, isList := v.([]any)
			if !isList {
				return mErr(400, "'args' must be an array")
			}
			for _, x := range list {
				args = append(args, fmt.Sprint(x))
			}
		}
		exe, _ := body["exe"].(string)
		model, _ := body["model"].(string)
		if _, err := a.b.start(startOpts{machine: machine, model: model, exe: exe, args: args}); err != nil {
			return err
		}
		return ok(w, a.status())
	case "POST /stop":
		a.b.stop()
		return ok(w, a.status())
	case "POST /load":
		if !a.b.running() {
			return mErr(409, "mimic is not running")
		}
		return a.load(w, body)
	case "POST /pause":
		s, err := a.b.pause()
		return answer(w, s, err)
	case "POST /continue":
		if _, err := a.b.resume(); err != nil {
			return err
		}
		return ok(w, a.status())
	case "POST /step":
		one := 1
		count, err := num(body["count"], "count", 1, 0xffff, &one)
		if err != nil {
			return err
		}
		s, err := a.b.step(count, flag(body["over"], false))
		return answer(w, s, err)
	case "POST /return":
		s, err := a.b.stepReturn()
		return answer(w, s, err)
	case "POST /reset":
		if _, err := a.b.resetCPU(flag(body["hard"], false)); err != nil {
			return err
		}
		return ok(w, a.status())
	case "GET /registers":
		v, err := a.b.getRegisters()
		return answer(w, v, err)
	case "POST /registers":
		values := map[string]int{}
		for k, v := range body {
			n, err := num(v, k, 0, 0xffff, nil)
			if err != nil {
				return err
			}
			values[k] = n
		}
		v, err := a.b.setRegisters(values)
		return answer(w, v, err)
	case "GET /memory":
		start, err := num(query("start"), "start", 0, 0xffff, &zero)
		if err != nil {
			return err
		}
		def := min(0xffff, start+255)
		end, err := num(query("end"), "end", 0, 0xffff, &def)
		if err != nil {
			return err
		}
		if end < start {
			return mErr(400, "'end' must be >= 'start'")
		}
		bk, err := num(query("bank"), "bank", 0, 0xffff, &zero)
		if err != nil {
			return err
		}
		data, err := a.b.readMemory(start, end, bk)
		if err != nil {
			return err
		}
		return ok(w, map[string]any{"start": start, "end": end, "data": base64.StdEncoding.EncodeToString(data)})
	case "POST /memory":
		start, err := num(body["start"], "start", 0, 0xffff, nil)
		if err != nil {
			return err
		}
		data, err := b64(body["data"], "data")
		if err != nil {
			return err
		}
		if len(data) == 0 {
			return mErr(400, "'data' is empty")
		}
		if start+len(data) > 0x10000 {
			return mErr(400, "data exceeds address space")
		}
		bk, err := num(body["bank"], "bank", 0, 0xffff, &zero)
		if err != nil {
			return err
		}
		if err := a.b.writeMemory(start, data, bk); err != nil {
			return err
		}
		return ok(w, okBody)
	case "GET /banks":
		v, err := a.b.getBanks()
		return answer(w, v, err)
	case "GET /checkpoints":
		v, err := a.b.listCheckpoints()
		return answer(w, v, err)
	case "POST /checkpoints":
		start, err := num(body["start"], "start", 0, 0xffff, nil)
		if err != nil {
			return err
		}
		end, err := num(body["end"], "end", 0, 0xffff, &start)
		if err != nil {
			return err
		}
		if end < start {
			return mErr(400, "'end' must be >= 'start'")
		}
		o := checkpointOpts{start: start, end: end, exec: flag(body["exec"], true), load: flag(body["load"], false),
			store: flag(body["store"], false), enabled: flag(body["enabled"], true), temporary: flag(body["temporary"], false),
			stop: flag(body["stop"], true)}
		if !o.exec && !o.load && !o.store {
			return mErr(400, "one of exec/load/store must be true")
		}
		if c, _ := body["condition"].(string); strings.TrimSpace(c) != "" {
			o.condition = strings.TrimSpace(c)
		}
		if o.space, err = num(body["memspace"], "memspace", 0, 0xffff, &zero); err != nil {
			return err
		}
		v, err := a.b.setCheckpoint(o)
		return answer(w, v, err)
	case "GET /display":
		d, err := a.b.getDisplay()
		if err != nil {
			return err
		}
		return ok(w, map[string]any{"width": d.width, "height": d.height, "innerX": 0, "innerY": 0,
			"innerWidth": d.width, "innerHeight": d.height, "rgba": base64.StdEncoding.EncodeToString(d.rgba)})
	case "POST /keyboard":
		text, isText := body["text"].(string)
		if !isText {
			return mErr(400, "'text' must be a string")
		}
		if err := a.b.typeText(text); err != nil {
			return err
		}
		return ok(w, okBody)
	case "POST /joystick":
		two := 2
		port, err := num(body["port"], "port", 1, 2, &two)
		if err != nil {
			return err
		}
		value, err := num(body["value"], "value", 0, 0xffff, &zero)
		if err != nil {
			return err
		}
		if err := a.b.setJoystick(port, value); err != nil {
			return err
		}
		return ok(w, okBody)
	}

	if m := checkpointPath.FindStringSubmatch(sub); m != nil {
		n, err := strconv.ParseUint(m[1], 10, 32)
		if err != nil {
			return mErr(400, "'id' must be a number")
		}
		id := uint32(n)
		switch method {
		case "POST", "PUT", "PATCH":
			enabled, has := body["enabled"]
			if !has {
				v, err := a.b.getCheckpoint(id)
				return answer(w, v, err)
			}
			v, err := a.b.toggleCheckpoint(id, flag(enabled, false))
			return answer(w, v, err)
		case "GET":
			v, err := a.b.getCheckpoint(id)
			return answer(w, v, err)
		case "DELETE":
			if err := a.b.deleteCheckpoint(id); err != nil {
				return err
			}
			return ok(w, okBody)
		}
	}
	return mErr(404, "no route %s %s", method, path)
}
