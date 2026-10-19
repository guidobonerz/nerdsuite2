package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

// running: a nerdsuite answers on the port of this computer
func running(port int) bool {
	c := &http.Client{Timeout: time.Second}
	res, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/api/info", port))
	if err != nil {
		return false
	}
	defer res.Body.Close()
	var info struct {
		Name string `json:"name"`
	}
	body, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
	return res.StatusCode == 200 && json.Unmarshal(body, &info) == nil && info.Name == "nerdsuite"
}

// openWindow: the IDE in a window of its own (--app) of a Chromium browser - Edge, Chrome, Brave,
// Chromium, Vivaldi: an app window without the tabs and the address bar of the browser - else in the
// default browser, which has no app windows (Firefox).
//
// The window has a profile of its own (profileDir): not the tabs, the session, the extensions and the
// storage of the browser the user browses with, and a browser process of its own - it ends with the last
// window of the IDE. closed (when not nil) is closed then; a process that ends at once handed the window to
// one that runs already (a second start, or a window left open): that one is not waited for.
func openWindow(url string, closed chan<- struct{}) {
	for _, b := range chromium() {
		args := []string{"--app=" + url, "--new-window"}
		if dir := profileDir(); dir != "" {
			args = append(args, "--user-data-dir="+dir, "--no-first-run", "--no-default-browser-check")
		}
		cmd := exec.Command(b, args...)
		if err := cmd.Start(); err == nil {
			go func() {
				start := time.Now()
				cmd.Wait()
				if closed != nil && time.Since(start) > handOff {
					close(closed)
				}
			}()
			return
		}
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		fmt.Printf("open %s in Chrome or Edge\n", url)
		return
	}
	go cmd.Wait()
}

// handOff: a browser process that ends sooner gave its window to one of the profile that runs already
const handOff = 3 * time.Second

// profileDir: the browser profile of the IDE's windows, ~/.nerdsuite/browser (next to the settings); "" -
// no home: the profile of the browser
func profileDir() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	dir := filepath.Join(home, ".nerdsuite", "browser")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return ""
	}
	return dir
}

// chromium: the Chromium browsers of this computer, the ones to try first
func chromium() []string {
	var list []string
	exists := func(p string) bool { st, err := os.Stat(p); return err == nil && !st.IsDir() }
	switch runtime.GOOS {
	case "windows":
		for _, base := range []string{os.Getenv("ProgramFiles(x86)"), os.Getenv("ProgramFiles"), os.Getenv("LocalAppData")} {
			if base == "" {
				continue
			}
			for _, p := range []string{`Microsoft\Edge\Application\msedge.exe`, `Google\Chrome\Application\chrome.exe`, `BraveSoftware\Brave-Browser\Application\brave.exe`,
				`Chromium\Application\chrome.exe`, `Vivaldi\Application\vivaldi.exe`} {
				if f := filepath.Join(base, p); exists(f) {
					list = append(list, f)
				}
			}
		}
	case "darwin":
		for _, p := range []string{"Google Chrome.app/Contents/MacOS/Google Chrome", "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"Brave Browser.app/Contents/MacOS/Brave Browser", "Chromium.app/Contents/MacOS/Chromium", "Vivaldi.app/Contents/MacOS/Vivaldi"} {
			for _, dir := range []string{"/Applications", filepath.Join(os.Getenv("HOME"), "Applications")} {
				if f := filepath.Join(dir, p); exists(f) {
					list = append(list, f)
				}
			}
		}
	default:
		for _, n := range []string{"google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable",
			"brave-browser", "brave-browser-stable", "brave", "vivaldi-stable", "vivaldi"} {
			if f, err := exec.LookPath(n); err == nil {
				list = append(list, f)
			}
		}
		// not on the PATH: installed under /opt, as a snap, or as a flatpak (its launcher takes the
		// arguments of the browser)
		home := os.Getenv("HOME")
		for _, f := range []string{"/opt/google/chrome/chrome", "/opt/microsoft/msedge/msedge", "/opt/brave.com/brave/brave", "/opt/vivaldi/vivaldi",
			"/snap/bin/chromium", "/snap/bin/brave"} {
			if exists(f) {
				list = append(list, f)
			}
		}
		for _, dir := range []string{"/var/lib/flatpak/exports/bin", filepath.Join(home, ".local/share/flatpak/exports/bin")} {
			for _, id := range []string{"com.google.Chrome", "org.chromium.Chromium", "com.brave.Browser", "com.microsoft.Edge", "com.vivaldi.Vivaldi", "io.github.ungoogled_software.ungoogled_chromium"} {
				if f := filepath.Join(dir, id); exists(f) {
					list = append(list, f)
				}
			}
		}
	}
	return list
}
