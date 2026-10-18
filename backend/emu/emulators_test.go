package emu

// The tests of test/emulators.test.js: the launch plans (pure), the names, the command line, the
// status and the checks of a run - no emulator needs to be installed.

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"nerdsuite/backend/core"
)

var (
	ctxTmp = filepath.Join("T:", "tmp")
	ctxExe = filepath.Join("E:", "emu", "emu.exe")
)

func mustPlan(t *testing.T, r runRequest) plan {
	t.Helper()
	p, err := planRun(r, ctxTmp, ctxExe)
	if err != nil {
		t.Fatalf("%s/%s: %v", r.Platform, r.Emulator, err)
	}
	return p
}

func planFails(t *testing.T, r runRequest, pattern string) {
	t.Helper()
	_, err := planRun(r, ctxTmp, ctxExe)
	if err == nil || !regexp.MustCompile(pattern).MatchString(err.Error()) {
		t.Errorf("%s/%s: want an error /%s/, got %v", r.Platform, r.Emulator, pattern, err)
	}
}

func eq(t *testing.T, what string, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("%s: got %#v, want %#v", what, got, want)
	}
}

func matches(t *testing.T, what, s, pattern string) {
	t.Helper()
	if !regexp.MustCompile(pattern).MatchString(s) {
		t.Errorf("%s: %q does not match /%s/", what, s, pattern)
	}
}

func TestDosStemToAtascii(t *testing.T) {
	eq(t, "my-game.xex", dosStem("my-game.xex"), "MYGAME")
	eq(t, "123abc", dosStem("123abc"), "ABC")
	eq(t, "empty", dosStem(""), "PROGRAM")
	want := append(append(append([]byte("10 ?1"), 0x9b), []byte("20 END")...), 0x9b)
	eq(t, "line ends", toAtascii([]byte("10 ?1\r\n20 END\n")), want)
	eq(t, "EOL kept", toAtascii([]byte{0x41, 0x9b}), []byte{0x41, 0x9b})
}

func TestAltirraPlans(t *testing.T) {
	// altirra xex and listing plans
	x := mustPlan(t, runRequest{Platform: "atari", Emulator: "altirra", Name: "demo", Data: []byte{0xff, 0xff}, Format: "xex"})
	eq(t, "xex args", x.Args, []string{"/nosingleinstance", "/run", x.File})
	matches(t, "xex file", x.File, `DEMO\.XEX$`)
	l := mustPlan(t, runRequest{Platform: "atari", Emulator: "altirra", Name: "demo", Data: []byte("10 ?1\n"), Format: "atascii-lst"})
	eq(t, "listing args", l.Args[:3], []string{"/nosingleinstance", "/basic", "/hdpath"})
	eq(t, "listing /type", l.Args[4], "/type")
	eq(t, "listing typed", l.Args[5], `ENTER "H:DEMO.LST"~RUN~`)
	d := l.Files[0].Data
	eq(t, "listing EOL", d[len(d)-1], byte(0x9b))
	a8 := mustPlan(t, runRequest{Platform: "atari", Emulator: "atari800", Name: "demo", Data: []byte{1}, Format: "xex"})
	eq(t, "atari800 args", a8.Args, []string{"-run", a8.File})
}

func TestCpcPlans(t *testing.T) {
	// cpc plans build a DSK and autorun
	w := mustPlan(t, runRequest{Platform: "cpc", Emulator: "winape", Name: "hello", Data: []byte("10 PRINT 1"), Format: "cpc-ascii"})
	matches(t, "winape file", w.File, `HELLO\.DSK$`)
	eq(t, "winape args", w.Args, []string{w.File, "/A:HELLO"})
	eq(t, "dsk signature", string(w.Files[0].Data[:8]), "EXTENDED")
	c := mustPlan(t, runRequest{Platform: "cpc", Emulator: "caprice", Name: "hello", Data: []byte{0xc9}, Format: "amsdos-bin", Load: intp(0x4000)})
	eq(t, "caprice args", c.Args, []string{"-a", `run"HELLO`, c.File})
	m := mustPlan(t, runRequest{Platform: "cpc", Emulator: "mame", Name: "hello", Data: []byte{0xc9}, Format: "amsdos-bin", Load: intp(0x4000), Machine: "464"})
	eq(t, "mame machine", m.Args[0], "cpc464")
	planFails(t, runRequest{Platform: "cpc", Emulator: "winape", Name: "x", Data: []byte{1}, Format: "xex"}, `unsupported`)
}

func TestVcsPlans(t *testing.T) {
	s := mustPlan(t, runRequest{Platform: "vcs", Emulator: "stella", Name: "game", Data: make([]byte, 4096), Format: "a26"})
	eq(t, "stella args", s.Args, []string{s.File})
	matches(t, "stella file", s.File, `GAME\.a26$`)
	m := mustPlan(t, runRequest{Platform: "vcs", Emulator: "mame", Name: "game", Data: make([]byte, 4096), Format: "a26"})
	eq(t, "mame args", m.Args[:2], []string{"a2600", "-cart"})
}

func TestNesSnesPlans(t *testing.T) {
	nes := append([]byte{0x4e, 0x45, 0x53, 0x1a, 1, 1, 1, 0}, make([]byte, 8+0x6000)...)
	s := mustPlan(t, runRequest{Platform: "nes", Emulator: "mesen", Name: "game", Data: nes, Format: "nes"})
	eq(t, "mesen args", s.Args, []string{s.File})
	matches(t, "mesen file", s.File, `GAME\.nes$`)
	eq(t, "mame nes args", mustPlan(t, runRequest{Platform: "nes", Emulator: "mame", Name: "game", Data: nes, Format: "nes"}).Args[:2], []string{"nes", "-cart"})
	planFails(t, runRequest{Platform: "nes", Emulator: "fceux", Name: "x", Data: make([]byte, 64), Format: "nes"}, `iNES`)
	f := mustPlan(t, runRequest{Platform: "snes", Emulator: "bsnes", Name: "game", Data: make([]byte, 0x8000), Format: "sfc"})
	matches(t, "bsnes file", f.File, `GAME\.sfc$`)
	eq(t, "mame snes args", mustPlan(t, runRequest{Platform: "snes", Emulator: "mame", Name: "game", Data: make([]byte, 0x8000), Format: "sfc"}).Args[:2], []string{"snes", "-cart"})
	planFails(t, runRequest{Platform: "snes", Emulator: "snes9x", Name: "x", Data: make([]byte, 100), Format: "sfc"}, `32K`)
}

func TestFormatCommandQuotes(t *testing.T) {
	eq(t, "command", core.FormatCommand("a b.exe", []string{"/x", `ENTER "H:A"~`}), `"a b.exe" /x "ENTER \"H:A\"~"`)
}

func newTestAPI(t *testing.T) *API {
	t.Helper()
	dir := t.TempDir()
	return New(core.Env{Settings: core.NewSettings(filepath.Join(dir, "settings.json")), TmpDir: filepath.Join(dir, "tmp-unused")})
}

func TestStatusAndRunChecks(t *testing.T) {
	// status lists every emulator/platform pair; run validates input
	api := newTestAPI(t)
	defer api.Close()
	ids := map[string]bool{}
	for _, e := range api.status().Emulators {
		ids[e.ID+"/"+e.Platform] = true
		if e.Available != (e.Exe != nil) {
			t.Errorf("%s/%s: available %v, exe %v", e.ID, e.Platform, e.Available, e.Exe)
		}
	}
	for _, id := range []string{"altirra/atari", "atari800/atari", "winape/cpc", "caprice/cpc", "mame/cpc", "stella/vcs", "mame/vcs", "mesen/nes", "fceux/nes", "mesen/snes", "bsnes/snes", "snes9x/snes"} {
		if !ids[id] {
			t.Errorf("status lacks %s", id)
		}
	}
	for _, c := range []struct {
		body    map[string]any
		pattern string
	}{
		{map[string]any{"platform": "zx", "format": "tap", "data": "AA=="}, `unknown platform`},
		{map[string]any{"platform": "atari", "format": "tap", "data": "AA=="}, `format must be`},
		{map[string]any{"platform": "atari", "format": "xex", "data": ""}, `empty`},
		{map[string]any{"platform": "cpc", "emulator": "stella", "format": "cpc-ascii", "data": "AA=="}, `does not support`},
	} {
		_, err := api.run(c.body)
		if err == nil || !regexp.MustCompile(c.pattern).MatchString(err.Error()) || core.StatusOf(err) != 400 {
			t.Errorf("%v: want a 400 /%s/, got %v", c.body, c.pattern, err)
		}
	}
}

func TestEmulatorDefinitions(t *testing.T) {
	var order []string
	for _, d := range Emulators {
		order = append(order, d.ID)
		if d.Name != strings.ToUpper(d.ID[:1])+d.ID[1:] {
			t.Errorf("%s: name %q", d.ID, d.Name)
		}
	}
	eq(t, "order", order, []string{"altirra", "atari800", "winape", "caprice", "stella", "mesen", "fceux", "nestopia", "bsnes", "snes9x", "mame"})
	var platforms []string
	for _, p := range Preferred {
		platforms = append(platforms, p.ID)
	}
	eq(t, "platforms", platforms, []string{"atari", "cpc", "vcs", "nes", "snes"})
}

func TestHTTPRoutes(t *testing.T) {
	api := newTestAPI(t)
	defer api.Close()
	do := func(method, path, body string) (int, map[string]any) {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		rec := httptest.NewRecorder()
		api.ServeHTTP(rec, req)
		var v map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
			t.Fatalf("%s %s: %v %q", method, path, err, rec.Body.String())
		}
		return rec.Code, v
	}
	if code, v := do("GET", "/api/emu/status/", ""); code != 200 || v["emulators"] == nil {
		t.Errorf("status: %d %v", code, v)
	}
	if code, v := do("GET", "/api/emu/nothing", ""); code != 404 || v["error"] != "no route GET /api/emu/nothing" {
		t.Errorf("unknown route: %d %v", code, v)
	}
	if code, v := do("POST", "/api/emu/run", "{"); code != 400 || v["error"] != "invalid JSON body" {
		t.Errorf("bad JSON: %d %v", code, v)
	}
	if code, v := do("POST", "/api/emu/run", `{"platform":"zx"}`); code != 400 || v["error"] != "unknown platform 'zx' (one of atari, cpc, vcs, nes, snes)" {
		t.Errorf("unknown platform: %d %v", code, v)
	}
	if code, v := do("POST", "/api/emu/run", `{"platform":"atari","format":"xex","data":5}`); code != 400 || v["error"] != "'data' must be a base64 string" {
		t.Errorf("no data: %d %v", code, v)
	}
	if code, v := do("POST", "/api/emu/stop", ""); code != 200 || v["ok"] != true {
		t.Errorf("stop: %d %v", code, v)
	}
}

func TestDecodeBase64LikeNode(t *testing.T) {
	for in, want := range map[string][]byte{
		"AA==": {0}, "AA": {0}, "/w==": {0xff}, "_w": {0xff}, "QU JD\n": []byte("ABC"), "": nil, "A": nil,
	} {
		if got := decodeBase64(in); !bytes.Equal(got, want) {
			t.Errorf("%q: % x, want % x", in, got, want)
		}
	}
}

func TestJSValues(t *testing.T) {
	body := map[string]any{"n": 5.0, "z": nil, "b": true}
	eq(t, "missing", jsString(body, "x"), "undefined")
	eq(t, "null", jsString(body, "z"), "null")
	eq(t, "number", jsString(body, "n"), "5")
	eq(t, "bool", jsString(body, "b"), "true")
	eq(t, "1e21", jsNumber(1e21), "1e+21")
	eq(t, "1e-7", jsNumber(1e-7), "1e-7")
	if jsInteger(1.5) != nil || jsInteger("1") != nil || *jsInteger(16384.0) != 16384 {
		t.Errorf("jsInteger")
	}
}
