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

func TestAmigaPlans(t *testing.T) {
	w := mustPlan(t, runRequest{Platform: "amiga", Emulator: "winuae", Name: "demo", Data: make([]byte, 901120), Format: "adf"})
	eq(t, "winuae args", w.Args, []string{"-s", "use_gui=no", "-s", "floppy0=" + w.File})
	matches(t, "winuae file", w.File, `DEMO\.adf$`)
	f := mustPlan(t, runRequest{Platform: "amiga", Emulator: "fsuae", Name: "demo", Data: make([]byte, 901120), Format: "adf"})
	eq(t, "fs-uae args", f.Args, []string{"--amiga_model=A500", "--floppy_drive_0=" + f.File})
	planFails(t, runRequest{Platform: "amiga", Emulator: "winuae", Name: "x", Data: make([]byte, 1024), Format: "adf"}, `901120`)
	planFails(t, runRequest{Platform: "amiga", Emulator: "fsuae", Name: "x", Data: make([]byte, 901120), Format: "prg"}, `unsupported`)
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

func TestZx81Trs80Plans(t *testing.T) {
	p := mustPlan(t, runRequest{Platform: "zx81", Emulator: "eightyone", Name: "demo", Data: make([]byte, 200), Format: "zx81-p"})
	matches(t, "eightyone file", p.File, `demo\.p$`)
	eq(t, "eightyone args", p.Args, []string{p.File})
	z := mustPlan(t, runRequest{Platform: "zx81", Emulator: "zesarux", Name: "demo", Data: make([]byte, 200), Format: "zx81-p"})
	eq(t, "zesarux args", z.Args, []string{"--machine", "ZX81", z.File})
	planFails(t, runRequest{Platform: "zx81", Emulator: "eightyone", Name: "x", Data: []byte{1}, Format: "zx81-p"}, `no \.p file`)
	g := mustPlan(t, runRequest{Platform: "trs80", Emulator: "trs80gp", Name: "demo", Data: []byte{2, 2, 0, 0x70}, Format: "trs80-cmd", Machine: "3"})
	eq(t, "trs80gp args", g.Args, []string{"-m3", g.File})
	matches(t, "trs80gp file", g.File, `DEMO\.CMD$`)
	b := mustPlan(t, runRequest{Platform: "trs80", Emulator: "trs80gp", Name: "demo", Data: []byte("10 CLS\r"), Format: "trs80-ascii"})
	eq(t, "trs80gp listing", b.Args, []string{"-m1", b.File})
	m := mustPlan(t, runRequest{Platform: "trs80", Emulator: "mame", Name: "demo", Data: []byte{2, 2, 0, 0x70}, Format: "trs80-cmd"})
	eq(t, "mame trs80", m.Args[:3], []string{"trs80l2", "-quik", m.File})
	planFails(t, runRequest{Platform: "trs80", Emulator: "mame", Name: "x", Data: []byte("10 CLS"), Format: "trs80-ascii"}, `trs80gp`)
}

func TestBbcPlansAndSsd(t *testing.T) {
	p := mustPlan(t, runRequest{Platform: "bbc", Emulator: "b2", Name: "my-demo", Data: []byte{0x60}, Format: "bbc-bin", Load: intp(0x2000), Exec: intp(0x2001)})
	eq(t, "b2 args", p.Args, []string{"-0", p.File, "-b"})
	ssd := p.Files[0].Data
	eq(t, "size", len(ssd), 400*256)
	cat0, cat1 := ssd[0:256], ssd[256:512]
	eq(t, "title", string(cat0[0:8]), "MYDEMO  ")
	eq(t, "entries", cat1[5], byte(16))
	eq(t, "boot option, sectors", []byte{cat1[6], cat1[7]}, []byte{0x31, 0x90})
	// the last file first: MYDEMO at sector 3, !BOOT at sector 2
	eq(t, "names", string(cat0[8:24]), "MYDEMO $!BOOT  $")
	eq(t, "MYDEMO", cat1[8:16], []byte{0x00, 0x20, 0x01, 0x20, 1, 0, 0xcc, 3})
	eq(t, "!BOOT", cat1[16:24], []byte{0, 0, 0, 0, 12, 0, 0, 2})
	eq(t, "!BOOT text", string(ssd[512:524]), "*RUN MYDEMO\r")
	eq(t, "code", ssd[768], byte(0x60))
	l := mustPlan(t, runRequest{Platform: "bbc", Emulator: "beebem", Name: "demo", Data: []byte("10 PRINT 1\n"), Format: "bbc-ascii"})
	eq(t, "beebem args", l.Args, []string{l.File})
	eq(t, "listing in !BOOT", string(l.Files[0].Data[512:527]), "10 PRINT 1\rRUN\r")
	m := mustPlan(t, runRequest{Platform: "bbc", Emulator: "mame", Name: "demo", Data: []byte("10 PRINT 1"), Format: "bbc-ascii"})
	eq(t, "mame bbc", m.Args[:3], []string{"bbcb", "-flop1", m.File})
	planFails(t, runRequest{Platform: "bbc", Emulator: "beebem", Name: "x", Data: []byte{1}, Format: "bbc-bin"}, `load address`)
}

func TestPlanMega65(t *testing.T) {
	m := mustPlan(t, runRequest{Platform: "mega65", Emulator: "xemu", Name: "demo", Data: []byte{0x01, 0x20, 0x60}, Format: "cbm"})
	eq(t, "xemu args", m.Args, []string{"-prg", m.File})
	matches(t, "xemu file", m.File, `demo\.prg$`)
	planFails(t, runRequest{Platform: "mega65", Emulator: "xemu", Name: "x", Data: []byte{1}, Format: "prg"}, `no \.prg`)
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
	for _, id := range []string{"altirra/atari", "atari800/atari", "winape/cpc", "caprice/cpc", "mame/cpc", "stella/vcs", "mame/vcs", "mesen/nes", "fceux/nes", "mesen/snes", "bsnes/snes", "snes9x/snes", "eightyone/zx81", "zesarux/zx81", "trs80gp/trs80", "mame/trs80", "beebem/bbc", "b2/bbc", "mame/bbc", "xemu/mega65", "winuae/amiga", "fsuae/amiga"} {
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
		if want := map[string]string{"winuae": "WinUAE", "fsuae": "FS-UAE"}[d.ID]; want != "" && d.Name != want || want == "" && d.Name != strings.ToUpper(d.ID[:1])+d.ID[1:] {
			t.Errorf("%s: name %q", d.ID, d.Name)
		}
	}
	eq(t, "order", order, []string{"altirra", "atari800", "winape", "caprice", "stella", "mesen", "fceux", "nestopia", "bsnes", "snes9x", "eightyone", "zesarux", "trs80gp", "beebem", "b2", "xemu", "winuae", "fsuae", "mame"})
	var platforms []string
	for _, p := range Preferred {
		platforms = append(platforms, p.ID)
	}
	eq(t, "platforms", platforms, []string{"atari", "cpc", "vcs", "nes", "snes", "zx81", "trs80", "bbc", "mega65", "amiga"})
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
	if code, v := do("POST", "/api/emu/run", `{"platform":"zx"}`); code != 400 || v["error"] != "unknown platform 'zx' (one of atari, cpc, vcs, nes, snes, zx81, trs80, bbc, mega65, amiga)" {
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
