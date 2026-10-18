// nerdsuite: the IDE for 8 bit machines - its server with the IDE built in. It starts the server on
// this computer and opens the IDE in the browser.
//
// usage: nerdsuite [--port 3064] [--host 127.0.0.1] [--root .] [--no-browser]
//
//	--port        the port; one that is taken: the next free one of the 20 after it
//	--host        the address the server listens on (this computer only by default)
//	--root        serve public/ and examples/demo of a checkout instead of the files built in (development)
//	--no-browser  start the server only
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

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "nerdsuite:", err)
		os.Exit(1)
	}
}

func run() error {
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
	noBrowser := flag.Bool("no-browser", false, "start the server only, open no browser")
	flag.Parse()

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

	srv := backend.New(backend.Options{Public: public, Examples: examples, Version: v, TmpDir: os.TempDir()})
	defer srv.Close()

	ln, err := listen(*host, *port)
	if err != nil {
		return err
	}
	url := fmt.Sprintf("http://localhost:%d", ln.Addr().(*net.TCPAddr).Port)
	fmt.Printf("NerdSuite %s: %s\n", v, url)
	if !*noBrowser {
		openBrowser(url)
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

// openBrowser: the IDE in the browser of the system
func openBrowser(url string) {
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
		fmt.Printf("open %s in the browser\n", url)
		return
	}
	go cmd.Wait()
}
