// Package toolchain - the toolchains: a program goes from its compiler through a packer to its
// emulator. A toolchain is set up in the Settings of the IDE (core.Settings keeps it, { toolchains: [...] })
// and a project picks one (nerdsuite.json "toolchain"):
//
//	compiler   project (ACME or KickAssembler as the project sets it), acme, kickass, or a command
//	           (64tass, cc65, oscar64 ...) that the files of the project are given to
//	packer     none, exomizer, pucrunch, dali, or a command
//	emulator   auto (VICE, or the emulator of the platform), an emulator of the emulators, or a command
//
// The commands are the settings' only: a request names the toolchain, never a command of its own.
//
//	POST /api/toolchain/compile { toolchain, main, files: { path: base64 }, platform, ext }
//	     -> { ok, errors: [{ file, line, col, msg, severity }], output /*base64*/, outputName, log, command }
//	POST /api/toolchain/pack    { toolchain, platform, name, data /*base64*/, entry: 'basic' | 'sys' | address }
//	     -> { ok, output /*base64*/, before, after, log, command }
//	POST /api/toolchain/run     { toolchain, platform, name, data /*base64*/, ext } -> { ok, file, command }
//	POST /api/toolchain/stop    { toolchain? }
//
// In a command: {in} {out} the files of the packer, {main} the source (relative to {dir}, the folder
// of the project), {out} the program the compiler writes, {file} the program the emulator starts,
// {name} its name, {platform} the machine (c64, atari8 ...), {exec} the start address ($hex as 0x0810).
package toolchain

import (
	"encoding/base64"
	"fmt"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"nerdsuite/backend/core"
)

const (
	timeout = 120 * time.Second
	maxBody = 32 * 1024 * 1024
)

var apps = core.AppsDir()

// Packers: the packers the server knows, in the order the settings show them
var Packers = []core.ToolDef{
	{ID: "exomizer", Name: "Exomizer", Env: "EXOMIZER", Path: []string{"exomizer"}, Dir: filepath.Join(apps, "exomizer"), DirNames: []string{"exomizer.exe", "exomizer"},
		Defaults: []string{filepath.Join(apps, "exomizer", "win32", "exomizer.exe"), filepath.Join(apps, "C64-Kickass-IDE", "tools", "exomizer.exe")},
		Machines: []string{"c64", "c128", "vic20", "plus4", "c16", "atari8"}},
	{ID: "pucrunch", Name: "pucrunch", Env: "PUCRUNCH", Path: []string{"pucrunch"}, Dir: filepath.Join(apps, "pucrunch"), DirNames: []string{"pucrunch.exe", "pucrunch"}, Defaults: []string{},
		Machines: []string{"c64", "c128", "vic20", "plus4", "c16"}},
	{ID: "dali", Name: "Dali", Env: "DALI", Path: []string{"dali"}, Dir: filepath.Join(apps, "dali"), DirNames: []string{"dali.exe", "dali"}, Defaults: []string{},
		Machines: []string{"c64"}},
}

// the decruncher of each machine
var (
	exoTarget = map[string]int{"c64": 64, "c128": 128, "vic20": 20, "plus4": 4, "c16": 4, "atari8": 168}
	puTarget  = map[string]string{"c64": "-c64", "c128": "-c128", "vic20": "-c20", "plus4": "-c16", "c16": "-c16"}
)

func hex(n int) string { return fmt.Sprintf("0x%04x", n) }

// entry: where a packed program starts - "basic" (a BASIC program), "sys" (the address of its SYS
// line), else Addr, the address it jumps to
type entry struct {
	Word string
	Addr int
}

func (e entry) at() string {
	if e.Word != "" {
		return e.Word
	}
	return hex(e.Addr)
}

var (
	wordRe        = jsRe(`"((?:[^"\\]|\\` + jsDot + `)*)"|(\S+)`)
	placeholderRe = regexp.MustCompile(`\{(\w+)\}`)
)

// splitCommand: a command line as its words: "quoted words" stay one, the placeholders are filled in
// after the split (a path with spaces is one word)
func splitCommand(text string, values map[string]string) []string {
	words := []string{}
	for _, m := range wordRe.FindAllStringSubmatchIndex(text, -1) {
		if m[2] >= 0 {
			words = append(words, strings.ReplaceAll(text[m[2]:m[3]], `\"`, `"`))
		} else {
			words = append(words, text[m[4]:m[5]])
		}
	}
	for i, w := range words {
		words[i] = placeholderRe.ReplaceAllStringFunc(w, func(all string) string {
			if v, ok := values[all[1:len(all)-1]]; ok {
				return v
			}
			return all
		})
	}
	return words
}

func has(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// packArgs: the arguments of a packer
func packArgs(packer core.ToolDef, machine, input, output string, at entry, extra []string) ([]string, error) {
	if packer.ID != "command" && !has(packer.Machines, machine) {
		return nil, core.Errorf(400, "%s does not pack programs of the %s", packer.Name, machine)
	}
	cat := func(parts ...[]string) []string {
		out := []string{}
		for _, p := range parts {
			out = append(out, p...)
		}
		return out
	}
	switch packer.ID {
	case "exomizer":
		// basic: a BASIC program, sys: the address of its SYS line, else where it jumps to
		return cat([]string{"sfx", at.at(), fmt.Sprintf("-t%d", exoTarget[machine])}, extra, []string{"-o", output, input}), nil
	case "pucrunch":
		if at.Word == "basic" {
			return nil, core.Errorf(400, "pucrunch packs machine code: Exomizer packs BASIC programs")
		}
		x := []string{"-x" + at.at()}
		if at.Word == "sys" {
			x = nil
		}
		return cat([]string{puTarget[machine]}, x, extra, []string{input, output}), nil
	case "dali":
		if at.Word == "basic" {
			return nil, core.Errorf(400, "Dali packs machine code: Exomizer packs BASIC programs")
		}
		if at.Word == "sys" {
			return nil, core.Errorf(400, "Dali needs the address the program starts at, not a SYS line")
		}
		return cat([]string{"--sfx", at.at()}, extra, []string{"-o", output, input}), nil
	}
	return nil, core.Errorf(400, "unknown packer '%s'", packer.ID)
}

// compileError: an error (or a warning) of a compiler; Line and Col are null when it gives none
type compileError struct {
	File     string   `json:"file"`
	Line     *float64 `json:"line"`
	Col      *float64 `json:"col"`
	Msg      string   `json:"msg"`
	Severity string   `json:"severity"`
}

var (
	errorRe   = jsRe(`(?i)^\s*(` + jsDot + `+?)(?::(\d+)(?::(\d+))?|\((\d+)(?:\s*,\s*(\d+))?\))\s*:?\s*(fatal error|error|warning)\b(?:\s*\w*\d+)?\s*:?\s*(` + jsDot + `*)$`)
	lineSplit = regexp.MustCompile(`\r?\n`)
	warnRe    = regexp.MustCompile(`(?i)warn`)
)

// parseErrors: the errors in the output of a compiler: file:line:col: error: msg (gcc, 64tass, ca65),
// file(line, col) : error 3001: msg (oscar64, cc65), file(line): Error: msg (dasm and others)
func parseErrors(log string, toProject func(string) string) []compileError {
	if toProject == nil {
		toProject = func(p string) string { return p }
	}
	out := []compileError{}
	for _, line := range lineSplit.Split(log, -1) {
		m := errorRe.FindStringSubmatchIndex(line)
		if m == nil {
			continue
		}
		g := func(i int) (string, bool) {
			if m[2*i] < 0 {
				return "", false
			}
			return line[m[2*i]:m[2*i+1]], true
		}
		e := compileError{Severity: "error"}
		file, _ := g(1)
		e.File = toProject(jsTrim(file))
		l, ok := g(2)
		if !ok {
			l, _ = g(4)
		}
		n := numberOf(l)
		e.Line = &n
		c, ok := g(3)
		if !ok {
			c, ok = g(5)
		}
		if ok && c != "" {
			n := numberOf(c)
			e.Col = &n
		}
		msg, _ := g(7)
		e.Msg = jsTrim(msg)
		if kind, _ := g(6); warnRe.MatchString(kind) {
			e.Severity = "warning"
		}
		out = append(out, e)
	}
	return out
}

var (
	driveRe = regexp.MustCompile(`(?i)^[a-z]:`)
	nameRe  = regexp.MustCompile(`\.[^.]*$`)
	extRe   = regexp.MustCompile(`^\w{1,8}$`)
	sepRe   = regexp.MustCompile(`[\\/]`)
)

// projectPath: a path of the project the browser sent: relative, no '..'
func projectPath(p any) (string, error) {
	s := ""
	if _, ok := p.(undefined); !ok && p != nil {
		s = strings.ReplaceAll(jsString(p), `\`, "/")
	}
	bad := s == "" || strings.HasPrefix(s, "/") || driveRe.MatchString(s)
	for _, x := range strings.Split(s, "/") {
		if x == ".." || x == "." || x == "" {
			bad = true
		}
	}
	if bad {
		return "", core.Errorf(400, "'%s' is not a path of the project", jsString(p))
	}
	return s, nil
}

// fileName: the name of a program without its folder and its extension, only \w . and - in it
func fileName(n any) string {
	s := "program"
	if jsTruthy(n) {
		s = jsString(n)
	}
	parts := sepRe.Split(s, -1)
	var b strings.Builder
	for _, r := range parts[len(parts)-1] {
		switch {
		case r < 0x80 && (r == '_' || r == '.' || r == '-' || r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z'):
			b.WriteRune(r)
		case r > 0xffff:
			b.WriteString("__") // two UTF-16 units in JavaScript: two of them
		default:
			b.WriteByte('_')
		}
	}
	if out := nameRe.ReplaceAllString(b.String(), ""); out != "" {
		return out
	}
	return "program"
}

// extName: the extension of a program - a word of up to 8 letters, else prg
func extName(e any) string {
	s := ""
	if _, ok := e.(undefined); !ok && e != nil {
		s = jsString(e)
	}
	if extRe.MatchString(s) {
		return s
	}
	return "prg"
}

// syncBuffer: stdout and stderr in the order they come, and the note of the timeout between them
type syncBuffer struct {
	mu sync.Mutex
	b  strings.Builder
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// execute: a program, its exit code and what it wrote (-1: it did not start); what: its name in the
// messages
func execute(cmd string, args []string, cwd, what string) (int, string) {
	c := exec.Command(cmd, args...)
	c.Dir = cwd
	core.HideWindow(c)
	out := &syncBuffer{}
	c.Stdout, c.Stderr = out, out
	if err := c.Start(); err != nil {
		return -1, out.String() + what + " did not start: " + startError(cmd, err)
	}
	timer := time.AfterFunc(timeout, func() {
		out.Write([]byte("\n" + what + " took too long and was stopped"))
		c.Process.Kill()
	})
	c.Wait()
	timer.Stop()
	return c.ProcessState.ExitCode(), out.String()
}

// proc: an emulator a run command started
type proc struct {
	cmd  *exec.Cmd
	done chan struct{}
}

func (p *proc) running() bool {
	select {
	case <-p.done:
		return false
	default:
		return true
	}
}

// API: the routes of /api/toolchain
type API struct {
	env   core.Env
	mu    sync.Mutex
	procs map[string]*proc // toolchain -> the emulator its command started
}

// New: the API
func New(env core.Env) *API {
	if env.TmpDir == "" {
		env.TmpDir = os.TempDir()
	}
	return &API{env: env, procs: map[string]*proc{}}
}

func (a *API) toolchainOf(id any) (core.Toolchain, error) {
	if s, ok := id.(string); ok {
		if tc, ok := a.env.Settings.Toolchain(s); ok {
			return tc, nil
		}
	}
	return core.Toolchain{}, core.Errorf(404, "there is no toolchain '%s' (the Settings set them up)", jsString(id))
}

func data64(v any, what string) ([]byte, error) {
	s, ok := v.(string)
	if !ok {
		return nil, core.Errorf(400, "'%s' must be a base64 string", what)
	}
	b := decodeBase64(s)
	if len(b) == 0 {
		return nil, core.Errorf(400, "'%s' is empty", what)
	}
	return b, nil
}

func (a *API) withWork(prefix string, fn func(work string) (any, error)) (any, error) {
	work, err := os.MkdirTemp(a.env.TmpDir, prefix)
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(work)
	return fn(work)
}

// lastLines: the last three lines of a text that are not empty, one line
func lastLines(text string, skipEmpty bool) string {
	lines := lineSplit.Split(jsTrim(text), -1)
	if skipEmpty {
		kept := []string{}
		for _, l := range lines {
			if l != "" {
				kept = append(kept, l)
			}
		}
		lines = kept
	}
	if len(lines) > 3 {
		lines = lines[len(lines)-3:]
	}
	return strings.Join(lines, " ")
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// orEmpty: v ?? ” as a text
func orEmpty(v any) string {
	if _, ok := v.(undefined); ok || v == nil {
		return ""
	}
	return jsString(v)
}

// resolve: path.resolve(root, p)
func resolve(root, p string) string {
	if filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	if core.IsWindows && filepath.VolumeName(p) == "" && (strings.HasPrefix(p, `\`) || strings.HasPrefix(p, "/")) {
		return filepath.Clean(filepath.VolumeName(root) + p) // \x: the root of the drive
	}
	if core.IsWindows && filepath.VolumeName(p) != "" {
		abs, err := filepath.Abs(p) // C:x: the folder of that drive
		if err == nil {
			return abs
		}
	}
	return filepath.Join(root, p)
}

func (a *API) compile(body any) (any, error) {
	tc, err := a.toolchainOf(field(body, "toolchain"))
	if err != nil {
		return nil, err
	}
	if tc.Compiler.Kind != "command" || jsTrim(tc.Compiler.Command) == "" {
		return nil, core.Errorf(400, "the toolchain %s has no compiler command", tc.Name)
	}
	main, err := projectPath(field(body, "main"))
	if err != nil {
		return nil, err
	}
	return a.withWork("nerdsuite-cc-", func(work string) (any, error) {
		root, outDir := filepath.Join(work, "project"), filepath.Join(work, "out")
		if err := os.MkdirAll(outDir, 0o755); err != nil {
			return nil, err
		}
		files, _ := field(body, "files").(map[string]any)
		for _, p := range sortedKeys(files) {
			rel, err := projectPath(p)
			if err != nil {
				return nil, err
			}
			full := filepath.Join(root, rel)
			if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
				return nil, err
			}
			if err := os.WriteFile(full, decodeBase64(jsString(files[p])), 0o644); err != nil {
				return nil, err
			}
		}
		name := fileName(main)
		outputName := name + "." + extName(field(body, "ext"))
		out := filepath.Join(outDir, outputName)
		words := splitCommand(tc.Compiler.Command, map[string]string{"main": main, "out": out, "dir": root, "name": name, "platform": orEmpty(field(body, "platform"))})
		if len(words) == 0 || words[0] == "" {
			return nil, core.Errorf(400, "the compiler command is empty")
		}
		cmd, args := words[0], words[1:]
		code, log := execute(cmd, args, root, cmd)
		toProject := func(p string) string {
			rel, err := filepath.Rel(root, resolve(root, p))
			if err != nil || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
				return main
			}
			if rel == "." {
				return ""
			}
			return filepath.ToSlash(rel)
		}
		errs := parseErrors(log, toProject)
		output, err := os.ReadFile(out)
		if err != nil {
			output = nil
		} else if output == nil {
			output = []byte{}
		}
		hasError := func() bool {
			for _, e := range errs {
				if e.Severity == "error" {
					return true
				}
			}
			return false
		}
		if (code != 0 || output == nil) && !hasError() {
			msg := fmt.Sprintf("%s wrote no %s: does the command write {out}?", cmd, outputName)
			if code != 0 {
				if msg = lastLines(log, false); msg == "" {
					msg = fmt.Sprintf("%s failed (%d)", cmd, code)
				}
			}
			errs = append(errs, compileError{File: main, Severity: "error", Msg: msg})
		}
		var o *string
		if output != nil {
			s := base64.StdEncoding.EncodeToString(output)
			o = &s
		}
		return map[string]any{"ok": code == 0 && output != nil && !hasError(), "errors": errs, "output": o, "outputName": outputName,
			"log": jsTrim(log), "command": core.FormatCommand(cmd, args)}, nil
	})
}

func (a *API) pack(body any) (any, error) {
	tc, err := a.toolchainOf(field(body, "toolchain"))
	if err != nil {
		return nil, err
	}
	kind := tc.Packer.Kind
	if kind == "" {
		kind = "none"
	}
	if kind == "none" {
		return nil, core.Errorf(400, "the toolchain %s packs nothing", tc.Name)
	}
	data, err := data64(field(body, "data"), "data")
	if err != nil {
		return nil, err
	}
	machine := orEmpty(field(body, "platform"))
	var at entry
	if e := field(body, "entry"); e == "basic" || e == "sys" {
		at.Word = e.(string)
	} else {
		n := jsNumber(e)
		if n != math.Trunc(n) || n < 0 || n > 0xffff || math.IsNaN(n) {
			return nil, core.Errorf(400, "'entry' is basic, sys or an address")
		}
		at.Addr = int(n)
	}
	return a.withWork("nerdsuite-pack-", func(work string) (any, error) {
		name := fileName(field(body, "name"))
		input, output := filepath.Join(work, name+".in"), filepath.Join(work, name+".out")
		if err := os.WriteFile(input, data, 0o644); err != nil {
			return nil, err
		}
		var cmd string
		var args []string
		if kind == "command" {
			words := splitCommand(tc.Packer.Command, map[string]string{"in": input, "out": output, "name": name, "platform": machine, "exec": at.at()})
			if len(words) == 0 || words[0] == "" {
				return nil, core.Errorf(400, "the packer command is empty")
			}
			cmd, args = words[0], words[1:]
		} else {
			var def *core.ToolDef
			for i := range Packers {
				if Packers[i].ID == kind {
					def = &Packers[i]
				}
			}
			if def == nil {
				return nil, core.Errorf(400, "unknown packer '%s'", kind)
			}
			if cmd = core.ResolveExe(a.env.Settings, *def); cmd == "" {
				return nil, core.Errorf(404, "%s not found (set its path in the settings, or env %s)", def.Name, def.Env)
			}
			var err error
			if args, err = packArgs(*def, machine, input, output, at, splitCommand(tc.Packer.Args, nil)); err != nil {
				return nil, err
			}
		}
		base := filepath.Base(cmd)
		code, log := execute(cmd, args, work, base)
		out, _ := os.ReadFile(output)
		command := core.FormatCommand(cmd, args)
		if code != 0 || len(out) == 0 {
			msg := lastLines(log, true)
			if msg == "" {
				msg = fmt.Sprintf("%s failed (%d)", base, code)
			}
			return map[string]any{"ok": false, "error": msg, "log": jsTrim(log), "command": command}, nil
		}
		return map[string]any{"ok": true, "output": base64.StdEncoding.EncodeToString(out), "before": len(data), "after": len(out),
			"log": jsTrim(log), "command": command}, nil
	})
}

func (a *API) stop(id string) {
	a.mu.Lock()
	cur := a.procs[id]
	delete(a.procs, id)
	a.mu.Unlock()
	if cur != nil && cur.running() {
		cur.cmd.Process.Kill() // gone: nothing to do
	}
}

func (a *API) run(body any) (any, error) {
	tc, err := a.toolchainOf(field(body, "toolchain"))
	if err != nil {
		return nil, err
	}
	if tc.Emulator.Kind != "command" || jsTrim(tc.Emulator.Command) == "" {
		return nil, core.Errorf(400, "the toolchain %s has no emulator command", tc.Name)
	}
	data, err := data64(field(body, "data"), "data")
	if err != nil {
		return nil, err
	}
	dir := filepath.Join(a.env.TmpDir, "nerdsuite-run", fileName(tc.ID))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	name := fileName(field(body, "name"))
	file := filepath.Join(dir, name+"."+extName(field(body, "ext")))
	if err := os.WriteFile(file, data, 0o644); err != nil {
		return nil, err
	}
	words := splitCommand(tc.Emulator.Command, map[string]string{"file": file, "name": name, "platform": orEmpty(field(body, "platform"))})
	if len(words) == 0 || words[0] == "" {
		return nil, core.Errorf(400, "the emulator command is empty")
	}
	cmd, args := words[0], words[1:]
	a.stop(tc.ID) // one emulator for each toolchain: a new run replaces it
	c := exec.Command(cmd, args...)
	c.Dir = dir // stdio: none; its window shows (an emulator)
	if err := c.Start(); err != nil {
		return nil, core.Errorf(500, "%s did not start: %s", cmd, startError(cmd, err))
	}
	p := &proc{cmd: c, done: make(chan struct{})}
	a.mu.Lock()
	a.procs[tc.ID] = p
	a.mu.Unlock()
	go func() {
		c.Wait()
		close(p.done)
		a.mu.Lock()
		if a.procs[tc.ID] == p {
			delete(a.procs, tc.ID)
		}
		a.mu.Unlock()
	}()
	return map[string]any{"ok": true, "file": file, "command": core.FormatCommand(cmd, args)}, nil
}

func (a *API) stopRoute(body any) (any, error) {
	if id := field(body, "toolchain"); jsTruthy(id) {
		if s, ok := id.(string); ok {
			a.stop(s)
		}
	} else {
		a.mu.Lock()
		ids := make([]string, 0, len(a.procs))
		for id := range a.procs {
			ids = append(ids, id)
		}
		a.mu.Unlock()
		for _, id := range ids {
			a.stop(id)
		}
	}
	return map[string]any{"ok": true}, nil
}

// ServeHTTP: the routes of /api/toolchain (r.URL.Path is the full path)
func (a *API) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	routes := map[string]func(any) (any, error){
		"POST /api/toolchain/compile": a.compile, "POST /api/toolchain/pack": a.pack, "POST /api/toolchain/run": a.run,
		"POST /api/toolchain/stop": a.stopRoute,
	}
	fn := routes[core.Route(r)]
	if fn == nil {
		core.WriteJSON(w, 404, map[string]any{"error": "not found"})
		return
	}
	// they start the programs of the settings: the page of this server only
	if !core.SameOrigin(r) {
		core.Fail(w, core.Errorf(403, "the toolchains run for the page of this server only"))
		return
	}
	var body any
	if err := core.ReadJSON(r, maxBody, &body); err != nil {
		core.Fail(w, err)
		return
	}
	if body == nil {
		core.Fail(w, core.Errorf(500, "Cannot read properties of null (reading 'toolchain')"))
		return
	}
	res, err := fn(body)
	if err != nil {
		core.Fail(w, err)
		return
	}
	core.WriteJSON(w, 200, res)
}

// Close: kill the emulators the run commands started
func (a *API) Close() {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, p := range a.procs {
		if p.running() {
			p.cmd.Process.Kill() // gone: nothing to do
		}
	}
}
