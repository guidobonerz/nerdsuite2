package mimic

// The bridge and the API against a fake mimic speaking the debug protocol (JSON lines), and - only with
// MIMIC_TEST=1 - against the real mimic-headless (~/applications/mimic, else MIMIC).

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"nerdsuite/backend/core"
)

// fakeMimic: one machine - its memory, its registers, its breakpoints, whether it runs
type fakeMimic struct {
	ln, preview net.Listener
	mu          sync.Mutex
	machine     string
	mem         []byte
	cmds        []string // the commands, in their order
	reg         map[string]int
	running     bool
	bps         map[uint32]map[string]any
	nextBP      uint32
	inserted    string
	conns       []net.Conn
	writeMu     sync.Mutex
	done        chan struct{}
	once        sync.Once
}

func (f *fakeMimic) end() {
	f.once.Do(func() {
		f.ln.Close()
		f.preview.Close()
		f.mu.Lock()
		for _, c := range f.conns {
			c.Close()
		}
		f.mu.Unlock()
		close(f.done)
	})
}

func (f *fakeMimic) send(v any) {
	line, _ := json.Marshal(v)
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	f.mu.Lock()
	conns := append([]net.Conn{}, f.conns...)
	f.mu.Unlock()
	for _, c := range conns {
		c.Write(append(line, '\n'))
	}
}

// hit: the CPU runs into breakpoint bp at pc
func (f *fakeMimic) hit(bp uint32, pc int) {
	f.mu.Lock()
	f.running = false
	f.reg["PC"] = pc
	f.mu.Unlock()
	f.send(map[string]any{"event": "stopped", "pc": pc, "reason": map[string]any{"kind": "breakpoint", "bp": bp, "hits": 1}})
}

func argOf(args []string, name string) string {
	for i, a := range args {
		if a == name && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

// fakeSpawn: a spawnFunc starting a fake mimic on the ports of --debug and --preview
func fakeSpawn(started chan<- *fakeMimic) spawnFunc {
	return func(exe string, args []string, out io.Writer) (*proc, error) {
		ln, err := net.Listen("tcp", argOf(args, "--debug"))
		if err != nil {
			return nil, err
		}
		pv, err := net.Listen("tcp", argOf(args, "--preview"))
		if err != nil {
			ln.Close()
			return nil, err
		}
		machine := argOf(args, "--machine")
		mem := make([]byte, 0x10000)
		if machine == "amiga" {
			mem = make([]byte, 0x1000000)
		}
		f := &fakeMimic{ln: ln, preview: pv, machine: machine, mem: mem, reg: map[string]int{"PC": 0xe5cd, "A": 0, "X": 0, "Y": 0, "S": 0xf6, "P": 0x24},
			running: true, bps: map[uint32]map[string]any{}, done: make(chan struct{})}
		fmt.Fprintf(out, "debug server for '%s' listening on %s\n", machine, argOf(args, "--debug"))
		go http.Serve(pv, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/stream" {
				// the raw stream: the handshake answered, the query sent, then an echo of what comes
				c, rw, err := w.(http.Hijacker).Hijack()
				if err != nil {
					return
				}
				defer c.Close()
				fmt.Fprintf(c, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Key: %s\r\n\r\n%s\n",
					r.Header.Get("Sec-WebSocket-Key"), r.URL.RawQuery)
				io.Copy(c, rw)
				return
			}
			img := image.NewRGBA(image.Rect(0, 0, 2, 1))
			img.Set(0, 0, color.RGBA{1, 2, 3, 255})
			img.Set(1, 0, color.RGBA{4, 5, 6, 255})
			w.Header().Set("Content-Type", "image/png")
			png.Encode(w, img)
		}))
		go func() {
			for {
				c, err := ln.Accept()
				if err != nil {
					return
				}
				f.mu.Lock()
				f.conns = append(f.conns, c)
				f.mu.Unlock()
				f.send(map[string]any{"event": "hello", "protocol": "mimic-debug", "version": 7, "machine": machine})
				go f.serve(c)
			}
		}()
		if started != nil {
			started <- f
		}
		return &proc{done: make(chan struct{}), kill: f.end, wait: func() int { <-f.done; return 0 }}, nil
	}
}

func (f *fakeMimic) serve(c net.Conn) {
	r := bufio.NewReader(c)
	for {
		line, err := r.ReadBytes('\n')
		if err != nil {
			return
		}
		var req map[string]any
		json.Unmarshal(line, &req)
		id := req["id"]
		result, events, e := f.handle(req)
		if e != "" {
			f.send(map[string]any{"id": id, "ok": false, "error": e})
		} else {
			f.send(map[string]any{"id": id, "ok": true, "result": result})
		}
		for _, ev := range events {
			f.send(ev)
		}
	}
}

func (f *fakeMimic) state() map[string]any {
	return map[string]any{"reason": map[string]any{"kind": "step_done"}, "pc": f.reg["PC"]}
}

func (f *fakeMimic) handle(req map[string]any) (any, []any, string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := func(k string) int { v, _ := req[k].(float64); return int(v) }
	f.cmds = append(f.cmds, fmt.Sprint(req["cmd"]))
	switch req["cmd"] {
	case "info":
		return map[string]any{"machine": "c64", "running": f.running, "devices": []string{"cpu", "drive8"},
			"memory_spaces": []any{map[string]any{"id": 0, "name": "cpu", "device": "cpu"}, map[string]any{"id": 1, "name": "ram", "device": "cpu"},
				map[string]any{"id": 3, "name": "drive8", "device": "drive8"}}}, nil, ""
	case "list_media_slots":
		if f.machine == "amiga" {
			return []any{map[string]any{"id": 0, "kind": "Disk", "name": "DF0:"}, map[string]any{"id": 1, "kind": "Disk", "name": "DF1:"}}, nil, ""
		}
		return []any{map[string]any{"id": 0, "kind": "Disk"}, map[string]any{"id": 1, "kind": "Program"}}, nil, ""
	case "regs":
		var list []any
		for _, name := range []string{"PC", "A", "X", "Y", "S", "P"} {
			list = append(list, map[string]any{"name": name, "value": f.reg[name], "bits": 8})
		}
		return map[string]any{"device": "cpu", "regs": list}, nil, ""
	case "set_reg":
		name, _ := req["name"].(string)
		if _, ok := f.reg[name]; !ok {
			return nil, nil, "unknown register '" + name + "'"
		}
		f.reg[name] = n("value")
		return map[string]any{}, nil, ""
	case "peek":
		list := []int{}
		for _, v := range f.mem[n("addr") : n("addr")+n("len")] {
			list = append(list, int(v))
		}
		return map[string]any{"bytes": list}, nil, ""
	case "poke":
		list, _ := req["bytes"].([]any)
		for i, v := range list {
			f.mem[n("addr")+i] = byte(v.(float64))
		}
		return map[string]any{}, nil, ""
	case "pause":
		was := f.running
		f.running = false
		if was {
			ev := f.state()
			ev["event"] = "stopped"
			return f.state(), []any{ev}, ""
		}
		return f.state(), nil, ""
	case "resume":
		f.running = true
		return map[string]any{"running": true}, []any{map[string]any{"event": "resumed", "pc": f.reg["PC"]}}, ""
	case "step_instr":
		f.running = false
		f.reg["PC"] += n("count")
		return f.state(), nil, ""
	case "step_over", "step_out":
		f.running = false
		f.reg["PC"] += 3
		ev := f.state()
		ev["event"] = "stopped"
		// the stop before the response, as mimic may send it
		return map[string]any{"running": true}, []any{map[string]any{"event": "resumed", "pc": f.reg["PC"] - 3}, ev}, ""
	case "reset":
		f.running = false
		f.reg["PC"] = 0xfce2
		return f.state(), nil, ""
	case "insert_media":
		if f.machine == "amiga" && n("slot") != 0 || f.machine != "amiga" && n("slot") != 1 {
			return nil, nil, "no program slot"
		}
		f.inserted, _ = req["path"].(string)
		return map[string]any{}, nil, ""
	case "break_add":
		if c, _ := req["condition"].(string); strings.Contains(c, "??") {
			return nil, nil, "bad condition"
		}
		id := f.nextBP
		f.nextBP++
		f.bps[id] = req
		return map[string]any{"bp": id}, nil, ""
	case "break_remove":
		delete(f.bps, uint32(n("bp")))
		return map[string]any{}, nil, ""
	case "break_enable":
		if f.bps[uint32(n("bp"))] == nil {
			return nil, nil, "no breakpoint"
		}
		f.bps[uint32(n("bp"))]["enabled"] = req["enabled"]
		return map[string]any{}, nil, ""
	case "input":
		return map[string]any{}, nil, ""
	}
	return nil, nil, fmt.Sprintf("unknown command %v", req["cmd"])
}

// TestFlowFakeAmiga: an ADF into DF0:, then a hard reset; the 24-bit addresses and the 32-bit registers
func TestFlowFakeAmiga(t *testing.T) {
	_, srv, f, _ := newFakeMachine(t, "amiga")
	do(t, srv, "POST", "/api/mimic/load", `{"name":"x.adf","format":"adf","data":"AAAA"}`, 400) // not 880 KB
	do(t, srv, "POST", "/api/mimic/load", `{"name":"x.prg","prg":"AQgA"}`, 400)
	f.mu.Lock()
	f.cmds = nil
	f.mu.Unlock()
	adf := base64.StdEncoding.EncodeToString(make([]byte, adfSize))
	do(t, srv, "POST", "/api/mimic/load", `{"name":"demo.adf","format":"adf","data":"`+adf+`"}`, 200)
	f.mu.Lock()
	cmds, inserted := strings.Join(f.cmds, " "), f.inserted
	f.mu.Unlock()
	if cmds != "insert_media reset resume" || !strings.HasSuffix(inserted, "demo.adf") {
		t.Fatalf("commands %q, inserted %q", cmds, inserted)
	}
	if fi, err := os.Stat(inserted); err != nil || fi.Size() != adfSize {
		t.Fatalf("the ADF: %v %v", fi, err)
	}

	do(t, srv, "POST", "/api/mimic/memory", `{"start":"$c00000","data":"KgE="}`, 200)
	if v := do(t, srv, "GET", "/api/mimic/memory?start=$c00000&end=$c00001", ``, 200); v["data"] != "KgE=" {
		t.Fatalf("memory: %v", v)
	}
	do(t, srv, "GET", "/api/mimic/memory?start=$1000000", ``, 400)
	do(t, srv, "GET", "/api/mimic/memory?start=0&end=$10000", ``, 400) // more than 64 KB
	do(t, srv, "POST", "/api/mimic/memory", `{"start":"$ffffff","data":"KgE="}`, 400)
	cp := do(t, srv, "POST", "/api/mimic/checkpoints", `{"start":"$fc0010","exec":true}`, 200)
	if cp["start"] != float64(0xfc0010) {
		t.Fatalf("checkpoint: %v", cp)
	}
	f.mu.Lock()
	f.reg["D0"] = 0
	f.mu.Unlock()
	do(t, srv, "POST", "/api/mimic/registers", `{"d0":"$deadbeef"}`, 200)
	f.mu.Lock()
	d0 := f.reg["D0"]
	f.mu.Unlock()
	if d0 != 0xdeadbeef {
		t.Fatalf("D0 %x", d0)
	}
}

// events: what the listener got, by name
type events struct {
	mu   sync.Mutex
	list []string
	data []any
}

func (e *events) add(name string, data any) {
	e.mu.Lock()
	e.list = append(e.list, name)
	e.data = append(e.data, data)
	e.mu.Unlock()
}

func (e *events) wait(t *testing.T, name string, from int) any {
	t.Helper()
	for t0 := time.Now(); time.Since(t0) < 3*time.Second; time.Sleep(10 * time.Millisecond) {
		e.mu.Lock()
		for i := from; i < len(e.list); i++ {
			if e.list[i] == name {
				d := e.data[i]
				e.mu.Unlock()
				return d
			}
		}
		e.mu.Unlock()
	}
	t.Fatalf("no %s event", name)
	return nil
}

func (e *events) count() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.list)
}

func newFake(t *testing.T) (*API, *httptest.Server, *fakeMimic, *events) {
	t.Helper()
	return newFakeMachine(t, "c64")
}

func newFakeMachine(t *testing.T, machine string) (*API, *httptest.Server, *fakeMimic, *events) {
	t.Helper()
	exe := filepath.Join(t.TempDir(), "mimic.exe")
	os.WriteFile(exe, nil, 0o755)
	st := core.NewSettings(filepath.Join(t.TempDir(), "settings.json"))
	d := st.Get()
	d.Paths["MIMIC"] = exe
	if err := st.Save(d); err != nil {
		t.Fatal(err)
	}
	started := make(chan *fakeMimic, 1)
	a := newAPI(core.Env{Settings: st, TmpDir: t.TempDir()}, bridgeOptions{spawn: fakeSpawn(started), stopTimeout: 2 * time.Second})
	ev := &events{}
	inner := a.b.listener
	a.b.listener = func(name string, data any) { ev.add(name, data); inner(name, data) }
	srv := httptest.NewServer(a)
	t.Cleanup(func() { srv.Close(); a.Close() })
	return a, srv, <-startAsync(t, srv, started, machine), ev
}

func startAsync(t *testing.T, srv *httptest.Server, started chan *fakeMimic, machine string) chan *fakeMimic {
	res := do(t, srv, "POST", "/api/mimic/start", fmt.Sprintf(`{"machine":%q}`, machine), 200)
	if res["running"] != true || res["machine"] != machine || res["version"] != "mimic-debug 7" {
		t.Fatalf("start: %v", res)
	}
	return started
}

func do(t *testing.T, srv *httptest.Server, method, path, body string, want int) map[string]any {
	t.Helper()
	req, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	if res.StatusCode != want {
		t.Fatalf("%s %s: %d %s (want %d)", method, path, res.StatusCode, data, want)
	}
	out := map[string]any{}
	if bytes.HasPrefix(bytes.TrimSpace(data), []byte("[")) {
		var list []any
		json.Unmarshal(data, &list)
		out["list"] = list
	} else {
		json.Unmarshal(data, &out)
	}
	return out
}

func TestStatusWithoutMimic(t *testing.T) {
	st := core.NewSettings(filepath.Join(t.TempDir(), "settings.json"))
	d := st.Get()
	d.Paths["MIMIC"] = filepath.Join(t.TempDir(), "missing", "mimic.exe")
	st.Save(d)
	a := newAPI(core.Env{Settings: st, TmpDir: t.TempDir()}, bridgeOptions{spawn: fakeSpawn(nil)})
	defer a.Close()
	if s := a.status(); s.Running {
		t.Fatalf("status: %+v", s)
	}
	srv := httptest.NewServer(a)
	defer srv.Close()
	do(t, srv, "POST", "/api/mimic/pause", ``, 409)
	do(t, srv, "POST", "/api/mimic/start", `{"machine":"amiga1200"}`, 400)
}

func TestFlowFake(t *testing.T) {
	a, srv, f, ev := newFake(t)

	// the registers by the names of the IDE
	r := do(t, srv, "GET", "/api/mimic/registers", ``, 200)
	if r["pc"] != float64(0xe5cd) || r["sp"] != float64(0xf6) || r["fl"] != float64(0x24) {
		t.Fatalf("registers: %v", r)
	}
	r = do(t, srv, "POST", "/api/mimic/registers", `{"a":"$10","fl":1}`, 200)
	if r["a"] != float64(0x10) || f.reg["P"] != 1 {
		t.Fatalf("set registers: %v %v", r, f.reg)
	}
	do(t, srv, "POST", "/api/mimic/registers", `{"q":1}`, 400)

	// the memory, in a bank
	do(t, srv, "POST", "/api/mimic/memory", `{"start":"$c000","data":"`+base64.StdEncoding.EncodeToString([]byte{1, 2, 3})+`"}`, 200)
	m := do(t, srv, "GET", "/api/mimic/memory?start=49152&end=49154&bank=1", ``, 200)
	if m["data"] != base64.StdEncoding.EncodeToString([]byte{1, 2, 3}) {
		t.Fatalf("memory: %v", m)
	}
	banks := do(t, srv, "GET", "/api/mimic/banks", ``, 200)["list"].([]any)
	if len(banks) != 2 || banks[1].(map[string]any)["name"] != "ram" {
		t.Fatalf("banks: %v", banks)
	}

	// pause: the stop as the answer, the stopped event for the listeners
	from := ev.count()
	s := do(t, srv, "POST", "/api/mimic/pause", ``, 200)
	if s["pc"] != float64(0xe5cd) || s["registers"].(map[string]any)["sp"] != float64(0xf6) {
		t.Fatalf("pause: %v", s)
	}
	ev.wait(t, "stopped", from)
	if !a.b.status().Stopped {
		t.Fatal("not stopped")
	}

	// step into (synchronous: the bridge reports the stop), over and out (the stop event)
	from = ev.count()
	s = do(t, srv, "POST", "/api/mimic/step", `{"count":2}`, 200)
	if s["pc"] != float64(0xe5cf) {
		t.Fatalf("step: %v", s)
	}
	ev.wait(t, "stopped", from)
	if s = do(t, srv, "POST", "/api/mimic/step", `{"over":true}`, 200); s["pc"] != float64(0xe5d2) {
		t.Fatalf("step over: %v", s)
	}
	if s = do(t, srv, "POST", "/api/mimic/return", ``, 200); s["pc"] != float64(0xe5d5) {
		t.Fatalf("step out: %v", s)
	}

	// checkpoints: an exec range is a breakpoint per address, a watchpoint one read and one write
	cp := do(t, srv, "POST", "/api/mimic/checkpoints", `{"start":"$0810","end":"$0812","exec":true}`, 200)
	if cp["id"] != float64(1) || len(f.bps) != 3 {
		t.Fatalf("checkpoint: %v %v", cp, f.bps)
	}
	w := do(t, srv, "POST", "/api/mimic/checkpoints", `{"start":"$d020","exec":false,"load":true,"store":true,"temporary":true,"condition":"A == $01"}`, 200)
	if w["condition"] != "A == $01" || len(f.bps) != 5 || f.bps[3]["kind"] != "read" || f.bps[4]["kind"] != "write" || f.bps[4]["condition"] != "A == $01" {
		t.Fatalf("watchpoint: %v %v", w, f.bps)
	}
	do(t, srv, "POST", "/api/mimic/checkpoints", `{"start":"$1000","condition":"??"}`, 400)
	if len(f.bps) != 5 {
		t.Fatalf("a failed checkpoint left breakpoints: %v", f.bps)
	}
	do(t, srv, "POST", "/api/mimic/checkpoints", `{"start":0,"end":300}`, 400)
	list := do(t, srv, "GET", "/api/mimic/checkpoints", ``, 200)["list"].([]any)
	if len(list) != 2 {
		t.Fatalf("checkpoints: %v", list)
	}
	if c := do(t, srv, "POST", "/api/mimic/checkpoints/1", `{"enabled":false}`, 200); c["enabled"] != false || f.bps[1]["enabled"] != false {
		t.Fatalf("toggle: %v", c)
	}

	// a breakpoint hit: checkpoint, stopped; the temporary one goes after its hit
	do(t, srv, "POST", "/api/mimic/continue", ``, 200)
	ev.wait(t, "resumed", 0)
	from = ev.count()
	f.hit(4, 0x0815)
	hit := ev.wait(t, "checkpoint", from).(checkpointEvent)
	if hit.ID != 2 || *hit.PC != 0x0815 || hit.Hits != 1 {
		t.Fatalf("hit: %+v", hit)
	}
	stop := ev.wait(t, "stopped", from).(stopInfo)
	if *stop.PC != 0x0815 {
		t.Fatalf("stopped: %+v", stop)
	}
	for t0 := time.Now(); len(f.bps) != 3 && time.Since(t0) < 2*time.Second; time.Sleep(10 * time.Millisecond) {
	}
	if len(f.bps) != 3 {
		t.Fatalf("the temporary checkpoint stays: %v", f.bps)
	}
	do(t, srv, "DELETE", "/api/mimic/checkpoints/1", ``, 200)
	do(t, srv, "DELETE", "/api/mimic/checkpoints/1", ``, 404)
	if len(f.bps) != 0 {
		t.Fatalf("breakpoints left: %v", f.bps)
	}

	// load: reset, the program into the program slot, run
	prg := base64.StdEncoding.EncodeToString([]byte{0x01, 0x08, 0x0b, 0x08})
	do(t, srv, "POST", "/api/mimic/load", `{"name":"../demo","prg":"`+prg+`"}`, 200)
	if filepath.Base(f.inserted) != "demo.prg" || !f.running {
		t.Fatalf("load: %q running %v", f.inserted, f.running)
	}
	data, _ := os.ReadFile(f.inserted)
	if !bytes.Equal(data, []byte{0x01, 0x08, 0x0b, 0x08}) {
		t.Fatalf("the program written: %v", data)
	}

	// the screen from the preview server, the joystick, no keyboard
	d := do(t, srv, "GET", "/api/mimic/display", ``, 200)
	if d["width"] != float64(2) || d["rgba"] != base64.StdEncoding.EncodeToString([]byte{1, 2, 3, 255, 4, 5, 6, 255}) {
		t.Fatalf("display: %v", d)
	}
	stream(t, srv)
	do(t, srv, "POST", "/api/mimic/joystick", `{"port":2,"value":17}`, 200)
	do(t, srv, "POST", "/api/mimic/keyboard", `{"text":"run"}`, 501)

	// stop: the process ends, exit and status follow
	from = ev.count()
	if s := do(t, srv, "POST", "/api/mimic/stop", ``, 200); s["running"] != false {
		t.Fatalf("stop: %v", s)
	}
	ev.wait(t, "exit", from)
}

// stream: /api/mimic/stream reaches the /stream of the preview server - the handshake, the parameters
// it knows, the bytes both ways
func stream(t *testing.T, srv *httptest.Server) {
	t.Helper()
	do(t, srv, "GET", "/api/mimic/stream", ``, 426)
	c, err := net.Dial("tcp", strings.TrimPrefix(srv.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(5 * time.Second))
	fmt.Fprintf(c, "GET /api/mimic/stream?fps=25&audio=1&x=y HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"+
		"Sec-WebSocket-Key: abc==\r\nSec-WebSocket-Version: 13\r\n\r\n")
	r := bufio.NewReader(c)
	res, err := http.ReadResponse(r, nil)
	if err != nil || res.StatusCode != 101 || res.Header.Get("X-Key") != "abc==" {
		t.Fatalf("stream handshake: %v %v", res, err)
	}
	if line, _ := r.ReadString('\n'); line != "fps=25\n" {
		t.Fatalf("stream parameters: %q", line)
	}
	c.Write([]byte("input\n"))
	if line, _ := r.ReadString('\n'); line != "input\n" {
		t.Fatalf("stream echo: %q", line)
	}
}

// TestFlowMimic: the real mimic-headless - MIMIC_TEST=1 go test ./backend/mimic/
func TestFlowMimic(t *testing.T) {
	if os.Getenv("MIMIC_TEST") != "1" {
		t.Skip("MIMIC_TEST=1 runs mimic-headless")
	}
	exe := filepath.Join(core.AppsDir(), "mimic", exeName("mimic-headless"))
	if v := os.Getenv("MIMIC"); v != "" {
		exe = v
	}
	st := core.NewSettings(filepath.Join(t.TempDir(), "settings.json"))
	a := newAPI(core.Env{Settings: st, TmpDir: t.TempDir()}, bridgeOptions{})
	ev := &events{}
	inner := a.b.listener
	a.b.listener = func(name string, data any) { ev.add(name, data); inner(name, data) }
	srv := httptest.NewServer(a)
	defer func() { srv.Close(); a.Close() }()
	exeJSON, _ := json.Marshal(exe)
	do(t, srv, "POST", "/api/mimic/start", `{"machine":"c64","exe":`+string(exeJSON)+`}`, 200)

	// 10 INC $D020 : JMP 10 as machine code at $0810 behind a SYS 2064 line
	prg := []byte{0x01, 0x08, 0x0b, 0x08, 0x0a, 0x00, 0x9e, 0x32, 0x30, 0x36, 0x34, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0xee, 0x20, 0xd0, 0x4c, 0x10, 0x08}
	do(t, srv, "POST", "/api/mimic/checkpoints", `{"start":"$0810","exec":true}`, 200)
	from := ev.count()
	do(t, srv, "POST", "/api/mimic/load", `{"name":"inc","prg":"`+base64.StdEncoding.EncodeToString(prg)+`"}`, 200)
	for t0 := time.Now(); time.Since(t0) < 20*time.Second; time.Sleep(50 * time.Millisecond) {
		if ev.count() > from && a.b.status().Stopped {
			break
		}
	}
	stop := ev.wait(t, "stopped", from).(stopInfo)
	if *stop.PC != 0x0810 {
		t.Fatalf("stopped at %+v", stop)
	}
	s := do(t, srv, "POST", "/api/mimic/step", `{"count":1}`, 200)
	if s["pc"] != float64(0x0813) {
		t.Fatalf("step: %v", s)
	}
	m := do(t, srv, "GET", "/api/mimic/memory?start=$0810&end=$0812", ``, 200)
	if m["data"] != base64.StdEncoding.EncodeToString([]byte{0xee, 0x20, 0xd0}) {
		t.Fatalf("memory: %v", m)
	}
	if d := do(t, srv, "GET", "/api/mimic/display", ``, 200); d["width"].(float64) < 300 {
		t.Fatalf("display: %v", d["width"])
	}
}

func TestCPCTyped(t *testing.T) {
	ev := cpcKeyboard.typed("Run\"a\r\n€")
	// R, U, N: down and up; " with SHIFT: 4; A: 2; RETURN: 2 - the € has no key
	if len(ev) != 6+4+2+2 {
		t.Fatalf("%d events: %v", len(ev), ev)
	}
	key := func(i int) (int, bool, int) {
		e := ev[i].(map[string]any)
		k := e["event"].(map[string]any)
		return k["key"].(int), k["down"].(bool), e["delay"].(int)
	}
	if k, down, at := key(0); k != cpcK(6, 2) || !down || at != 0 {
		t.Fatalf("R: %d %v %d", k, down, at)
	}
	step := cpcKeyboard.hold + cpcKeyboard.gap
	if k, down, at := key(6); k != cpcShift || !down || at != 3*step {
		t.Fatalf("SHIFT of \": %d %v %d", k, down, at)
	}
	if k, _, at := key(7); k != cpcK(8, 1) || at != 3*step+cpcKeyboard.lead {
		t.Fatalf("\": %d %d", k, at)
	}
	if k, _, _ := key(12); k != cpcReturn {
		t.Fatalf("RETURN: %d", k)
	}
}

// startReal: the real mimic-headless for a machine (MIMIC_TEST=1)
func startReal(t *testing.T, machine, model string) (*API, *httptest.Server, *events) {
	t.Helper()
	if os.Getenv("MIMIC_TEST") != "1" {
		t.Skip("MIMIC_TEST=1 runs mimic-headless")
	}
	exe := filepath.Join(core.AppsDir(), "mimic", exeName("mimic-headless"))
	if v := os.Getenv("MIMIC"); v != "" {
		exe = v
	}
	a := newAPI(core.Env{Settings: core.NewSettings(filepath.Join(t.TempDir(), "settings.json")), TmpDir: t.TempDir()}, bridgeOptions{})
	ev := &events{}
	inner := a.b.listener
	a.b.listener = func(name string, data any) { ev.add(name, data); inner(name, data) }
	srv := httptest.NewServer(a)
	t.Cleanup(func() { srv.Close(); a.Close() })
	exeJSON, _ := json.Marshal(exe)
	do(t, srv, "POST", "/api/mimic/start", fmt.Sprintf(`{"machine":%q,"model":%q,"exe":%s}`, machine, model, exeJSON), 200)
	return a, srv, ev
}

// waitStop: the next stop after from (20 s at most)
func waitStop(t *testing.T, a *API, ev *events, from int) stopInfo {
	t.Helper()
	for t0 := time.Now(); time.Since(t0) < 20*time.Second; time.Sleep(50 * time.Millisecond) {
		if a.b.status().Stopped && ev.count() > from {
			break
		}
	}
	return ev.wait(t, "stopped", from).(stopInfo)
}

func TestFlowMimicAtari(t *testing.T) {
	a, srv, ev := startReal(t, "atari800xl", "")
	// INC COLBK : JMP $2000 at $2000, RUNAD $2000
	xex := []byte{0xff, 0xff, 0x00, 0x20, 0x05, 0x20, 0xee, 0x1a, 0xd0, 0x4c, 0x00, 0x20, 0xe0, 0x02, 0xe1, 0x02, 0x00, 0x20}
	do(t, srv, "POST", "/api/mimic/checkpoints", `{"start":"$2000","exec":true}`, 200)
	from := ev.count()
	do(t, srv, "POST", "/api/mimic/load", `{"name":"inc","format":"xex","data":"`+base64.StdEncoding.EncodeToString(xex)+`"}`, 200)
	if stop := waitStop(t, a, ev, from); *stop.PC != 0x2000 {
		t.Fatalf("stopped at %+v", stop)
	}
	if s := do(t, srv, "POST", "/api/mimic/step", `{}`, 200); s["pc"] != float64(0x2003) {
		t.Fatalf("step: %v", s)
	}
	do(t, srv, "POST", "/api/mimic/load", `{"name":"x","format":"amsdos-bin","data":"AAAA"}`, 400)

	// an Atari BASIC listing after the .xex, in ATASCII as the build makes it: typed in after a cold start,
	// it pokes 42 to $0600 (and prints an inverse text)
	do(t, srv, "POST", "/api/mimic/checkpoints/1", `{"enabled":false}`, 200)
	bas := "5 PRINT \"\xc8\xc9\"\x9b10 POKE 1536,42\x9b20 GOTO 20\x9b"
	do(t, srv, "POST", "/api/mimic/load", `{"name":"poke.lst","format":"atascii-lst","data":"`+base64.StdEncoding.EncodeToString([]byte(bas))+`"}`, 200)
	want := base64.StdEncoding.EncodeToString([]byte{42})
	for t0 := time.Now(); time.Since(t0) < 30*time.Second; time.Sleep(250 * time.Millisecond) {
		if do(t, srv, "GET", "/api/mimic/memory?start=1536&end=1536", ``, 200)["data"] == want {
			return
		}
	}
	shot(t, a, "atari.png")
	t.Fatal("the BASIC listing did not run")
}

// TestStreamMimic: the raw stream of the real mimic through /api/mimic/stream - a key frame first, a paused
// frame when the CPU is stopped (MIMIC to a mimic-headless with /stream)
func TestStreamMimic(t *testing.T) {
	_, srv, ev := startReal(t, "c64", "")
	c, err := net.Dial("tcp", strings.TrimPrefix(srv.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(20 * time.Second))
	fmt.Fprintf(c, "GET /api/mimic/stream?fps=50 HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"+
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n")
	r := bufio.NewReader(c)
	if res, err := http.ReadResponse(r, nil); err != nil || res.StatusCode != 101 {
		t.Fatalf("stream handshake: %v %v", res, err)
	}
	// one binary message of the server (unmasked, not fragmented)
	next := func() []byte {
		t.Helper()
		var h [2]byte
		if _, err := io.ReadFull(r, h[:]); err != nil {
			t.Fatal(err)
		}
		n := int(h[1] & 0x7f)
		if n == 126 || n == 127 {
			ext := make([]byte, map[int]int{126: 2, 127: 8}[n])
			io.ReadFull(r, ext)
			n = 0
			for _, b := range ext {
				n = n<<8 | int(b)
			}
		}
		m := make([]byte, n)
		if _, err := io.ReadFull(r, m); err != nil {
			t.Fatal(err)
		}
		return m
	}
	m := next()
	if string(m[:4]) != "PTRV" || m[5]&1 == 0 || m[6] != 4 || int(m[20])|int(m[21])<<8 == 0 {
		t.Fatalf("the first message: % x", m[:32])
	}
	// the pixel aspect of the C64 (PAL), 16.16: ≈ 0.94
	if par := float64(binary.LittleEndian.Uint32(m[28:32])) / 65536; par < 0.9 || par > 0.97 {
		t.Fatalf("pixel aspect %v", par)
	}
	from := ev.count()
	do(t, srv, "POST", "/api/mimic/pause", ``, 200)
	ev.wait(t, "stopped", from)
	for i := 0; i < 100; i++ {
		if m = next(); string(m[:4]) == "PTRV" && m[5]&2 != 0 {
			return
		}
	}
	t.Fatal("no paused frame")
}

// TestFlowMimic2600: a 4 KB cartridge (INC $80 : JMP $F000) into the 2600 - the breakpoint, a step, the RAM
func TestFlowMimic2600(t *testing.T) {
	a, srv, ev := startReal(t, "atari2600", "")
	cart := make([]byte, 4096)
	copy(cart, []byte{0xe6, 0x80, 0x4c, 0x00, 0xf0})
	cart[0xffc], cart[0xffd] = 0x00, 0xf0 // RESET
	do(t, srv, "POST", "/api/mimic/load", `{"name":"x","prg":"AQgA"}`, 400)
	do(t, srv, "POST", "/api/mimic/checkpoints", `{"start":"$f002","exec":true}`, 200)
	from := ev.count()
	do(t, srv, "POST", "/api/mimic/load", `{"name":"inc.a26","format":"a26","data":"`+base64.StdEncoding.EncodeToString(cart)+`"}`, 200)
	if stop := waitStop(t, a, ev, from); *stop.PC != 0xf002 {
		t.Fatalf("stopped at %+v", stop)
	}
	ram := func() byte {
		b, _ := base64.StdEncoding.DecodeString(do(t, srv, "GET", "/api/mimic/memory?start=$80&end=$80", ``, 200)["data"].(string))
		return b[0]
	}
	before := ram()
	do(t, srv, "POST", "/api/mimic/step", `{}`, 200) // JMP
	if r := do(t, srv, "POST", "/api/mimic/step", `{}`, 200); r["pc"] != float64(0xf002) || ram() != before+1 {
		t.Fatalf("step: %v, $80 %d after %d", r, ram(), before)
	}
}

func TestFlowMimicCPC(t *testing.T) {
	a, srv, ev := startReal(t, "cpc", "6128")
	// INC A : JP $4000 at $4000 - a binary without a header, CALLed
	do(t, srv, "POST", "/api/mimic/checkpoints", `{"start":"$4000","exec":true}`, 200)
	from := ev.count()
	do(t, srv, "POST", "/api/mimic/load", `{"name":"inc.bin","format":"amsdos-bin","load":16384,"data":"`+base64.StdEncoding.EncodeToString([]byte{0x3c, 0xc3, 0x00, 0x40})+`"}`, 200)
	if stop := waitStop(t, a, ev, from); *stop.PC != 0x4000 {
		t.Fatalf("stopped at %+v", stop)
	}
	r := do(t, srv, "POST", "/api/mimic/step", `{}`, 200)
	regs := r["registers"].(map[string]any)
	if r["pc"] != float64(0x4001) || regs["sp"] == nil || regs["hl"] == nil && regs["h"] == nil || regs["f"] == nil {
		t.Fatalf("step: %v", r)
	}
	do(t, srv, "POST", "/api/mimic/registers", `{"a":"$41","sp":"$bf00"}`, 200)
	if v := do(t, srv, "GET", "/api/mimic/registers", ``, 200); v["a"] != float64(0x41) || v["sp"] != float64(0xbf00) {
		t.Fatalf("set registers: %v", v)
	}

	// a BASIC listing from a disc: it pokes 42 to &4000
	for _, c := range do(t, srv, "GET", "/api/mimic/checkpoints", ``, 200)["list"].([]any) {
		do(t, srv, "DELETE", fmt.Sprintf("/api/mimic/checkpoints/%v", c.(map[string]any)["id"]), ``, 200)
	}
	bas := "10 POKE &4000,42\r\n20 GOTO 20\r\n"
	do(t, srv, "POST", "/api/mimic/load", `{"name":"poke","format":"cpc-ascii","data":"`+base64.StdEncoding.EncodeToString([]byte(bas))+`"}`, 200)
	want := base64.StdEncoding.EncodeToString([]byte{42})
	for t0 := time.Now(); time.Since(t0) < 30*time.Second; time.Sleep(250 * time.Millisecond) {
		if do(t, srv, "GET", "/api/mimic/memory?start=$4000&end=$4000", ``, 200)["data"] == want {
			return
		}
	}
	shot(t, a, "cpc.png")
	t.Fatal("the BASIC program did not run")
}

// bootADF: an ADF whose bootblock runs code ("DOS" and a zero byte, the checksum, the root block 880, the code at 12)
func bootADF(code []byte) []byte {
	adf := make([]byte, adfSize)
	copy(adf, []byte{'D', 'O', 'S', 0})
	binary.BigEndian.PutUint32(adf[8:], 880)
	copy(adf[12:], code)
	var sum uint32
	for i := 0; i < 1024; i += 4 {
		x := binary.BigEndian.Uint32(adf[i:])
		if sum+x < sum {
			sum++
		}
		sum += x
	}
	binary.BigEndian.PutUint32(adf[4:], ^sum)
	return adf
}

// TestFlowMimicAmiga: a bootblock (COLOR00 red, then ADDQ.L #1,$70000 in a loop) from DF0: - the counter
// counts once Kickstart has booted it; a store checkpoint at a 24-bit address stops it in the loop; the 68000's
// registers
func TestFlowMimicAmiga(t *testing.T) {
	if exe := os.Getenv("MIMIC"); os.Getenv("MIMIC_TEST") == "1" {
		if exe == "" {
			exe = filepath.Join(core.AppsDir(), "mimic", exeName("mimic-headless"))
		}
		if data, err := os.ReadFile(exe); err == nil && !bytes.Contains(data, []byte("Commodore Amiga 500")) {
			t.Skip(exe + " predates the Amiga")
		}
	}
	a, srv, ev := startReal(t, "amiga", "pal")
	code := []byte{
		0x33, 0xfc, 0x0f, 0x00, 0x00, 0xdf, 0xf1, 0x80, // move.w #$0f00,$dff180
		0x41, 0xf9, 0x00, 0x07, 0x00, 0x00, // lea $70000,a0
		0x52, 0x90, // loop: addq.l #1,(a0)
		0x60, 0xfc, // bra.s loop
	}
	t0 := time.Now()
	do(t, srv, "POST", "/api/mimic/load", `{"name":"boot.adf","format":"adf","data":"`+base64.StdEncoding.EncodeToString(bootADF(code))+`"}`, 200)
	// Kickstart writes $70000 as well while it clears the memory: the stop that counts is the one in the RAM
	var stop stopInfo
	for {
		from := ev.count()
		cp := do(t, srv, "POST", "/api/mimic/checkpoints", `{"start":"$70000","end":"$70003","exec":false,"store":true}`, 200)
		stop = waitStop(t, a, ev, from)
		do(t, srv, "DELETE", fmt.Sprintf("/api/mimic/checkpoints/%v", cp["id"]), ``, 200)
		if *stop.PC < 0xf80000 {
			break
		}
		if time.Since(t0) > 30*time.Second {
			shot(t, a, "amiga.png")
			t.Fatalf("the bootblock did not run (still at $%x)", *stop.PC)
		}
		do(t, srv, "POST", "/api/mimic/continue", ``, 200)
		time.Sleep(200 * time.Millisecond)
	}
	t.Logf("the bootblock ran after %v", time.Since(t0))
	r := do(t, srv, "GET", "/api/mimic/registers", ``, 200)
	for _, n := range []string{"d0", "d7", "a0", "a7", "pc", "sr", "usp", "ssp"} {
		if r[n] == nil {
			t.Fatalf("no %s in %v", n, r)
		}
	}
	pc := int(r["pc"].(float64))
	m, _ := base64.StdEncoding.DecodeString(do(t, srv, "GET", fmt.Sprintf("/api/mimic/memory?start=%d&end=%d", pc-2, pc+1), ``, 200)["data"].(string))
	if r["a0"] != float64(0x70000) || !bytes.Contains(m, []byte{0x52, 0x90}) && !bytes.Contains(m, []byte{0x60, 0xfc}) {
		t.Fatalf("stopped at $%x (%x around it): %v", *stop.PC, m, r)
	}
	t.Logf("stopped at $%x, registers %v", pc, r)
	shot(t, a, "amiga.png")
}

// shot: the screen into MIMIC_SHOT (a folder), when it is set
func shot(t *testing.T, a *API, name string) {
	dir := os.Getenv("MIMIC_SHOT")
	if dir == "" {
		return
	}
	d, err := a.b.getDisplay()
	if err != nil {
		t.Log(err)
		return
	}
	img := &image.RGBA{Pix: d.rgba, Stride: d.width * 4, Rect: image.Rect(0, 0, d.width, d.height)}
	f, _ := os.Create(filepath.Join(dir, name))
	png.Encode(f, img)
	f.Close()
}

func TestAtasciiText(t *testing.T) {
	got := atasciiText([]byte{'1', '0', ' ', '?', '"', 0xc1, 'b', '"', 0x9b, 0x1c, '2', 0x9b})
	want := "10 ?\"\x01A\x01b\"\r2\r"
	if got != want {
		t.Fatalf("%q, want %q", got, want)
	}
}
