// Package disk: projects as folders of this computer - the IDE opens a folder, the server reads its files
// and writes them back as they change. The browser cannot do that itself; the server runs on this
// computer and can.
//
//	POST /api/disk/dirs    { path }               -> { path, parent, sep, dirs: [{ name, project }], roots, home }
//	POST /api/disk/mkdir   { path }               -> { path }
//	POST /api/disk/project { dir, ext: [".asm"] } -> { name, dir, files: { "src/main.asm": base64 }, skipped: [...] }
//	POST /api/disk/write   { dir, path, data }    -> {}   (data: base64; the folders made, the file replaced at once)
//	POST /api/disk/remove  { dir, path }          -> {}   (and the folders it leaves empty)
//
// Only the page of this server may ask (core.SameOrigin, core.LocalHost): the files of the computer are not
// for another site that runs in the same browser. A path of a project is relative, with '/', and stays
// in the folder of the project.
package disk

import (
	"encoding/base64"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"nerdsuite/backend/core"
)

// the limits of a project (as the IDE's, public/js/project.js)
const (
	maxFile  = 1 << 20
	maxTotal = 16 << 20
	maxFiles = 2000
)

// marker: a folder with it is a project of nerdsuite (the settings of a project)
const marker = "nerdsuite.json"

// API: the handler of /api/disk
type API struct{}

func New() *API { return &API{} }

func (a *API) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !core.LocalHost(r) || !core.SameOrigin(r) || r.Method != "POST" {
		core.WriteJSON(w, 403, map[string]any{"error": "only the page of this server may use the files of this computer"})
		return
	}
	var req struct {
		Path string   `json:"path"`
		Dir  string   `json:"dir"`
		Ext  []string `json:"ext"`
		Data string   `json:"data"`
	}
	if err := core.ReadJSON(r, maxFile*2, &req); err != nil {
		core.Fail(w, err)
		return
	}
	var out any
	var err error
	switch strings.TrimRight(r.URL.Path, "/") {
	case "/api/disk/dirs":
		out, err = Dirs(req.Path)
	case "/api/disk/mkdir":
		out, err = Mkdir(req.Path)
	case "/api/disk/project":
		out, err = ReadProject(req.Dir, req.Ext)
	case "/api/disk/write":
		err = Write(req.Dir, req.Path, req.Data)
		out = map[string]any{}
	case "/api/disk/remove":
		err = Remove(req.Dir, req.Path)
		out = map[string]any{}
	default:
		err = core.Errorf(404, "not found")
	}
	if err != nil {
		core.Fail(w, err)
		return
	}
	core.WriteJSON(w, 200, out)
}

// Dir: a folder in a listing
type Dir struct {
	Name    string `json:"name"`
	Project bool   `json:"project"` // it has a nerdsuite.json
}

// Root: where a listing can start - the home folder, the drives (Windows) or /
type Root struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

// Listing: the folders in a folder
type Listing struct {
	Path    string `json:"path"`
	Parent  string `json:"parent"` // "" at a root
	Sep     string `json:"sep"`
	Dirs    []Dir  `json:"dirs"`
	Project bool   `json:"project"`
	Roots   []Root `json:"roots"`
	Home    string `json:"home"`
}

// Dirs: the folders in a folder ("" - the home folder), without the hidden ones
func Dirs(p string) (*Listing, error) {
	home, _ := os.UserHomeDir()
	if p == "" {
		p = home
	}
	p, err := folder(p)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(p)
	if err != nil {
		return nil, core.Errorf(403, "%s cannot be read: %v", p, err)
	}
	l := &Listing{Path: p, Sep: string(filepath.Separator), Dirs: []Dir{}, Project: isFile(filepath.Join(p, marker)), Roots: roots(home), Home: home}
	if parent := filepath.Dir(p); parent != p {
		l.Parent = parent
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") || strings.HasPrefix(e.Name(), "$") {
			continue
		}
		full := filepath.Join(p, e.Name())
		if !e.IsDir() && !(e.Type()&fs.ModeSymlink != 0 && isDir(full)) {
			continue
		}
		l.Dirs = append(l.Dirs, Dir{Name: e.Name(), Project: isFile(filepath.Join(full, marker))})
	}
	sort.Slice(l.Dirs, func(i, j int) bool { return strings.ToLower(l.Dirs[i].Name) < strings.ToLower(l.Dirs[j].Name) })
	return l, nil
}

func roots(home string) []Root {
	var out []Root
	if home != "" {
		out = append(out, Root{"Home", home})
	}
	if runtime.GOOS == "windows" {
		for c := 'A'; c <= 'Z'; c++ {
			if d := string(c) + `:\`; isDir(d) {
				out = append(out, Root{string(c) + ":", d})
			}
		}
	} else {
		out = append(out, Root{"/", "/"})
	}
	return out
}

// Mkdir: a new folder (its parent must be there)
func Mkdir(p string) (map[string]any, error) {
	if !filepath.IsAbs(p) {
		return nil, core.Errorf(400, "%q is no full path", p)
	}
	p = filepath.Clean(p)
	if _, err := folder(filepath.Dir(p)); err != nil {
		return nil, err
	}
	if err := os.Mkdir(p, 0o755); err != nil && !errors.Is(err, fs.ErrExist) {
		return nil, core.Errorf(403, "%s: %v", p, err)
	}
	return map[string]any{"path": p}, nil
}

// Project: the files of a project folder
type Project struct {
	Name    string            `json:"name"`
	Dir     string            `json:"dir"`
	Files   map[string]string `json:"files"`
	Skipped []string          `json:"skipped"`
}

// skipDir: folders that are no part of a project - the hidden ones (.git), the outputs, the packages
func skipDir(rel, name string) bool {
	return strings.HasPrefix(name, ".") || name == "node_modules" || name == "__MACOSX" || rel == "build"
}

// ReadProject: the files of a folder whose suffix is one of ext (all without), each at most maxFile; the
// others it found are skipped (too large)
func ReadProject(dir string, ext []string) (*Project, error) {
	dir, err := folder(dir)
	if err != nil {
		return nil, err
	}
	want := map[string]bool{}
	for _, e := range ext {
		want[strings.ToLower(e)] = true
	}
	p := &Project{Name: filepath.Base(dir), Dir: dir, Files: map[string]string{}, Skipped: []string{}}
	total := 0
	err = filepath.WalkDir(dir, func(full string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, full)
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			if full != dir && skipDir(rel, d.Name()) {
				return fs.SkipDir
			}
			return nil
		}
		if strings.HasPrefix(d.Name(), ".") || !d.Type().IsRegular() || (len(want) > 0 && !want[strings.ToLower(path.Ext(rel))]) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if info.Size() > maxFile {
			p.Skipped = append(p.Skipped, rel)
			return nil
		}
		if len(p.Files) >= maxFiles {
			return core.Errorf(413, "%s has more than %d files of a project", dir, maxFiles)
		}
		data, err := os.ReadFile(full)
		if err != nil {
			return err
		}
		if total += len(data); total > maxTotal {
			return core.Errorf(413, "the files of %s are more than %d MB", dir, maxTotal>>20)
		}
		p.Files[rel] = base64.StdEncoding.EncodeToString(data)
		return nil
	})
	if err != nil {
		var h *core.HTTPError
		if errors.As(err, &h) {
			return nil, err
		}
		return nil, core.Errorf(403, "%s cannot be read: %v", dir, err)
	}
	return p, nil
}

// Write: a file of a project, its folders made; written beside it first, then put in its place (a
// file is never half written)
func Write(dir, rel, data string) error {
	full, err := inside(dir, rel)
	if err != nil {
		return err
	}
	bytes, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		return core.Errorf(400, "the data of %s is no base64", rel)
	}
	if len(bytes) > maxFile {
		return core.Errorf(413, "%s is too large", rel)
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return core.Errorf(403, "%s: %v", rel, err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(full), "."+filepath.Base(full)+".*.tmp")
	if err != nil {
		return core.Errorf(403, "%s: %v", rel, err)
	}
	_, werr := tmp.Write(bytes)
	cerr := tmp.Close()
	if werr == nil {
		werr = cerr
	}
	if werr == nil {
		werr = os.Rename(tmp.Name(), full)
	}
	if werr != nil {
		os.Remove(tmp.Name())
		return core.Errorf(403, "%s: %v", rel, werr)
	}
	return nil
}

// Remove: a file of a project, and the folders it leaves empty (not the project's own)
func Remove(dir, rel string) error {
	full, err := inside(dir, rel)
	if err != nil {
		return err
	}
	if err := os.Remove(full); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return core.Errorf(403, "%s: %v", rel, err)
	}
	root := filepath.Clean(dir)
	for p := filepath.Dir(full); p != root && strings.HasPrefix(p, root); p = filepath.Dir(p) {
		if os.Remove(p) != nil { // not empty: it stays, and the ones above it too
			break
		}
	}
	return nil
}

// folder: a folder that is there, as a clean full path
func folder(p string) (string, error) {
	if !filepath.IsAbs(p) {
		return "", core.Errorf(400, "%q is no full path", p)
	}
	p = filepath.Clean(p)
	if !isDir(p) {
		return "", core.Errorf(404, "there is no folder %s", p)
	}
	return p, nil
}

// inside: the file of a project path in the folder of the project - a relative path with '/', without
// '..' or ':', that stays in it
func inside(dir, rel string) (string, error) {
	dir, err := folder(dir)
	if err != nil {
		return "", err
	}
	if rel == "" || strings.Contains(rel, `\`) || strings.HasPrefix(rel, "/") || filepath.IsAbs(rel) || filepath.VolumeName(rel) != "" {
		return "", core.Errorf(400, "%q is no path of the project", rel)
	}
	for _, s := range strings.Split(rel, "/") {
		// ':' names a drive on Windows ("C:/x") and is no file name there - not on any system then
		if s == "" || s == "." || s == ".." || strings.Contains(s, ":") {
			return "", core.Errorf(400, "%q is no path of the project", rel)
		}
	}
	full := filepath.Join(dir, filepath.FromSlash(rel))
	if r, err := filepath.Rel(dir, full); err != nil || r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) {
		return "", core.Errorf(400, "%q is outside the project", rel)
	}
	return full, nil
}

func isDir(p string) bool  { st, err := os.Stat(p); return err == nil && st.IsDir() }
func isFile(p string) bool { st, err := os.Stat(p); return err == nil && st.Mode().IsRegular() }
