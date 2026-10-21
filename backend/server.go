// Package backend: the server of nerdsuite - the IDE (public/), the example project and the bridges to
// the tools: VICE and mimic for running and debugging the Commodore machines (backend/vice, backend/mimic),
// the other emulators (backend/emu),
// KickAssembler (backend/kickass), the toolchains (backend/toolchain) and the Ultimate 64
// (backend/ultimate). It keeps no project: the project lives in the browser, assembling and tokenizing
// happen there too - a project in a folder of this computer is read and written through it (backend/disk). The paths of the tools are set in the Settings of the IDE (settings_api.go).
package backend

import (
	"encoding/base64"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"path"
	"strings"
	"sync/atomic"
	"time"

	"nerdsuite/backend/core"
	"nerdsuite/backend/disk"
	"nerdsuite/backend/emu"
	"nerdsuite/backend/kickass"
	"nerdsuite/backend/mimic"
	"nerdsuite/backend/romfont"
	"nerdsuite/backend/toolchain"
	"nerdsuite/backend/ultimate"
	"nerdsuite/backend/vice"
)

// Options: what the server hands out and where its settings are
type Options struct {
	Public   fs.FS  // the files of the IDE (public/)
	Examples fs.FS  // the example project (examples/demo)
	Version  string // shown in the About of the IDE
	Settings string // the file of the settings ("" - NERDSUITE_SETTINGS, else ~/.nerdsuite/settings.json)
	TmpDir   string // the folder of the temporary files
	// Idle > 0: the server ends when the last window of the IDE is closed (a desktop start without a
	// console window: nothing else ends it), at the latest this long after the last request; the IDE asks
	// every Idle/5 while a window of it is open (/api/info answers "idle": seconds) - windows.go
	Idle time.Duration
}

// Server: the HTTP server of the IDE
type Server struct {
	opts     Options
	settings *settingsAPI
	vice     *vice.API
	mimic    *mimic.API
	emu      *emu.API
	kick     *kickass.API
	tc       *toolchain.API
	ult      *ultimate.API
	fonts    *romfont.API
	disk     *disk.API
	last     atomic.Int64 // the time of the last request, unix nanoseconds
	win      windows      // the windows of the IDE (windows.go)
}

func New(o Options) *Server {
	st := core.NewSettings(o.Settings)
	env := core.Env{Settings: st, TmpDir: o.TmpDir}
	s := &Server{opts: o, vice: vice.New(env), mimic: mimic.New(env), emu: emu.New(env), kick: kickass.New(env), tc: toolchain.New(env), ult: ultimate.New(env), fonts: romfont.New(env), disk: disk.New()}

	// the settings list: the tools, where the server finds them; the emulator of each platform
	tools := []tool{
		{"VICE", "VICE", "Emulators", "the folder of x64sc - C64, C128, VIC-20, Plus/4, PET: run and debug", func() string {
			p, err := vice.FindExecutable(st, "c64")
			if err != nil {
				return ""
			}
			return p
		}},
		{mimic.Tool.Env, mimic.Tool.Name, "Emulators", "mimic.exe or its folder (with roms) - C64, C128, VIC-20, Plus/4, C16, PET, Atari 800 XL, Atari 2600, CPC: run and debug", func() string {
			return mimic.FindExecutable(st)
		}},
		{"KICKASS", "KickAssembler", "Assemblers", "KickAss.jar or its folder", func() string { jar, _ := s.kick.Found(); return jar }},
		{"JAVA", "Java", "Assemblers", "java(.exe) for KickAssembler - else JAVA_HOME or java on the PATH", func() string { _, java := s.kick.Found(); return java }},
	}
	for _, d := range toolchain.Packers {
		d := d
		tools = append(tools, tool{d.Env, d.Name, "Packers", fmt.Sprintf("the program or its folder - packs programs of the %s", strings.Join(d.Machines, ", ")),
			func() string { return core.ResolveExe(st, d) }})
	}
	for _, d := range emu.Emulators {
		d := d
		tools = append(tools, tool{d.Env, capital(d.ID), "Emulators", fmt.Sprintf("the program or its folder - %s", strings.Join(d.Platforms, ", ")),
			func() string { return core.ResolveExe(st, d) }})
	}
	// the Commodore machines: debugged in mimic or VICE; the Atari 8-bit, the 2600 and the CPC: mimic runs and
	// debugs them, the launcher (backend/emu) runs them in the others (the first one found when none is chosen)
	var platforms []platformList
	for _, m := range mimic.Commodore {
		platforms = append(platforms, platformList{m, []string{mimic.Tool.ID, "vice"}})
	}
	for _, p := range emu.Preferred {
		list := p.Emulators
		if p.ID == "atari" || p.ID == "vcs" || p.ID == "cpc" {
			list = append([]string{mimic.Tool.ID}, list...)
		}
		platforms = append(platforms, platformList{p.ID, list})
	}
	s.settings = &settingsAPI{st: st, tools: tools, platforms: platforms, onChange: s.kick.Rescan}
	return s
}

// Close: the emulators and the tools this server started end with it
func (s *Server) Close() {
	s.vice.Close()
	s.mimic.Close()
	s.emu.Close()
	s.kick.Close()
	s.tc.Close()
}

var mime = map[string]string{
	".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json",
	".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
	".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
	".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf",
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.last.Store(time.Now().UnixNano())
	defer func() {
		if e := recover(); e != nil {
			log.Printf("%s %s: %v", r.Method, r.URL.Path, e)
			core.WriteJSON(w, 500, map[string]any{"error": fmt.Sprint(e)})
		}
	}()
	p := r.URL.Path
	switch {
	case strings.HasPrefix(p, "/api/"):
		s.api(w, r)
	case p == "/" || p == "/index.html":
		s.serveApp(w, "/")
	default:
		s.serveStatic(w, r)
	}
}

func (s *Server) api(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	under := func(prefix string) bool { return p == prefix || strings.HasPrefix(p, prefix+"/") }
	switch {
	case under("/api/settings"):
		s.settings.ServeHTTP(w, r)
	case under("/api/ultimate"):
		s.ult.ServeHTTP(w, r)
	case under("/api/fonts"):
		s.fonts.ServeHTTP(w, r)
	case under("/api/toolchain"):
		s.tc.ServeHTTP(w, r)
	case under("/api/kickass"):
		s.kick.ServeHTTP(w, r)
	case under("/api/vice"):
		s.vice.ServeHTTP(w, r)
	case under("/api/mimic"):
		s.mimic.ServeHTTP(w, r)
	case under("/api/emu"):
		s.emu.ServeHTTP(w, r)
	case under("/api/disk"):
		s.disk.ServeHTTP(w, r)
	case core.Route(r) == "POST /api/bye":
		s.win.closed(r.URL.Query().Get("window"))
		w.WriteHeader(204)
	case core.Route(r) == "GET /api/info":
		s.win.alive(r.URL.Query().Get("window"))
		info := map[string]any{"version": s.opts.Version, "name": "nerdsuite"}
		if s.opts.Idle > 0 {
			info["idle"] = int(s.opts.Idle / time.Second)
		}
		core.WriteJSON(w, 200, info)
	case core.Route(r) == "GET /api/examples":
		files, err := readTree(s.opts.Examples)
		if err != nil {
			core.Fail(w, err)
			return
		}
		core.WriteJSON(w, 200, map[string]any{"name": "demo", "files": files})
	default:
		core.WriteJSON(w, 404, map[string]any{"error": "not found"})
	}
}

// readTree: the files of a folder below it, 'dir/file' -> base64 (the example project)
func readTree(fsys fs.FS) (map[string]string, error) {
	out := map[string]string{}
	if fsys == nil {
		return out, nil
	}
	err := fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p != "." && strings.HasPrefix(d.Name(), ".") {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.Type().IsRegular() {
			data, err := fs.ReadFile(fsys, p)
			if err != nil {
				return err
			}
			out[p] = base64.StdEncoding.EncodeToString(data)
		}
		return nil
	})
	return out, err
}

func send(w http.ResponseWriter, status int, body []byte, typ string) {
	w.Header().Set("Content-Type", typ)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	w.Write(body)
}

// serveApp: the page; a deep address of the routes (/code/src/main.asm): with a <base> back to its folder
func (s *Server) serveApp(w http.ResponseWriter, pathname string) {
	page, err := fs.ReadFile(s.opts.Public, "index.html")
	if err != nil {
		send(w, 500, []byte("index.html is missing"), "text/plain; charset=utf-8")
		return
	}
	up := strings.Repeat("../", max(0, len(strings.Split(pathname, "/"))-2))
	if up == "" {
		up = "./"
	}
	send(w, 200, []byte(strings.Replace(string(page), "<head>", "<head>\n  <base href=\""+up+"\">", 1)), mime[".html"])
}

func (s *Server) serveStatic(w http.ResponseWriter, r *http.Request) {
	rest := r.URL.Path
	if strings.HasSuffix(rest, "/") {
		rest += "index.html"
	}
	clean := strings.TrimPrefix(path.Clean("/"+rest), "/")
	if !fs.ValidPath(clean) || strings.Contains(rest, "..") {
		send(w, 403, []byte("forbidden"), "text/plain; charset=utf-8")
		return
	}
	data, err := fs.ReadFile(s.opts.Public, clean)
	if err != nil {
		// a route of the IDE (/code/src/main.asm) asked by the browser: the page
		if r.Method == "GET" && strings.Contains(r.Header.Get("Accept"), "text/html") {
			s.serveApp(w, r.URL.Path)
			return
		}
		send(w, 404, []byte("not found"), "text/plain; charset=utf-8")
		return
	}
	typ := mime[strings.ToLower(path.Ext(clean))]
	if typ == "" {
		typ = "application/octet-stream"
	}
	send(w, 200, data, typ)
}
