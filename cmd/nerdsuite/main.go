// nerdsuite: the IDE for 8 bit machines - its server with the IDE built in. It starts the server on
// this computer and opens the IDE in a window of its own: an app window of a Chromium browser (Edge,
// Chrome, Brave, Chromium, Vivaldi) without the tabs and the address bar of a browser (window.go).
//
// usage: nerdsuite [--port 3064] [--host 127.0.0.1] [--root .] [--no-browser] [--background]
//
//	--port        the port; one that is taken: the next free one of the 20 after it
//	--host        the address the server listens on (this computer only by default)
//	--root        serve public/ and examples/demo of a checkout instead of the files built in (development)
//	--no-browser  start the server only
//	--background  as a double click: no console window - it leaves the terminal (Linux, macOS), and the
//	              server ends a few minutes after the last window of the IDE is closed
//
// A double click (no arguments) is --background. The Windows binary is a program with windows
// (-H windowsgui, tools/dist.mjs): it opens no console window; started in a console it writes into that
// one (console_windows.go). A second start while one runs on the port opens a window of the running one.
//
// env: PORT, HOST, NERDSUITE_SETTINGS (the file of the settings), NERDSUITE_VERSION, and the variables of
// the tools (VICE, KICKASS, JAVA, ALTIRRA ...) the Settings of the IDE can set instead.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"syscall"
	"time"

	"nerdsuite"
	"nerdsuite/backend"
)

// version: the tag the binary was built for (-ldflags "-X main.version=v1.0"), else NERDSUITE_VERSION, else dev
var version = ""

// hasConsole: the output goes somewhere; false - a double click - errors are shown in a window
var hasConsole = true

// idleQuit: how long the server of a start without a console window waits after the IDE's last request
// (the IDE asks every idleQuit/5 while a window of it is open)
const idleQuit = 5 * time.Minute

// detachedEnv: set for the server a double click started in the background (Linux, macOS)
const detachedEnv = "NERDSUITE_DETACHED"

func main() {
	hasConsole = useConsole()
	if err := run(); err != nil {
		if hasConsole {
			fmt.Fprintln(os.Stderr, "nerdsuite:", err)
		} else {
			alert(err.Error())
		}
		os.Exit(1)
	}
}

func run() error {
	args := os.Args[1:]
	if len(args) == 0 {
		args = []string{"--background"} // a double click
	}
	defPort := 3064
	if p, err := strconv.Atoi(os.Getenv("PORT")); err == nil {
		defPort = p
	}
	defHost := os.Getenv("HOST")
	if defHost == "" {
		defHost = "127.0.0.1"
	}
	port := flag.Int("port", defPort, "the port of the IDE; a taken one: the next free one after it")
	host := flag.String("host", defHost, "the address the server listens on")
	root := flag.String("root", "", "serve public/ and examples/demo of this checkout instead of the files built in")
	noBrowser := flag.Bool("no-browser", false, "start the server only, open no window")
	background := flag.Bool("background", false, "as a double click: no console window - it leaves the terminal (Linux, macOS), and ends a few minutes after the IDE's last window")
	if err := flag.CommandLine.Parse(args); err != nil {
		return err
	}

	v := version
	if v == "" {
		v = os.Getenv("NERDSUITE_VERSION")
	}
	if v == "" {
		v = "dev"
	}

	// the files: of the checkout (--root), else the ones built in
	var public, examples fs.FS
	if *root != "" {
		public = os.DirFS(filepath.Join(*root, "public"))
		exampleDir := os.Getenv("EXAMPLE")
		if exampleDir == "" {
			exampleDir = filepath.Join(*root, "examples", "demo")
		}
		examples = os.DirFS(exampleDir)
	} else {
		var err error
		if public, err = fs.Sub(nerdsuite.Public, "public"); err != nil {
			return err
		}
		if examples, err = fs.Sub(nerdsuite.Examples, "examples/demo"); err != nil {
			return err
		}
	}

	// a nerdsuite answers there already (a second double click): a window of it only - the projects of
	// the IDE belong to its address
	if running(*port) {
		url := fmt.Sprintf("http://localhost:%d", *port)
		fmt.Printf("NerdSuite is running already: %s\n", url)
		if !*noBrowser {
			openWindow(url)
		}
		return nil
	}
	ln, err := listen(*host, *port)
	if err != nil {
		return err
	}
	// a double click on Linux or macOS opens a terminal: the server goes on without it, the terminal
	// closes with this process
	if *background && runtime.GOOS != "windows" && os.Getenv(detachedEnv) == "" && hasConsole {
		ln.Close()
		self, err := os.Executable()
		if err != nil {
			return err
		}
		cmd := exec.Command(self, args...)
		cmd.Env = append(os.Environ(), detachedEnv+"=1")
		detach(cmd)
		if err := cmd.Start(); err != nil {
			return err
		}
		fmt.Printf("NerdSuite %s: in the background\n", v)
		return nil
	}

	// without a console window there is none to close: the server ends after the IDE's last window
	var idle time.Duration
	if !*noBrowser && (*background || !hasConsole) {
		idle = idleQuit
	}
	srv := backend.New(backend.Options{Public: public, Examples: examples, Version: v, TmpDir: os.TempDir(), Idle: idle})
	defer srv.Close()
	if idle > 0 {
		go srv.QuitWhenIdle()
	}

	url := fmt.Sprintf("http://localhost:%d", ln.Addr().(*net.TCPAddr).Port)
	fmt.Printf("NerdSuite %s: %s\n", v, url)
	if idle > 0 {
		fmt.Printf("the IDE ends %v after its last window is closed\n", idleQuit)
	}
	if !*noBrowser {
		openWindow(url)
	}

	hs := &http.Server{Handler: srv, ReadHeaderTimeout: 10 * time.Second}
	done := make(chan error, 1)
	go func() { done <- hs.Serve(ln) }()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	select {
	case err := <-done:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-stop:
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		hs.Shutdown(ctx)
	}
	return nil
}

// listen: the port asked for, else - when it is taken - the next free one of the 20 after it, else one
// the system picks
func listen(host string, port int) (net.Listener, error) {
	for tries := 0; tries <= 20; tries++ {
		ln, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port+tries)))
		if err == nil {
			return ln, nil
		}
		fmt.Printf("Port %d is in use, trying %d\n", port+tries, port+tries+1)
	}
	return net.Listen("tcp", net.JoinHostPort(host, "0"))
}
