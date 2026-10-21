package backend

import (
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func testServer(t *testing.T) *Server {
	t.Helper()
	public := fstest.MapFS{
		"index.html":    {Data: []byte("<html><head><title>x</title></head></html>")},
		"js/app.js":     {Data: []byte("export {}")},
		"css/app.css":   {Data: []byte("body{}")},
		"fonts/a.woff2": {Data: []byte{1, 2}},
	}
	examples := fstest.MapFS{
		"nerdsuite.json": {Data: []byte("{}")},
		"src/main.asm":   {Data: []byte("rts\n")},
		".hidden":        {Data: []byte("x")},
	}
	s := New(Options{Public: public, Examples: examples, Version: "v-test", Settings: filepath.Join(t.TempDir(), "settings.json"), TmpDir: t.TempDir()})
	t.Cleanup(s.Close)
	return s
}

func do(s *Server, method, path, body string, header map[string]string) (int, string, map[string]string) {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	for k, v := range header {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec.Code, rec.Body.String(), map[string]string{"type": rec.Header().Get("Content-Type"), "cache": rec.Header().Get("Cache-Control")}
}

func TestStaticAndRoutes(t *testing.T) {
	s := testServer(t)
	if code, body, h := do(s, "GET", "/", "", nil); code != 200 || !strings.Contains(body, `<base href="./">`) || !strings.HasPrefix(h["type"], "text/html") || h["cache"] != "no-store" {
		t.Fatalf("/: %d %q %v", code, body, h)
	}
	if code, body, h := do(s, "GET", "/js/app.js", "", nil); code != 200 || body != "export {}" || h["type"] != "text/javascript; charset=utf-8" {
		t.Fatalf("app.js: %d %q %v", code, body, h)
	}
	if _, _, h := do(s, "GET", "/fonts/a.woff2", "", nil); h["type"] != "font/woff2" {
		t.Fatalf("woff2: %v", h)
	}
	// a route of the IDE asked by the browser: the page with a <base> back to the top
	if code, body, _ := do(s, "GET", "/code/src/main.asm", "", map[string]string{"Accept": "text/html"}); code != 200 || !strings.Contains(body, `<base href="../../">`) {
		t.Fatalf("deep route: %d %q", code, body)
	}
	if code, body, _ := do(s, "GET", "/js/missing.js", "", nil); code != 404 || body != "not found" {
		t.Fatalf("missing: %d %q", code, body)
	}
	if code, body, _ := do(s, "GET", "/api/nothing", "", nil); code != 404 || body != `{"error":"not found"}` {
		t.Fatalf("api 404: %d %q", code, body)
	}
	if _, body, _ := do(s, "GET", "/api/info", "", nil); body != `{"name":"nerdsuite","version":"v-test"}` {
		t.Fatalf("info: %q", body)
	}
	_, body, _ := do(s, "GET", "/api/examples", "", nil)
	var ex struct {
		Name  string
		Files map[string]string
	}
	json.Unmarshal([]byte(body), &ex)
	if ex.Name != "demo" || len(ex.Files) != 2 || ex.Files["src/main.asm"] != base64.StdEncoding.EncodeToString([]byte("rts\n")) {
		t.Fatalf("examples: %q", body)
	}
}

var jsonHeader = map[string]string{"Content-Type": "application/json"}

func TestSettingsTools(t *testing.T) {
	s := testServer(t)
	code, body, _ := do(s, "GET", "/api/settings/tools", "", nil)
	var got struct {
		Tools []struct {
			Key, Group string
			Found      any
			Available  bool
		}
		Platforms []struct {
			ID        string
			Emulators []string
		}
		Toolchains []any
		Ultimate   map[string]any
	}
	if json.Unmarshal([]byte(body), &got); code != 200 || len(got.Tools) < 5 || got.Tools[0].Key != "VICE" || got.Tools[1].Key != "MIMIC" || got.Toolchains == nil {
		t.Fatalf("GET: %d %s", code, body)
	}
	// the Commodore machines first: debugged in mimic or VICE
	if len(got.Platforms) < 7 || got.Platforms[0].ID != "c64" || strings.Join(got.Platforms[0].Emulators, ",") != "mimic,vice" ||
		got.Platforms[5].ID != "pet" || got.Platforms[6].ID != "atari" || got.Platforms[6].Emulators[0] != "mimic" || got.Ultimate["password"] != false {
		t.Fatalf("platforms / ultimate: %s", body)
	}
	put := func(b string, h map[string]string) (int, string) {
		c, body, _ := do(s, "PUT", "/api/settings/tools", b, h)
		return c, body
	}
	if c, _ := put(`{"paths":{"VICE":"C:/nowhere"}}`, map[string]string{"Content-Type": "text/plain"}); c != 403 {
		t.Fatalf("text/plain: %d", c)
	}
	if c, _ := put(`{}`, map[string]string{"Content-Type": "application/json", "Origin": "http://evil.example"}); c != 403 {
		t.Fatalf("foreign origin: %d", c)
	}
	if c, b := put(`{"paths":{"NOPE":"x"}}`, jsonHeader); c != 400 || !strings.Contains(b, "unknown tool 'NOPE'") {
		t.Fatalf("unknown tool: %d %s", c, b)
	}
	if c, b := put(`{"preferred":{"atari":"stella"}}`, jsonHeader); c != 400 || !strings.Contains(b, "'stella' does not run atari") {
		t.Fatalf("preferred: %d %s", c, b)
	}
	if c, b := put(`{"preferred":{"c64":"altirra"}}`, jsonHeader); c != 400 || !strings.Contains(b, "'altirra' does not run c64") {
		t.Fatalf("preferred c64: %d %s", c, b)
	}
	if c, b := put(`{"preferred":{"c64":"vice"}}`, jsonHeader); c != 200 || !strings.Contains(b, `"id":"c64","preferred":"vice"`) {
		t.Fatalf("preferred c64 vice: %d %s", c, b)
	}
	if c, b := put(`{"ultimate":{"host":"x/../y"}}`, jsonHeader); c != 400 || !strings.Contains(b, "is no address of a device") {
		t.Fatalf("ultimate host: %d %s", c, b)
	}
	if c, b := put(`{"toolchains":[{"id":"a"},{"id":"a"}]}`, jsonHeader); c != 400 || !strings.Contains(b, "two toolchains have the same id") {
		t.Fatalf("toolchains: %d %s", c, b)
	}
	c, b := put(`{"paths":{"VICE":" C:/somewhere "},"preferred":{"atari":"altirra"},"ultimate":{"host":"192.168.1.64","password":"pw"},"toolchains":[{"id":"tc1","name":" Mine "}]}`, jsonHeader)
	if c != 200 || !strings.Contains(b, `"value":"C:/somewhere"`) || !strings.Contains(b, `"preferred":"altirra"`) ||
		!strings.Contains(b, `"host":"192.168.1.64"`) || !strings.Contains(b, `"password":true`) || strings.Contains(b, `"pw"`) {
		t.Fatalf("PUT: %d %s", c, b)
	}
	if !strings.Contains(b, `"toolchains":[{"id":"tc1","name":"Mine","machine":"","compiler":{"kind":"project","command":""},"packer":{"kind":"none","command":"","args":""},"emulator":{"kind":"auto","command":""}}]`) {
		t.Fatalf("the toolchain as kept: %s", b)
	}
	// the password stays when only the address is sent; an empty path removes it
	_, b = put(`{"ultimate":{"host":"u64.local"},"paths":{"VICE":""}}`, jsonHeader)
	if !strings.Contains(b, `"password":true`) || strings.Contains(b, "C:/somewhere") {
		t.Fatalf("kept password / removed path: %s", b)
	}
}

func TestCleanToolchain(t *testing.T) {
	tc, err := CleanToolchain(map[string]any{"id": "tc1", "name": " Mine "}, 0)
	if err != nil || tc.Name != "Mine" || tc.Compiler.Kind != "project" || tc.Packer.Kind != "none" || tc.Emulator.Kind != "auto" {
		t.Fatalf("%+v %v", tc, err)
	}
	for _, c := range []struct {
		in   map[string]any
		want string
	}{
		{map[string]any{"id": "../x"}, "no id"},
		{map[string]any{"id": "a", "packer": map[string]any{"kind": "rm -rf"}}, "no kind"},
		{map[string]any{"id": "a", "compiler": map[string]any{"kind": "command", "command": 5.0}}, "no text"},
	} {
		if _, err := CleanToolchain(c.in, 0); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%v: want %q, got %v", c.in, c.want, err)
		}
	}
}

// a desktop start without a console window: /api/info tells the IDE how long the server waits for it,
// and every request is the last one
// the server of a desktop start ends when its last window says bye - not on a reload, not while another
// window is open; a window that says nothing: Idle after the last request
func TestWindowsBye(t *testing.T) {
	s := testServer(t)
	s.opts.Idle = 5 * time.Minute
	idle := s.opts.Idle
	last := func() time.Time { return time.Unix(0, s.last.Load()) }
	do(s, "GET", "/api/info?window=a", "", nil)
	do(s, "GET", "/api/info?window=b", "", nil)
	if code, _, _ := do(s, "POST", "/api/bye?window=a", "", nil); code != 204 {
		t.Fatalf("bye: %d", code)
	}
	later := time.Now().Add(byeGrace + time.Second)
	if s.win.done(later, last(), idle) {
		t.Fatal("ends while window b is open")
	}
	do(s, "POST", "/api/bye?window=b", "", nil)
	if s.win.done(time.Now(), last(), idle) {
		t.Fatal("ends before the grace of a reload")
	}
	if !s.win.done(time.Now().Add(byeGrace+time.Second), last(), idle) {
		t.Fatal("does not end after the last window")
	}
	// a reload: the new page asks after the bye
	time.Sleep(2 * time.Millisecond)
	do(s, "GET", "/api/info?window=c", "", nil)
	if s.win.done(time.Now().Add(byeGrace+time.Second), last(), idle) {
		t.Fatal("ends after a reload")
	}
	// no bye at all: Idle after the last request
	var w windows
	now := time.Now()
	if w.done(now, now.Add(-time.Minute), idle) || !w.done(now, now.Add(-idle-time.Second), idle) {
		t.Fatal("the idle time")
	}
}

func TestIdle(t *testing.T) {
	s := testServer(t)
	s.opts.Idle = 5 * time.Minute
	before := time.Now().UnixNano()
	if _, body, _ := do(s, "GET", "/api/info", "", nil); body != `{"idle":300,"name":"nerdsuite","version":"v-test"}` {
		t.Fatalf("info: %s", body)
	}
	if s.last.Load() < before {
		t.Fatal("the request is not the last one")
	}
}
