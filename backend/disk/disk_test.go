package disk

import (
	"encoding/base64"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func call(a *API, path, body string, header map[string]string) (int, string) {
	req := httptest.NewRequest("POST", path, strings.NewReader(body))
	req.Host = "localhost:3064"
	req.Header.Set("Content-Type", "application/json")
	for k, v := range header {
		if k == "Host" {
			req.Host = v
		} else {
			req.Header.Set(k, v)
		}
	}
	w := httptest.NewRecorder()
	a.ServeHTTP(w, req)
	return w.Code, w.Body.String()
}

func q(s string) string { return strings.ReplaceAll(s, `\`, `\\`) }

func TestProjectFolder(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "src"), 0o755)
	os.MkdirAll(filepath.Join(dir, ".git"), 0o755)
	os.MkdirAll(filepath.Join(dir, "build"), 0o755)
	os.WriteFile(filepath.Join(dir, "src", "main.asm"), []byte("rts\n"), 0o644)
	os.WriteFile(filepath.Join(dir, ".git", "config.asm"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(dir, "build", "out.prg"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(dir, "notes.docx"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(dir, "big.bin"), make([]byte, maxFile+1), 0o644)

	p, err := ReadProject(dir, []string{".asm", ".bin", ".prg"})
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Files) != 1 || p.Files["src/main.asm"] != base64.StdEncoding.EncodeToString([]byte("rts\n")) {
		t.Fatalf("files: %v", p.Files)
	}
	if len(p.Skipped) != 1 || p.Skipped[0] != "big.bin" || p.Name != filepath.Base(dir) {
		t.Fatalf("skipped: %v, name %s", p.Skipped, p.Name)
	}

	// written into new folders, replaced, removed with the folders it leaves empty
	data := base64.StdEncoding.EncodeToString([]byte("lda #1\n"))
	if err := Write(dir, "gfx/tiles/a.til", data); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "gfx", "tiles", "a.til")); string(b) != "lda #1\n" {
		t.Fatalf("written: %q", b)
	}
	if err := Write(dir, "src/main.asm", data); err != nil {
		t.Fatal(err)
	}
	if err := Remove(dir, "gfx/tiles/a.til"); err != nil {
		t.Fatal(err)
	}
	if isDir(filepath.Join(dir, "gfx")) {
		t.Fatal("the empty folders stay")
	}
	if entries, _ := os.ReadDir(filepath.Join(dir, "src")); len(entries) != 1 {
		t.Fatalf("a temporary file is left: %v", entries)
	}

	// no path out of the project
	for _, bad := range []string{"../x.asm", "src/../../x.asm", "/etc/x.asm", `src\x.asm`, "", "a//b.asm", "C:/x.asm"} {
		if err := Write(dir, bad, data); err == nil {
			t.Errorf("%q was written", bad)
		}
	}
}

func TestDirs(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "game"), 0o755)
	os.MkdirAll(filepath.Join(dir, ".hidden"), 0o755)
	os.WriteFile(filepath.Join(dir, "game", marker), []byte("{}"), 0o644)
	os.WriteFile(filepath.Join(dir, "file.txt"), []byte("x"), 0o644)
	l, err := Dirs(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(l.Dirs) != 1 || l.Dirs[0].Name != "game" || !l.Dirs[0].Project || l.Parent == "" || len(l.Roots) == 0 {
		t.Fatalf("listing: %+v", l)
	}
	if _, err := Mkdir(filepath.Join(dir, "new")); err != nil || !isDir(filepath.Join(dir, "new")) {
		t.Fatalf("mkdir: %v", err)
	}
	if _, err := Dirs("relative"); err == nil {
		t.Fatal("a relative path is listed")
	}
}

// only the page of this server: not another site, not a name that leads here (DNS rebinding), JSON only
func TestOnlyThePage(t *testing.T) {
	a := New()
	dir := t.TempDir()
	body := `{"path":"` + q(dir) + `"}`
	if code, out := call(a, "/api/disk/dirs", body, nil); code != 200 {
		t.Fatalf("the page: %d %s", code, out)
	}
	for name, h := range map[string]map[string]string{
		"another site": {"Origin": "http://evil.example"},
		"rebinding":    {"Host": "evil.example:3064", "Origin": "http://evil.example:3064"},
		"a form":       {"Content-Type": "text/plain"},
		"another host": {"Host": "192.168.1.5:3064"},
	} {
		if code, _ := call(a, "/api/disk/dirs", body, h); code != 403 {
			t.Errorf("%s: %d", name, code)
		}
	}
	req := httptest.NewRequest("GET", "/api/disk/dirs", nil)
	req.Host = "localhost:3064"
	w := httptest.NewRecorder()
	a.ServeHTTP(w, req)
	if w.Code != 403 {
		t.Errorf("GET: %d", w.Code)
	}
}
