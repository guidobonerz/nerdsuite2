package core

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// IsWindows: the server runs on Windows (.exe, the defaults of the tools)
var IsWindows = runtime.GOOS == "windows"

// AppsDir: the folder the defaults of the tools look in (C:\Users\<you>\applications on this machine)
func AppsDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "applications")
}

// IsFile, IsDir: a file / a folder is there
func IsFile(p string) bool { st, err := os.Stat(p); return err == nil && st.Mode().IsRegular() }
func IsDir(p string) bool  { st, err := os.Stat(p); return err == nil && st.IsDir() }

// SearchPath: the first of the names found on the PATH (name.exe first on Windows), or ""
func SearchPath(names ...string) string {
	for _, d := range filepath.SplitList(os.Getenv("PATH")) {
		if d == "" {
			continue
		}
		for _, n := range names {
			cands := []string{n}
			if IsWindows {
				cands = []string{n + ".exe", n}
			}
			for _, c := range cands {
				if p := filepath.Join(d, c); IsFile(p) {
					return p
				}
			}
		}
	}
	return ""
}

// FindInDir: the first of the names in a folder - exact, else ignoring the case - or ""
func FindInDir(dir string, names ...string) string {
	for _, n := range names {
		if p := filepath.Join(dir, n); IsFile(p) {
			return p
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	for _, e := range entries {
		for _, n := range names {
			if strings.EqualFold(e.Name(), n) && e.Type().IsRegular() {
				return filepath.Join(dir, e.Name())
			}
		}
	}
	return ""
}

// ToolDef: a program the server starts - an emulator, a packer. Env: its key in the settings and its
// environment variable; Defaults: files tried; Dir + DirNames: a folder searched; Path: names on the PATH
type ToolDef struct {
	ID        string
	Name      string
	Env       string
	Platforms []string // an emulator: the platforms it runs
	Machines  []string // a packer: the machines it packs programs of
	Defaults  []string
	Dir       string
	DirNames  []string
	Path      []string
}

// ResolveExe: where a tool is - the path of the settings (a file, or a folder with one of its
// DirNames), else its defaults, its folder, the PATH - or ""
func ResolveExe(st *Settings, d ToolDef) string {
	if v := st.ToolPath(d.Env); v != "" {
		if IsFile(v) {
			abs, err := filepath.Abs(v)
			if err == nil {
				return abs
			}
			return v
		}
		if len(d.DirNames) > 0 {
			if p := FindInDir(v, d.DirNames...); p != "" {
				return p
			}
		}
	}
	for _, p := range d.Defaults {
		if IsFile(p) {
			return p
		}
	}
	if d.Dir != "" && len(d.DirNames) > 0 {
		if p := FindInDir(d.Dir, d.DirNames...); p != "" {
			return p
		}
	}
	return SearchPath(d.Path...)
}

// FormatCommand: a command line to show, quoted where a word has a space or a quote
func FormatCommand(exe string, args []string) string {
	q := func(s string) string {
		if strings.ContainsAny(s, " \t\"") {
			return `"` + strings.ReplaceAll(s, `"`, `\"`) + `"`
		}
		return s
	}
	out := []string{q(exe)}
	for _, a := range args {
		out = append(out, q(a))
	}
	return strings.Join(out, " ")
}

// HideWindow: a tool runs without a console window of its own (Windows; nothing elsewhere)
func HideWindow(cmd *exec.Cmd) { hideWindow(cmd) }
