// The toolchains: the command lines, the arguments of the packers, the errors of the compilers, a
// real Exomizer (when this machine has one) and the routes
package toolchain

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"nerdsuite/backend/core"
)

func packer(id string) core.ToolDef {
	for _, p := range Packers {
		if p.ID == id {
			return p
		}
	}
	panic(id)
}

func TestSplitCommand(t *testing.T) {
	// quoted words stay one, placeholders filled in after the split
	got := splitCommand("64tass --cbm-prg -o {out} {main}", map[string]string{"out": `C:\my dir\a.prg`, "main": "src/main.asm"})
	if want := []string{"64tass", "--cbm-prg", "-o", `C:\my dir\a.prg`, "src/main.asm"}; !reflect.DeepEqual(got, want) {
		t.Errorf("got %q", got)
	}
	got = splitCommand(`"C:\Program Files\x\tool.exe" -o={out} {unknown}`, map[string]string{"out": "o.prg"})
	if want := []string{`C:\Program Files\x\tool.exe`, "-o=o.prg", "{unknown}"}; !reflect.DeepEqual(got, want) {
		t.Errorf("got %q", got)
	}
	if got := splitCommand("", nil); len(got) != 0 {
		t.Errorf("got %q", got)
	}
	if got := splitCommand(`a "say \"hi\"" ""`, nil); !reflect.DeepEqual(got, []string{"a", `say "hi"`, ""}) {
		t.Errorf("got %q", got)
	}
}

func TestPackArgs(t *testing.T) {
	ok := func(id, machine string, at entry, extra []string, want []string) {
		t.Helper()
		got, err := packArgs(packer(id), machine, "i", "o", at, extra)
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Errorf("%s %s: %q %v", id, machine, got, err)
		}
	}
	ok("exomizer", "c64", entry{Word: "sys"}, nil, []string{"sfx", "sys", "-t64", "-o", "o", "i"})
	ok("exomizer", "vic20", entry{Addr: 0x1010}, []string{"-n"}, []string{"sfx", "0x1010", "-t20", "-n", "-o", "o", "i"})
	ok("exomizer", "atari8", entry{Addr: 0x2000}, nil, []string{"sfx", "0x2000", "-t168", "-o", "o", "i"})
	ok("pucrunch", "c64", entry{Addr: 0x0810}, nil, []string{"-c64", "-x0x0810", "i", "o"})
	ok("pucrunch", "plus4", entry{Word: "sys"}, nil, []string{"-c16", "i", "o"})
	ok("dali", "c64", entry{Addr: 0x0810}, nil, []string{"--sfx", "0x0810", "-o", "o", "i"})
	bad := func(id, machine string, at entry, msg string) {
		t.Helper()
		_, err := packArgs(packer(id), machine, "i", "o", at, nil)
		if err == nil || !strings.Contains(err.Error(), msg) || core.StatusOf(err) != 400 {
			t.Errorf("%s %s: %v", id, machine, err)
		}
	}
	bad("dali", "vic20", entry{Addr: 0x1010}, "does not pack")
	bad("pucrunch", "c64", entry{Word: "basic"}, "Exomizer packs BASIC")
	bad("exomizer", "cpc6128", entry{Addr: 0x4000}, "does not pack")
}

func num(f float64) *float64 { return &f }

func TestParseErrors(t *testing.T) {
	// the formats of 64tass, cc65, oscar64 and dasm
	log := strings.Join([]string{
		`src/main.asm:3:9: error: not defined symbol 'foo'`,
		`src/main.asm:7:1: warning: unused label`,
		`src/main.c(12): Error: Undefined symbol: 'x'`,
		`C:/work/project/src/game.c(5, 14) : error 3001: Could not open source file`,
		`Compiling done`,
	}, "\n")
	root := "C:/work/project/"
	got := parseErrors(log, func(p string) string { return strings.Replace(strings.ReplaceAll(p, `\`, "/"), root, "", 1) })
	want := []compileError{
		{File: "src/main.asm", Line: num(3), Col: num(9), Msg: "not defined symbol 'foo'", Severity: "error"},
		{File: "src/main.asm", Line: num(7), Col: num(1), Msg: "unused label", Severity: "warning"},
		{File: "src/main.c", Line: num(12), Col: nil, Msg: "Undefined symbol: 'x'", Severity: "error"},
		{File: "src/game.c", Line: num(5), Col: num(14), Msg: "Could not open source file", Severity: "error"},
	}
	if !reflect.DeepEqual(got, want) {
		a, _ := json.Marshal(got)
		t.Errorf("got %s", a)
	}
}

func TestFileName(t *testing.T) {
	for in, want := range map[any]string{"dir/my game.prg": "my_game", `a\b.c`: "b", "": "program", nil: "program", ".x": "program", "a.b.c": "a.b"} {
		if got := fileName(in); got != want {
			t.Errorf("%v: %q", in, got)
		}
	}
	if extName("d64") != "d64" || extName("toolongext") != "prg" || extName(undefined{}) != "prg" || extName(float64(64)) != "64" {
		t.Error("extName")
	}
}

// exomizer: a real Exomizer, when this machine has one
func exomizer() string {
	p := filepath.Join(core.AppsDir(), "C64-Kickass-IDE", "tools", "exomizer.exe")
	if core.IsFile(p) {
		return p
	}
	return ""
}

// a C64 program: 10 SYS2064, then lda #0 / sta $d020 / rts and 2000 bytes of zeros
func program() []byte {
	return append([]byte{0x01, 0x08, 0x0c, 0x08, 0x0a, 0x00, 0x9e, 0x32, 0x30, 0x36, 0x34, 0, 0, 0, 0, 0, 0xa9, 0, 0x8d, 0x20, 0xd0, 0x60}, make([]byte, 2000)...)
}

func TestExomizerPacks(t *testing.T) {
	exo := exomizer()
	if exo == "" {
		t.Skip("no exomizer here")
	}
	// a C64 program packs and keeps its BASIC start
	dir := t.TempDir()
	prg := program()
	os.WriteFile(filepath.Join(dir, "in.prg"), prg, 0o644)
	args, err := packArgs(packer("exomizer"), "c64", filepath.Join(dir, "in.prg"), filepath.Join(dir, "out.prg"), entry{Word: "sys"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command(exo, args...).CombinedOutput(); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	out, _ := os.ReadFile(filepath.Join(dir, "out.prg"))
	if len(out) < 2 || int(out[0])|int(out[1])<<8 != 0x0801 || len(out) >= len(prg)/4 {
		t.Errorf("%d bytes", len(out))
	}
}

// newAPI: the API with settings of its own (toolchains: theirs)
func newAPI(t *testing.T, paths map[string]string, toolchains ...core.Toolchain) (*API, string) {
	tmp := t.TempDir()
	st := core.NewSettings(filepath.Join(tmp, "settings.json"))
	if err := st.Save(core.SettingsData{Paths: paths, Toolchains: toolchains}); err != nil {
		t.Fatal(err)
	}
	api := New(core.Env{Settings: st, TmpDir: tmp})
	t.Cleanup(api.Close)
	return api, tmp
}

func call(t *testing.T, api *API, path string, body any, sameOrigin bool) (int, map[string]any) {
	t.Helper()
	data, _ := json.Marshal(body)
	req := httptest.NewRequest("POST", path, bytes.NewReader(data))
	if sameOrigin {
		req.Header.Set("Content-Type", "application/json")
	} else {
		req.Header.Set("Content-Type", "text/plain")
	}
	rec := httptest.NewRecorder()
	api.ServeHTTP(rec, req)
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("%s: no JSON: %s", path, rec.Body.String())
	}
	return rec.Code, out
}

func TestRoutes(t *testing.T) {
	api, _ := newAPI(t, nil, core.Toolchain{ID: "tc1", Name: "Mine", Packer: core.Step{Kind: "none"}})
	if code, r := call(t, api, "/api/toolchain/nothing", map[string]any{}, true); code != 404 || r["error"] != "not found" {
		t.Errorf("404: %d %v", code, r)
	}
	if code, r := call(t, api, "/api/toolchain/stop", map[string]any{}, false); code != 403 || r["error"] != "the toolchains run for the page of this server only" {
		t.Errorf("403: %d %v", code, r)
	}
	if code, r := call(t, api, "/api/toolchain/stop/", map[string]any{}, true); code != 200 || r["ok"] != true {
		t.Errorf("stop: %d %v", code, r)
	}
	if code, r := call(t, api, "/api/toolchain/compile", map[string]any{"toolchain": "x"}, true); code != 404 || r["error"] != "there is no toolchain 'x' (the Settings set them up)" {
		t.Errorf("no toolchain: %d %v", code, r)
	}
	if code, r := call(t, api, "/api/toolchain/compile", map[string]any{}, true); code != 404 || r["error"] != "there is no toolchain 'undefined' (the Settings set them up)" {
		t.Errorf("undefined: %d %v", code, r)
	}
	if code, r := call(t, api, "/api/toolchain/compile", map[string]any{"toolchain": "tc1"}, true); code != 400 || r["error"] != "the toolchain Mine has no compiler command" {
		t.Errorf("no compiler: %d %v", code, r)
	}
	if code, r := call(t, api, "/api/toolchain/pack", map[string]any{"toolchain": "tc1"}, true); code != 400 || r["error"] != "the toolchain Mine packs nothing" {
		t.Errorf("packs nothing: %d %v", code, r)
	}
	if code, r := call(t, api, "/api/toolchain/run", map[string]any{"toolchain": "tc1"}, true); code != 400 || r["error"] != "the toolchain Mine has no emulator command" {
		t.Errorf("no emulator: %d %v", code, r)
	}
	if code, r := call(t, api, "/api/toolchain/stop", nil, true); code != 500 {
		t.Errorf("null: %d %v", code, r)
	}
}

func TestPackRoute(t *testing.T) {
	exo := exomizer()
	if exo == "" {
		t.Skip("no exomizer here")
	}
	api, tmp := newAPI(t, map[string]string{"EXOMIZER": exo}, core.Toolchain{ID: "tc1", Name: "Packed", Packer: core.Step{Kind: "exomizer"}})
	b64 := base64.StdEncoding.EncodeToString(program())
	code, r := call(t, api, "/api/toolchain/pack", map[string]any{"toolchain": "tc1", "platform": "c64", "name": "game.prg", "data": b64, "entry": "sys"}, true)
	if code != 200 || r["ok"] != true || r["before"] != float64(len(program())) {
		t.Fatalf("%d %v", code, r)
	}
	out, _ := base64.StdEncoding.DecodeString(r["output"].(string))
	if len(out) < 2 || int(out[0])|int(out[1])<<8 != 0x0801 || r["after"] != float64(len(out)) {
		t.Errorf("output: %d bytes, %v", len(out), r["after"])
	}
	if !strings.Contains(r["command"].(string), "sfx sys -t64 -o") {
		t.Errorf("command: %v", r["command"])
	}
	code, r = call(t, api, "/api/toolchain/pack", map[string]any{"toolchain": "tc1", "platform": "c64", "data": b64, "entry": "0x10000"}, true)
	if code != 400 || r["error"] != "'entry' is basic, sys or an address" {
		t.Errorf("entry: %d %v", code, r)
	}
	code, r = call(t, api, "/api/toolchain/pack", map[string]any{"toolchain": "tc1", "platform": "c64", "data": ""}, true)
	if code != 400 || r["error"] != "'data' is empty" {
		t.Errorf("data: %d %v", code, r)
	}
	// the work folders are gone
	if left, _ := filepath.Glob(filepath.Join(tmp, "nerdsuite-pack-*")); len(left) != 0 {
		t.Errorf("left behind: %v", left)
	}
}

func TestCompileRoute(t *testing.T) {
	// a compiler: the exomizer again (it is one program this machine has), writing {out} from {main}
	exo := exomizer()
	if exo == "" {
		t.Skip("no exomizer here")
	}
	api, tmp := newAPI(t, nil, core.Toolchain{ID: "tc1", Name: "Raw", Compiler: core.Step{Kind: "command", Command: `"` + exo + `" raw -o {out} {main}`}})
	files := map[string]any{"src/main.prg": base64.StdEncoding.EncodeToString(program())}
	code, r := call(t, api, "/api/toolchain/compile", map[string]any{"toolchain": "tc1", "main": "src/main.prg", "files": files, "platform": "c64", "ext": "bin"}, true)
	if code != 200 || r["ok"] != true || r["outputName"] != "main.bin" || r["output"] == nil {
		t.Fatalf("%d %v", code, r)
	}
	code, r = call(t, api, "/api/toolchain/compile", map[string]any{"toolchain": "tc1", "main": "src/none.prg", "files": files}, true)
	if code != 200 || r["ok"] != false || r["output"] != nil || len(r["errors"].([]any)) == 0 {
		t.Errorf("a missing source: %d %v", code, r)
	}
	if code, r := call(t, api, "/api/toolchain/compile", map[string]any{"toolchain": "tc1", "main": "../x"}, true); code != 400 || r["error"] != "'../x' is not a path of the project" {
		t.Errorf("path: %d %v", code, r)
	}
	if left, _ := filepath.Glob(filepath.Join(tmp, "nerdsuite-cc-*")); len(left) != 0 {
		t.Errorf("left behind: %v", left)
	}
}

// TestSleeper: the emulator of TestRunStop - this test program again, waiting to be stopped
func TestSleeper(t *testing.T) {
	if os.Getenv("NERDSUITE_SLEEPER") == "" {
		t.Skip("the emulator of TestRunStop")
	}
	time.Sleep(time.Minute)
}

func TestRunStop(t *testing.T) {
	t.Setenv("NERDSUITE_SLEEPER", "1")
	exe, _ := os.Executable()
	api, tmp := newAPI(t, nil, core.Toolchain{ID: "tc1", Name: "Run", Emulator: core.Step{Kind: "command", Command: `"` + exe + `" -test.run=^TestSleeper$ {platform}`}})
	running := func() *proc {
		api.mu.Lock()
		defer api.mu.Unlock()
		return api.procs["tc1"]
	}
	b64 := base64.StdEncoding.EncodeToString([]byte{1, 8, 0})
	code, r := call(t, api, "/api/toolchain/run", map[string]any{"toolchain": "tc1", "platform": "c64", "name": "my game", "data": b64, "ext": "d64"}, true)
	want := filepath.Join(tmp, "nerdsuite-run", "tc1", "my_game.d64")
	if code != 200 || r["ok"] != true || r["file"] != want || !strings.HasSuffix(r["command"].(string), "-test.run=^TestSleeper$ c64") {
		t.Fatalf("%d %v", code, r)
	}
	if data, _ := os.ReadFile(want); !bytes.Equal(data, []byte{1, 8, 0}) {
		t.Errorf("the program: % x", data)
	}
	first := running()
	if first == nil || !first.running() {
		t.Fatal("no emulator")
	}
	// a new run replaces it
	call(t, api, "/api/toolchain/run", map[string]any{"toolchain": "tc1", "data": b64}, true)
	select {
	case <-first.done:
	case <-time.After(10 * time.Second):
		t.Error("the first emulator still runs")
	}
	second := running()
	if second == nil || second == first {
		t.Fatal("no second emulator")
	}
	if code, r := call(t, api, "/api/toolchain/stop", map[string]any{}, true); code != 200 || r["ok"] != true {
		t.Errorf("stop: %d %v", code, r)
	}
	select {
	case <-second.done:
	case <-time.After(10 * time.Second):
		t.Error("the emulator still runs")
	}
	if running() != nil {
		t.Error("still known")
	}
}
