// Package kickass - KickAssembler (Mads Nielsen, a Java program) for the IDE: the files of the project
// go into a folder of their own, KickAss.jar assembles the main source there, and what it wrote comes
// back - the program, the errors (from -asminfo), the source line of every address (-debugdump),
// the labels (-vicesymbols), the listing (-bytedumpfile) and the memory map (-showmem).
//
//	GET  /api/kickass/status    -> { available, java, jar, version }
//	GET  /api/kickass/info      -> { libraries: [{ lib, kind, name, args }], directives: [{ name, example, desc }], ppdirectives: [...] }
//	POST /api/kickass/assemble  { main, files: { path: base64 }, defines: { NAME: true } }
//	     -> { ok, errors: [{ file, line, col, msg, severity }], output /*base64*/, outputName, start, end,
//	          symbols: [{ name, value }], lines: [{ file, line, addr, size }], viceLabels, listing, memory, log }
//
// The jar: env KICKASS (the jar or its folder), else C:\Users\<you>\applications\KickAss\KickAss.jar or
// ~/KickAss/KickAss.jar; java: env JAVA (the java executable) or JAVA_HOME, else java on the PATH.
package kickass

import (
	"bytes"
	"context"
	"encoding/base64"
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
	maxBody = 32 * 1024 * 1024
	timeout = 60 * time.Second
)

// API: the routes of /api/kickass
type API struct {
	env    core.Env
	mu     sync.Mutex // jar, java, version, info
	infoMu sync.Mutex // one -asminfo run at a time
	jar    string
	java   string
	// version: the version KickAssembler printed (nil: not known)
	version *string
	info    *kickInfo
}

// New: the API, with the jar and Java looked up
func New(env core.Env) *API {
	a := &API{env: env}
	a.Rescan()
	return a
}

// Close: nothing runs between requests
func (a *API) Close() {}

// Rescan: look the jar and Java up again (after the settings changed)
func (a *API) Rescan() {
	jar := a.findJar()
	java := ""
	if jar != "" {
		java = a.findJava()
	}
	a.mu.Lock()
	a.jar, a.java, a.info, a.version = jar, java, nil, nil
	a.mu.Unlock()
}

// Found: the programs found: the jar and Java (the settings show them); "" when not
func (a *API) Found() (jar, java string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.jar, a.java
}

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

func (a *API) findJar() string {
	env := a.env.Settings.ToolPath("KICKASS") // the settings, else the environment
	home, _ := os.UserHomeDir()
	var candidates []string
	if env != "" {
		if core.IsDir(env) {
			env = filepath.Join(env, "KickAss.jar")
		}
		candidates = append(candidates, env)
	}
	candidates = append(candidates,
		filepath.Join(core.AppsDir(), "KickAss", "KickAss.jar"),
		filepath.Join(home, "KickAss", "KickAss.jar"),
		"/opt/kickass/KickAss.jar",
	)
	for _, p := range candidates {
		if exists(p) {
			return p
		}
	}
	return ""
}

func (a *API) findJava() string {
	if p := a.env.Settings.ToolPath("JAVA"); p != "" && exists(p) {
		return p
	}
	if home := os.Getenv("JAVA_HOME"); home != "" {
		name := "java"
		if core.IsWindows {
			name = "java.exe"
		}
		if p := filepath.Join(home, "bin", name); exists(p) {
			return p
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if exec.CommandContext(ctx, "java", "-version").Run() == nil {
		return "java"
	}
	return ""
}

// syncBuffer: stdout and stderr in the order they come, and the note of the timeout between them
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
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

// run: a program, its exit code and what it wrote (-1: it did not start)
func run(cmd string, args []string, cwd string) (int, string) {
	c := exec.Command(cmd, args...)
	c.Dir = cwd
	core.HideWindow(c)
	out := &syncBuffer{}
	c.Stdout, c.Stderr = out, out
	if err := c.Start(); err != nil {
		return -1, out.String() + startError(cmd, err)
	}
	timer := time.AfterFunc(timeout, func() {
		out.Write([]byte("\nKickAssembler took too long and was stopped"))
		c.Process.Kill()
	})
	c.Wait()
	timer.Stop()
	return c.ProcessState.ExitCode(), out.String()
}

var (
	lineSplit      = regexp.MustCompile(`\r?\n`)
	sectionRe      = regexp.MustCompile(`^\[(\w+)\]$`)
	sourcesRe      = jsRe(`<Sources[^>]*>([\s\S]*?)</Sources>`)
	sourceRe       = jsRe(`^\s*(\d+),(.*)$`)
	blockRe        = jsRe(`<Block[^>]*>([\s\S]*?)</Block>`)
	rangeRe        = jsRe(`(?i)^\s*\$([0-9a-f]+),\$([0-9a-f]+),(\d+),(\d+),(\d+),(\d+),(\d+)`)
	labelsRe       = jsRe(`<Labels[^>]*>([\s\S]*?)</Labels>`)
	labelRe        = jsRe(`(?i)^\s*([^,]*),\$([0-9a-f]+),([^,]+),(\d+),(\d+)`)
	symbolRe       = jsRe(`(?im)^\s*\.(label|const|var)\s+([\w.]+)\s*=\s*(\$[0-9a-f]+|-?\d+(?:\.\d+)?)`)
	versionRe      = regexp.MustCompile(`Kick Assembler v([\d.]+)`)
	consoleRe      = regexp.MustCompile(`Error: (` + jsDot + `*)\r?\nat line (\d+), column (\d+) in (` + jsDot + `*)`)
	memoryRe       = jsRe(`Memory Map\s*-+\s*([\s\S]*?)(?:\r?\n\s*\r?\n|Writing)`)
	warnRe         = regexp.MustCompile(`(?i)warn`)
	wordRe         = regexp.MustCompile(`^\w+$`)
	driveRe        = regexp.MustCompile(`(?i)^[a-z]:`)
	extRe          = regexp.MustCompile(`\.[^.]*$`)
	splitUndefined = "Cannot read properties of undefined (reading 'split')"
)

// parseAsmInfo: the sections of an -asminfo file: { name: [lines] }
func parseAsmInfo(text string) map[string][]string {
	out := map[string][]string{}
	var cur string
	in := false
	for _, line := range lineSplit.Split(text, -1) {
		if m := sectionRe.FindStringSubmatch(line); m != nil {
			cur, in = m[1], true
			out[cur] = []string{}
			continue
		}
		if in && jsTrim(line) != "" {
			out[cur] = append(out[cur], line)
		}
	}
	return out
}

// dbgRange: the addresses of a source line
type dbgRange struct {
	Start, End      float64
	File, Line, Col float64
}

// dbgLabel: a label of the debug dump
type dbgLabel struct {
	Name       string
	Value      float64
	File, Line float64
}

// debugDump: what parseDebugDump read
type debugDump struct {
	Files  map[float64]string
	Ranges []dbgRange
	Labels []dbgLabel
}

// parseDebugDump: the -debugdump file: the files, the address ranges of their lines, the labels
func parseDebugDump(xml string) debugDump {
	d := debugDump{Files: map[float64]string{}}
	src := ""
	if m := sourcesRe.FindStringSubmatch(xml); m != nil {
		src = m[1]
	}
	for _, l := range lineSplit.Split(src, -1) {
		if m := sourceRe.FindStringSubmatch(l); m != nil {
			d.Files[numberOf(m[1])] = jsTrim(m[2])
		}
	}
	for _, block := range blockRe.FindAllStringSubmatch(xml, -1) {
		for _, l := range lineSplit.Split(block[1], -1) {
			if m := rangeRe.FindStringSubmatch(l); m != nil {
				d.Ranges = append(d.Ranges, dbgRange{Start: parseHex(m[1]), End: parseHex(m[2]), File: numberOf(m[3]), Line: numberOf(m[4]), Col: numberOf(m[5])})
			}
		}
	}
	lab := ""
	if m := labelsRe.FindStringSubmatch(xml); m != nil {
		lab = m[1]
	}
	for _, l := range lineSplit.Split(lab, -1) {
		if m := labelRe.FindStringSubmatch(l); m != nil {
			d.Labels = append(d.Labels, dbgLabel{Name: m[3], Value: parseHex(m[2]), File: numberOf(m[4]), Line: numberOf(m[5])})
		}
	}
	return d
}

// symbol: a label or a constant
type symbol struct {
	Name  string  `json:"name"`
	Value float64 `json:"value"`
	Kind  string  `json:"kind"`
}

// parseSymbols: the symbols of a .sym file: .label name=$823, .const NAME=$10 ...
func parseSymbols(text string) []symbol {
	out := []symbol{}
	for _, m := range symbolRe.FindAllStringSubmatch(text, -1) {
		var v float64
		if strings.HasPrefix(m[3], "$") {
			v = parseHex(m[3][1:])
		} else {
			v = numberOf(m[3])
		}
		if math.IsNaN(v) || math.IsInf(v, 0) {
			continue
		}
		kind := "set"
		if m[1] == "label" { // the case as written: .LABEL is a set
			kind = "label"
		}
		out = append(out, symbol{Name: m[2], Value: v, Kind: kind})
	}
	return out
}

// projectPath: a path of the project the browser sent: relative, no '..'
func projectPath(p any) (string, error) {
	path := ""
	if _, ok := p.(undefined); !ok && p != nil {
		path = strings.ReplaceAll(jsString(p), `\`, "/")
	}
	bad := path == "" || strings.HasPrefix(path, "/") || driveRe.MatchString(path)
	for _, s := range strings.Split(path, "/") {
		if s == ".." || s == "." || s == "" {
			bad = true
		}
	}
	if bad {
		return "", core.Errorf(400, "'%s' is not a path of the project", jsString(p))
	}
	return path, nil
}

// kickInfo: the version and the library of the installed KickAssembler
type kickInfo struct {
	Version      *string     `json:"version"`
	Libraries    []library   `json:"libraries"`
	Directives   []directive `json:"directives"`
	PPDirectives []directive `json:"ppdirectives"`
}

// library: a function, a constant ... of the library (a field the line does not have is left out)
type library struct {
	Lib  *string `json:"lib,omitempty"`
	Kind *string `json:"kind,omitempty"`
	Name *string `json:"name,omitempty"`
	Args any     `json:"args"`
}

// directive: .byte, #import ... with an example
type directive struct {
	Name    string  `json:"name"`
	Example *string `json:"example,omitempty"`
	Desc    string  `json:"desc"`
}

func part(parts []string, i int) *string {
	if i < len(parts) {
		return &parts[i]
	}
	return nil
}

// readInfo: the version and the library of the installed KickAssembler (an -asminfo of an empty source)
func (a *API) readInfo() (*kickInfo, error) {
	a.infoMu.Lock()
	defer a.infoMu.Unlock()
	a.mu.Lock()
	info, jar, java := a.info, a.jar, a.java
	a.mu.Unlock()
	if info != nil || jar == "" || java == "" {
		return info, nil
	}
	work, err := os.MkdirTemp(a.env.TmpDir, "kickass-info-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(work)
	if err := os.WriteFile(filepath.Join(work, "empty.asm"), []byte("\n"), 0o644); err != nil {
		return nil, err
	}
	_, out := run(java, []string{"-jar", jar, "empty.asm", "-odir", "out", "-asminfo", "all", "-asminfofile", "info.txt"}, work)
	var version *string
	if m := versionRe.FindStringSubmatch(out); m != nil {
		version = &m[1]
	}
	a.mu.Lock()
	a.version = version
	a.mu.Unlock()
	file, err := findFile(work, "info.txt")
	if err != nil {
		return nil, err
	}
	s := map[string][]string{}
	if file != "" {
		data, err := os.ReadFile(file)
		if err != nil {
			return nil, err
		}
		s = parseAsmInfo(string(data))
	}
	triples := func(lines []string) []directive {
		out := []directive{}
		for _, l := range lines {
			p := strings.Split(l, ";")
			d := directive{Name: p[0], Example: part(p, 1)}
			if len(p) > 2 {
				d.Desc = strings.Join(p[2:], ";")
			}
			out = append(out, d)
		}
		return out
	}
	info = &kickInfo{Version: version, Libraries: []library{}, Directives: triples(s["directives"]), PPDirectives: triples(s["ppdirectives"])}
	for _, l := range s["libraries"] {
		p := strings.Split(l, ";")
		lib := library{Lib: part(p, 0), Kind: part(p, 1), Name: part(p, 2)}
		if args := part(p, 3); args != nil {
			lib.Args = jsNum(numberOf(*args))
		}
		info.Libraries = append(info.Libraries, lib)
	}
	a.mu.Lock()
	a.info = info
	a.mu.Unlock()
	return info, nil
}

// findFile: KickAss writes the asminfo file relative to the output folder (or beside the source): the
// first one found
func findFile(dir, name string) (string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", err
	}
	for _, e := range entries {
		p := filepath.Join(dir, e.Name())
		if e.Type().IsRegular() && e.Name() == name {
			return p, nil
		}
		if e.IsDir() {
			f, err := findFile(p, name)
			if err != nil || f != "" {
				return f, err
			}
		}
	}
	return "", nil
}

// lineInfo: the addresses of a source line of the project
type lineInfo struct {
	File string  `json:"file"`
	Line float64 `json:"line"`
	Addr float64 `json:"addr"`
	Size float64 `json:"size"`
}

// result: the answer of an assembly
type result struct {
	OK         bool       `json:"ok"`
	Errors     []any      `json:"errors"`
	Output     *string    `json:"output"`
	OutputName string     `json:"outputName"`
	Start      any        `json:"start"`
	End        any        `json:"end"`
	Symbols    []symbol   `json:"symbols"`
	Lines      []lineInfo `json:"lines"`
	ViceLabels string     `json:"viceLabels"`
	Listing    string     `json:"listing"`
	Memory     string     `json:"memory"`
	Log        string     `json:"log"`
}

// sortedKeys: the fields of a JSON object in one order (Go's maps have none)
func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// lastLines: the last three lines of a text, one line
func lastLines(text string) string {
	lines := lineSplit.Split(jsTrim(text), -1)
	if len(lines) > 3 {
		lines = lines[len(lines)-3:]
	}
	return strings.Join(lines, " ")
}

func (a *API) assemble(body any) (any, error) {
	if body == nil {
		return nil, core.Errorf(500, "Cannot destructure property 'main' of 'object null' as it is null.")
	}
	a.mu.Lock()
	jar, java := a.jar, a.java
	a.mu.Unlock()
	if jar == "" || java == "" {
		msg := "Java not found: set JAVA or JAVA_HOME and restart the server"
		if jar == "" {
			msg = "KickAssembler not found: set KICKASS to KickAss.jar and restart the server"
		}
		return map[string]any{"ok": false, "errors": []any{map[string]any{"file": nil, "line": nil, "msg": msg}}}, nil
	}
	main, err := projectPath(field(body, "main"))
	if err != nil {
		return nil, err
	}
	files, _ := field(body, "files").(map[string]any)
	defines, _ := field(body, "defines").(map[string]any)
	work, err := os.MkdirTemp(a.env.TmpDir, "kickass-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(work)
	root := filepath.Join(work, "project")
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
	name := extRe.ReplaceAllString(main[strings.LastIndex(main, "/")+1:], "")
	out := filepath.Join(work, "out")
	if err := os.MkdirAll(out, 0o755); err != nil {
		return nil, err
	}
	src := filepath.Join(root, main)
	args := []string{"-jar", jar, src, "-odir", out, "-o", filepath.Join(out, name+".prg"), "-libdir", root,
		"-debugdump", "-vicesymbols", "-symbolfile", "-showmem", "-bytedumpfile", filepath.Join(out, name+".lst"),
		"-asminfo", "all", "-asminfofile", filepath.Join(out, "asminfo.txt")}
	for _, k := range sortedKeys(defines) {
		v := defines[k]
		if wordRe.MatchString(k) && jsTruthy(v) {
			val := jsString(v)
			if v == true {
				val = "true"
			}
			args = append(args, ":"+k+"="+val, "-define", k)
		}
	}
	code, log := run(java, args, filepath.Dir(src))
	// the paths of the work folder as paths of the project
	toProject := func(p string) *string {
		if p == "" || strings.HasPrefix(p, "KickAss.jar:") {
			return nil
		}
		abs, err := filepath.Abs(p)
		if err != nil {
			abs = p
		}
		rel, err := filepath.Rel(root, abs)
		if err != nil {
			rel = abs // another drive: Node's relative() gives the path itself
		}
		if rel == "." {
			rel = ""
		}
		if strings.HasPrefix(rel, "..") {
			return nil
		}
		s := filepath.ToSlash(rel)
		return &s
	}
	infoFile, err := findFile(work, "asminfo.txt")
	if err != nil {
		return nil, err
	}
	sections := map[string][]string{}
	if infoFile != "" {
		data, err := os.ReadFile(infoFile)
		if err != nil {
			return nil, err
		}
		sections = parseAsmInfo(string(data))
	}
	fileIdx := map[float64]*string{}
	var nanFile *string // a Map of JavaScript finds NaN, a map of Go does not
	hasNaN := false
	for _, l := range sections["files"] {
		k := strings.Index(l, ";")
		key, p := "", l
		if k >= 0 {
			key, p = l[:k], l[k+1:]
		} else if l != "" {
			key = l[:len(l)-1] // slice(0, -1)
		}
		n := numberOf(key)
		if math.IsNaN(n) {
			nanFile, hasNaN = toProject(p), true
		} else {
			fileIdx[n] = toProject(p)
		}
	}
	errs := []any{}
	hasError := func() bool {
		for _, e := range errs {
			if e.(map[string]any)["severity"] == "error" {
				return true
			}
		}
		return false
	}
	for _, l := range sections["errors"] {
		p := strings.Split(l, ";")
		if len(p) < 2 {
			return nil, core.Errorf(500, "%s", splitUndefined)
		}
		kind, msg := p[0], strings.Join(p[2:], ";")
		pos := strings.Split(p[1], ",")
		e := map[string]any{"file": main, "msg": msg, "severity": "error"}
		if warnRe.MatchString(kind) {
			e["severity"] = "warning"
		}
		if len(pos) > 0 {
			e["line"] = jsNum(numberOf(pos[0]))
		}
		if len(pos) > 1 {
			e["col"] = jsNum(numberOf(pos[1]))
		}
		if len(pos) > 4 {
			fi := numberOf(pos[4])
			var f *string
			if math.IsNaN(fi) {
				if hasNaN {
					f = nanFile
				}
			} else {
				f = fileIdx[fi]
			}
			if f != nil {
				e["file"] = *f
			}
		}
		errs = append(errs, e)
	}
	// an error the info file does not hold (a crash, a missing file): the text of the console
	if code != 0 && !hasError() {
		if m := consoleRe.FindStringSubmatch(log); m != nil {
			file := main
			if f := toProject(filepath.Join(filepath.Dir(src), jsTrim(m[4]))); f != nil {
				file = *f
			}
			errs = append(errs, map[string]any{"file": file, "line": numberOf(m[2]), "col": numberOf(m[3]), "msg": m[1], "severity": "error"})
		} else {
			msg := lastLines(log)
			if msg == "" {
				msg = "KickAssembler failed"
			}
			errs = append(errs, map[string]any{"file": main, "line": nil, "msg": msg, "severity": "error"})
		}
	}
	read := func(f string) []byte {
		data, err := os.ReadFile(filepath.Join(out, f))
		if err != nil {
			return nil
		}
		if data == nil {
			data = []byte{} // an empty file is a file: Node's Buffer of it is there
		}
		return data
	}
	readText := func(f string) string { return string(read(f)) }
	var prg []byte
	if code == 0 {
		prg = read(name + ".prg")
	}
	dbg := debugDump{Files: map[float64]string{}}
	if t := readText(name + ".dbg"); t != "" {
		dbg = parseDebugDump(t)
	}
	dbgFiles := map[float64]*string{}
	for k, p := range dbg.Files {
		dbgFiles[k] = toProject(p)
	}
	lines := []lineInfo{}
	for _, x := range dbg.Ranges {
		if f := dbgFiles[x.File]; f != nil && *f != "" {
			lines = append(lines, lineInfo{File: *f, Line: x.Line, Addr: x.Start, Size: x.End - x.Start + 1})
		}
	}
	symbols := []symbol{}
	if t := readText(name + ".sym"); t != "" {
		symbols = parseSymbols(t)
	} else {
		for _, l := range dbg.Labels {
			symbols = append(symbols, symbol{Name: l.Name, Value: l.Value, Kind: "label"})
		}
	}
	r := &result{OK: code == 0 && prg != nil && !hasError(), Errors: errs, OutputName: name + ".prg", Symbols: symbols, Lines: lines,
		ViceLabels: readText(name + ".vs"), Listing: readText(name + ".lst"), Log: jsTrim(log)}
	if prg != nil {
		s := base64.StdEncoding.EncodeToString(prg)
		r.Output = &s
		if len(prg) >= 2 {
			start := int(prg[0]) | int(prg[1])<<8
			r.Start, r.End = start, start+len(prg)-2
		}
	}
	if m := memoryRe.FindStringSubmatch(log); m != nil {
		r.Memory = jsTrim(m[1])
	}
	return r, nil
}

// ServeHTTP: the routes of /api/kickass (r.URL.Path is the full path)
func (a *API) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.Method + " " + r.URL.Path {
	case "GET /api/kickass/status":
		a.mu.Lock()
		ready := a.jar != "" && a.java != "" && a.version == nil
		a.mu.Unlock()
		if ready {
			a.readInfo() // an error: the status says what is known
		}
		a.mu.Lock()
		var jar, java any
		if a.jar != "" {
			jar = a.jar
		}
		if a.java != "" {
			java = a.java
		}
		body := map[string]any{"available": a.jar != "" && a.java != "", "jar": jar, "java": java, "version": a.version}
		a.mu.Unlock()
		core.WriteJSON(w, 200, body)
	case "GET /api/kickass/info":
		i, err := a.readInfo()
		if err != nil {
			core.Fail(w, err)
		} else if i == nil {
			core.WriteJSON(w, 409, map[string]any{"error": "KickAssembler is not available"})
		} else {
			core.WriteJSON(w, 200, i)
		}
	case "POST /api/kickass/assemble":
		var body any
		if err := core.ReadJSON(r, maxBody, &body); err != nil {
			core.Fail(w, err)
			return
		}
		res, err := a.assemble(body)
		if err != nil {
			core.Fail(w, err)
			return
		}
		core.WriteJSON(w, 200, res)
	default:
		core.WriteJSON(w, 404, map[string]any{"error": "not found"})
	}
}
