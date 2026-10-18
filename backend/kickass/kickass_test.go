// KickAssembler: the parsers of its output files (always) and the real assembler (when KickAss.jar
// and Java are found: KICKASS, JAVA, or the usual places - see kickass.go)
package kickass

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"nerdsuite/backend/core"
)

func TestAsmInfoSections(t *testing.T) {
	s := parseAsmInfo("[version]\n5.25\n[errors]\nError;12,9,12,15,0;Unknown symbol 'x'\n[files]\n0;C:\\p\\main.asm\n")
	if !reflect.DeepEqual(s["errors"], []string{"Error;12,9,12,15,0;Unknown symbol 'x'"}) {
		t.Errorf("errors: %q", s["errors"])
	}
	if !reflect.DeepEqual(s["files"], []string{`0;C:\p\main.asm`}) {
		t.Errorf("files: %q", s["files"])
	}
}

func TestDebugDump(t *testing.T) {
	d := parseDebugDump(`<C64debugger version="1.0">
   <Sources values="INDEX,FILE">
      0,KickAss.jar:/include/autoinclude.asm
      1,C:\p\main.asm
   </Sources>
   <Segment name="Default"><Block name="Main">
         $0810,$0811,1,4,5,4,7
         $0812,$0814,1,5,5,5,7
   </Block></Segment>
   <Labels values="SEGMENT,ADDRESS,NAME,START,END,FILE_IDX,LINE1,COL1,LINE2,COL2">
      Default,$0810,start,1,3,1,3,6
   </Labels></C64debugger>`)
	if d.Files[1] != `C:\p\main.asm` {
		t.Errorf("file 1: %q", d.Files[1])
	}
	var ranges [][3]float64
	for _, r := range d.Ranges {
		ranges = append(ranges, [3]float64{r.Start, r.End, r.Line})
	}
	if !reflect.DeepEqual(ranges, [][3]float64{{0x810, 0x811, 4}, {0x812, 0x814, 5}}) {
		t.Errorf("ranges: %v", ranges)
	}
	if len(d.Labels) != 1 || d.Labels[0].Name != "start" || d.Labels[0].Value != 0x810 {
		t.Errorf("labels: %+v", d.Labels)
	}
}

func TestSymbolFile(t *testing.T) {
	got := parseSymbols(".label data=$823\n.const SCREEN=$400\n")
	want := []symbol{{Name: "data", Value: 0x823, Kind: "label"}, {Name: "SCREEN", Value: 0x400, Kind: "set"}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v", got)
	}
}

func TestProjectPath(t *testing.T) {
	if p, err := projectPath(`src\main.asm`); err != nil || p != "src/main.asm" {
		t.Errorf("src\\main.asm: %q %v", p, err)
	}
	for _, bad := range []any{"", "/x", "C:x", "a/../b", "./a", "a//b", undefined{}, nil} {
		if _, err := projectPath(bad); err == nil || core.StatusOf(err) != 400 {
			t.Errorf("%v: %v", bad, err)
		}
	}
	if _, err := projectPath(undefined{}); err.Error() != "'undefined' is not a path of the project" {
		t.Errorf("message: %v", err)
	}
}

// call: a request to the API, its status and its JSON
func call(t *testing.T, api *API, method, path string, body any) (int, map[string]any) {
	t.Helper()
	var rd *bytes.Reader
	if body != nil {
		data, _ := json.Marshal(body)
		rd = bytes.NewReader(data)
	} else {
		rd = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, rd)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	api.ServeHTTP(rec, req)
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("%s %s: no JSON: %s", method, path, rec.Body.String())
	}
	return rec.Code, out
}

func newAPI(t *testing.T) (*API, string) {
	tmp := t.TempDir()
	return New(core.Env{Settings: core.NewSettings(filepath.Join(tmp, "settings.json")), TmpDir: tmp}), tmp
}

func TestRoutes(t *testing.T) {
	api, _ := newAPI(t)
	if code, r := call(t, api, "GET", "/api/kickass/nothing", nil); code != 404 || r["error"] != "not found" {
		t.Errorf("404: %d %v", code, r)
	}
	if code, r := call(t, api, "POST", "/api/kickass/assemble", nil); code != 200 && code != 400 {
		t.Errorf("an empty body: %d %v", code, r)
	}
}

func TestRealKickAssembler(t *testing.T) {
	api, tmp := newAPI(t)
	_, status := call(t, api, "GET", "/api/kickass/status", nil)
	if status["available"] != true {
		t.Skip("KickAssembler or Java not found")
	}
	if v, _ := status["version"].(string); v == "" {
		t.Errorf("no version: %v", status)
	}
	code, info := call(t, api, "GET", "/api/kickass/info", nil)
	if code != 200 || len(info["directives"].([]any)) == 0 {
		t.Errorf("info: %d %v", code, info["directives"])
	}
	b64 := func(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }
	files := map[string]any{
		"src/main.asm": b64("BasicUpstart2(start)\n#import \"lib/m.asm\"\n*= $0810 \"Main\"\nstart:  lda #0\n        Border(1)\n!l:     jmp !l-\nd:      .import binary \"../gfx/a.bin\"\n"),
		"lib/m.asm":    b64(".macro Border(c) {\n    lda #c\n    sta $d020\n}\n"),
		"gfx/a.bin":    base64.StdEncoding.EncodeToString([]byte{1, 2, 3}),
	}
	code, r := call(t, api, "POST", "/api/kickass/assemble", map[string]any{"main": "src/main.asm", "files": files})
	if code != 200 || r["ok"] != true {
		t.Fatalf("%d %v\n%v", code, r["errors"], r["log"])
	}
	prg, _ := base64.StdEncoding.DecodeString(r["output"].(string))
	if int(prg[0])|int(prg[1])<<8 != 0x0801 || r["start"] != float64(0x0801) {
		t.Errorf("start: %v", r["start"])
	}
	if o := 2 + 0x0810 - 0x0801; !bytes.Equal(prg[o:o+2], []byte{0xa9, 0x00}) {
		t.Errorf("lda #0: % x", prg[o:o+2])
	}
	found := false
	for _, l := range r["lines"].([]any) {
		m := l.(map[string]any)
		found = found || m["file"] == "lib/m.asm" && m["line"] == float64(2)
	}
	if !found {
		t.Errorf("no line 2 of lib/m.asm: %v", r["lines"])
	}
	found = false
	for _, s := range r["symbols"].([]any) {
		m := s.(map[string]any)
		found = found || m["name"] == "start" && m["value"] == float64(0x0810)
	}
	if !found {
		t.Errorf("no symbol start: %v", r["symbols"])
	}
	if !regexp.MustCompile(`al C:810 \.start`).MatchString(r["viceLabels"].(string)) {
		t.Errorf("viceLabels: %q", r["viceLabels"])
	}
	if !strings.Contains(r["listing"].(string), "start") || r["memory"] == "" {
		t.Errorf("listing %q, memory %q", r["listing"], r["memory"])
	}

	files["src/main.asm"] = b64("*= $1000\n    lda nothing\n")
	_, e := call(t, api, "POST", "/api/kickass/assemble", map[string]any{"main": "src/main.asm", "files": files})
	if e["ok"] != false || e["output"] != nil {
		t.Fatalf("an error assembled: %v", e)
	}
	e0 := e["errors"].([]any)[0].(map[string]any)
	if e0["file"] != "src/main.asm" || e0["line"] != float64(2) || e0["col"] != float64(9) {
		t.Errorf("error: %v", e0)
	}

	// the work folders are gone
	left, _ := filepath.Glob(filepath.Join(tmp, "kickass-*"))
	if len(left) != 0 {
		t.Errorf("left behind: %v", left)
	}
}
