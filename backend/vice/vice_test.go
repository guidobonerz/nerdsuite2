package vice

// The tests of the bridge and its HTTP API (test/vice.test.js). The run of the JS test drives the
// API end to end: against a fake VICE always - a listener speaking the binary monitor protocol, with
// a CPU that knows the few instructions of the test program - and against a real x64sc with
// VICE_TEST=1.

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"nerdsuite/backend/core"
)

// *=$0801
// 10 SYS2061
// $080D  JSR $0814
// $0810  JMP $080D
// $0813  NOP
// $0814  INC $D020
// $0817  INX
// $0818  RTS
var testPRG = []byte{
	0x01, 0x08,
	0x0b, 0x08, 0x0a, 0x00, 0x9e, 0x32, 0x30, 0x36, 0x31, 0x00, 0x00, 0x00,
	0x20, 0x14, 0x08,
	0x4c, 0x0d, 0x08,
	0xea,
	0xee, 0x20, 0xd0,
	0xe8,
	0x60,
}

// ---------------------------------------------------------------- the fake VICE

// the registers of the fake: their ids and names
const (
	rA  = 0
	rX  = 1
	rY  = 2
	rPC = 3
	rSP = 4
	rFL = 5
)

var fakeRegNames = []struct {
	id, bits int
	name     string
}{{rPC, 16, "PC"}, {rA, 8, "A"}, {rX, 8, "X"}, {rY, 8, "Y"}, {rSP, 8, "SP"}, {rFL, 8, "FL"}}

type fakeCheckpoint struct {
	id                             uint32
	start, end                     int
	stop, enabled, temporary, cond bool
	op                             int
	hits                           uint32
}

// fakeVice: one emulator - its memory, its registers, its checkpoints, whether the CPU runs
type fakeVice struct {
	ln       net.Listener
	mu       sync.Mutex
	mem      [0x10000]byte
	reg      map[int]int
	running  bool
	loaded   bool // a program was started: before, the CPU stays where it is
	cps      map[uint32]*fakeCheckpoint
	nextCp   uint32
	conns    map[net.Conn]bool
	exitCh   chan exitEvent
	exitOnce sync.Once
}

func (f *fakeVice) end(code int, signal *string) {
	f.exitOnce.Do(func() {
		f.ln.Close()
		f.mu.Lock()
		for c := range f.conns {
			c.Close()
		}
		f.mu.Unlock()
		f.exitCh <- exitEvent{Code: code, Signal: signal}
	})
}

// dropConnections: the connections close, VICE stays (the bridge connects again)
func (f *fakeVice) dropConnections() {
	f.mu.Lock()
	defer f.mu.Unlock()
	for c := range f.conns {
		c.Close()
	}
}

// fakeSpawn: a spawnFunc starting a fake VICE on the port of -binarymonitoraddress
func fakeSpawn(started chan<- *fakeVice) spawnFunc {
	return func(exe string, args []string, out io.Writer) (*viceProc, error) {
		addr := ""
		for i, a := range args {
			if a == "-binarymonitoraddress" && i+1 < len(args) {
				addr = strings.TrimPrefix(args[i+1], "ip4://")
			}
		}
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			return nil, err
		}
		f := &fakeVice{ln: ln, reg: map[int]int{rSP: 0xf6, rFL: 0x20}, running: true, cps: map[uint32]*fakeCheckpoint{},
			nextCp: 1, conns: map[net.Conn]bool{}, exitCh: make(chan exitEvent, 1)}
		f.reg[rPC] = 0xe5cd
		fmt.Fprintf(out, "\x1b[1mVICE\x1b[0m fake started\r\nlistening on %s\n", addr)
		go func() {
			for {
				c, err := ln.Accept()
				if err != nil {
					return
				}
				f.mu.Lock()
				f.conns[c] = true
				f.mu.Unlock()
				go f.serve(c)
			}
		}()
		if started != nil {
			started <- f
		}
		sigterm := "SIGTERM"
		return &viceProc{
			wait: func() (int, *string) { e := <-f.exitCh; return e.Code, e.Signal },
			kill: func(force bool) { f.end(-1, &sigterm) },
			done: make(chan struct{}),
		}, nil
	}
}

func (f *fakeVice) serve(c net.Conn) {
	defer func() {
		f.mu.Lock()
		delete(f.conns, c)
		f.mu.Unlock()
		c.Close()
	}()
	var buf []byte
	chunk := make([]byte, 4096)
	for {
		n, err := c.Read(chunk)
		if err != nil {
			return
		}
		buf = append(buf, chunk[:n]...)
		for {
			req, ok := decodeRequest(buf)
			if !ok {
				break
			}
			body := append([]byte{}, req.body...)
			buf = buf[req.size:]
			f.mu.Lock()
			out, quit := f.handle(req.requestID, req.command, body)
			f.mu.Unlock()
			c.Write(out)
			if quit {
				f.end(0, nil)
				return
			}
		}
	}
}

func (f *fakeVice) regsBody() []byte {
	ids := []int{rA, rX, rY, rPC, rSP, rFL}
	b := u16(len(ids))
	for _, id := range ids {
		b = append(b, cat(u8(3), u8(id), u16(f.reg[id]))...)
	}
	return b
}

func (f *fakeVice) cpBody(cp *fakeCheckpoint, hit bool) []byte {
	return cat(u32(cp.id), boolb(hit), u16(cp.start), u16(cp.end), boolb(cp.stop), boolb(cp.enabled), u8(cp.op),
		boolb(cp.temporary), u32(cp.hits), u32(0), boolb(cp.cond), u8(0))
}

func ev(typ byte, body []byte) []byte { return encodeResponse(typ, eventRequestID, body, 0) }

// stopEvents: the registers and STOPPED
func (f *fakeVice) stopEvents() []byte {
	f.running = false
	return cat(ev(respRegisterInfo, f.regsBody()), ev(respStopped, u16(f.reg[rPC])))
}

func (f *fakeVice) push(v int) {
	f.mem[0x100+f.reg[rSP]] = byte(v)
	f.reg[rSP] = (f.reg[rSP] - 1) & 0xff
}

func (f *fakeVice) pull() int {
	f.reg[rSP] = (f.reg[rSP] + 1) & 0xff
	return int(f.mem[0x100+f.reg[rSP]])
}

// exec: one instruction; the opcode
func (f *fakeVice) exec() byte {
	pc := f.reg[rPC]
	op := f.mem[pc]
	abs := int(f.mem[(pc+1)&0xffff]) | int(f.mem[(pc+2)&0xffff])<<8
	switch op {
	case 0x20: // JSR
		ret := (pc + 2) & 0xffff
		f.push(ret >> 8)
		f.push(ret & 0xff)
		pc = abs
	case 0x60: // RTS
		lo := f.pull()
		pc = (lo | f.pull()<<8) + 1
	case 0x4c: // JMP
		pc = abs
	case 0xee: // INC abs
		f.mem[abs]++
		pc += 3
	case 0xe8: // INX
		f.reg[rX] = (f.reg[rX] + 1) & 0xff
		pc++
	default: // NOP and the rest
		pc++
	}
	f.reg[rPC] = pc & 0xffff
	return op
}

// run: the CPU runs until a checkpoint stops it (a while: then it keeps running where it is)
func (f *fakeVice) run() []byte {
	var out []byte
	for i := 0; i < 1000 && f.loaded; i++ {
		f.exec()
		pc := f.reg[rPC]
		for _, cp := range f.cps {
			if cp.enabled && cp.op&opExec != 0 && pc >= cp.start && pc <= cp.end {
				cp.hits++
				out = append(out, ev(respCheckpointInfo, f.cpBody(cp, true))...)
				if cp.stop {
					return append(out, f.stopEvents()...)
				}
			}
		}
	}
	return out
}

func (f *fakeVice) handle(id uint32, command byte, b []byte) (out []byte, quit bool) {
	resp := func(typ byte, body []byte) []byte { return encodeResponse(typ, id, body, 0) }
	fail := func(code byte) []byte { return encodeResponse(command, id, nil, code) }
	if f.running {
		out = f.stopEvents() // any command stops the CPU
	}
	resumed := func() []byte { f.running = true; return ev(respResumed, u16(f.reg[rPC])) }
	cpOf := func() *fakeCheckpoint { return f.cps[binary.LittleEndian.Uint32(b)] }
	switch command {
	case cmdPing, cmdKeyboardFeed, cmdJoyportSet, cmdUserportSet:
		out = append(out, resp(command, nil)...)
	case cmdViceInfo:
		out = append(out, resp(respViceInfo, unhex("04030a00000476b30000"))...)
	case cmdRegistersAvailable:
		body := u16(len(fakeRegNames))
		for _, r := range fakeRegNames {
			body = append(body, cat(u8(3+len(r.name)), u8(r.id), u8(r.bits), u8(len(r.name)), []byte(r.name))...)
		}
		out = append(out, resp(respRegistersAvailable, body)...)
	case cmdBanksAvailable:
		body := u16(2)
		for i, n := range []string{"default", "cpu"} {
			body = append(body, cat(u8(3+len(n)), u16(i), u8(len(n)), []byte(n))...)
		}
		out = append(out, resp(respBanksAvailable, body)...)
	case cmdRegistersGet:
		out = append(out, resp(respRegisterInfo, f.regsBody())...)
	case cmdRegistersSet:
		n := int(binary.LittleEndian.Uint16(b[1:]))
		o := 3
		for i := 0; i < n; i++ {
			f.reg[int(b[o+1])] = int(binary.LittleEndian.Uint16(b[o+2:]))
			o += int(b[o]) + 1
		}
		out = append(out, resp(respRegisterInfo, f.regsBody())...)
	case cmdMemoryGet:
		start, end := int(binary.LittleEndian.Uint16(b[1:])), int(binary.LittleEndian.Uint16(b[3:]))
		data := f.mem[start : end+1]
		out = append(out, resp(respMemoryGet, cat(u16(len(data)), data))...)
	case cmdMemorySet:
		start := int(binary.LittleEndian.Uint16(b[1:]))
		copy(f.mem[start:], b[8:])
		out = append(out, resp(command, nil)...)
	case cmdCheckpointSet:
		cp := &fakeCheckpoint{id: f.nextCp, start: int(binary.LittleEndian.Uint16(b)), end: int(binary.LittleEndian.Uint16(b[2:])),
			stop: b[4] != 0, enabled: b[5] != 0, op: int(b[6]), temporary: b[7] != 0}
		f.nextCp++
		f.cps[cp.id] = cp
		out = append(out, resp(respCheckpointInfo, f.cpBody(cp, false))...)
	case cmdCheckpointGet:
		if cp := cpOf(); cp != nil {
			out = append(out, resp(respCheckpointInfo, f.cpBody(cp, false))...)
		} else {
			out = append(out, fail(errObjectMissing)...)
		}
	case cmdCheckpointDelete:
		if cp := cpOf(); cp != nil {
			delete(f.cps, cp.id)
			out = append(out, resp(command, nil)...)
		} else {
			out = append(out, fail(errObjectMissing)...)
		}
	case cmdCheckpointToggle:
		if cp := cpOf(); cp != nil {
			cp.enabled = b[4] != 0
			out = append(out, resp(command, nil)...)
		} else {
			out = append(out, fail(errObjectMissing)...)
		}
	case cmdCheckpointList:
		for i := uint32(1); i < f.nextCp; i++ {
			if cp := f.cps[i]; cp != nil {
				out = append(out, resp(respCheckpointInfo, f.cpBody(cp, false))...)
			}
		}
		out = append(out, resp(respCheckpointList, u32(uint32(len(f.cps))))...)
	case cmdConditionSet:
		cp := cpOf()
		if cp == nil || strings.Contains(string(b[5:]), "bad") {
			out = append(out, fail(errInvalidParameter)...)
		} else {
			cp.cond = true
			out = append(out, resp(command, nil)...)
		}
	case cmdAdvanceInstructions:
		over, count := b[0] != 0, int(binary.LittleEndian.Uint16(b[1:]))
		out = append(out, resp(command, nil)...)
		out = append(out, resumed()...)
		for i := 0; i < count; i++ {
			if over && f.mem[f.reg[rPC]] == 0x20 {
				ret := f.reg[rPC] + 3
				for j := 0; j < 10000 && f.reg[rPC] != ret; j++ {
					f.exec()
				}
			} else {
				f.exec()
			}
		}
		out = append(out, f.stopEvents()...)
	case cmdExecuteUntilReturn:
		out = append(out, resp(command, nil)...)
		out = append(out, resumed()...)
		depth := 0
		for j := 0; j < 10000; j++ {
			op := f.exec()
			if op == 0x20 {
				depth++
			} else if op == 0x60 {
				if depth == 0 {
					break
				}
				depth--
			}
		}
		out = append(out, f.stopEvents()...)
	case cmdReset:
		out = append(out, resp(command, nil)...)
		f.reg[rPC] = 0xfce2
		out = append(out, resumed()...)
	case cmdAutostart:
		run := b[0] != 0
		name := string(b[4 : 4+int(b[3])])
		data, err := os.ReadFile(name)
		if err != nil || len(data) < 3 {
			return append(out, fail(errGeneralFailure)...), false
		}
		load := int(data[0]) | int(data[1])<<8
		copy(f.mem[load:], data[2:])
		f.loaded = true
		out = append(out, resp(command, nil)...)
		out = append(out, resumed()...)
		if i := bytes.IndexByte(data, 0x9e); run && i >= 0 { // SYS: where the program starts
			j := i + 1
			for j < len(data) && data[j] >= '0' && data[j] <= '9' {
				j++
			}
			sys, _ := strconv.Atoi(string(data[i+1 : j]))
			f.reg[rPC] = sys
			out = append(out, f.run()...)
		}
	case cmdDisplayGet:
		body := cat(u32(13), u16(4), u16(2), u16(1), u16(0), u16(2), u16(1), u8(8), u32(8), []byte{0, 1, 2, 3, 4, 5, 6, 7})
		out = append(out, resp(respDisplayGet, body)...)
	case cmdPaletteGet:
		body := u16(16)
		for i := 0; i < 16; i++ {
			body = append(body, 3, byte(i*16), byte(i*8), byte(i*4))
		}
		out = append(out, resp(respPaletteGet, body)...)
	case cmdExit:
		out = append(out, resp(command, nil)...)
		out = append(out, resumed()...)
		out = append(out, f.run()...)
	case cmdQuit:
		return append(out, resp(command, nil)...), true
	default:
		out = append(out, fail(errInvalidCommand)...)
	}
	return out, false
}

// ---------------------------------------------------------------- the client of the tests

// eventLog: the events of the stream, as they came
type eventLog struct {
	mu     sync.Mutex
	events []struct {
		event string
		data  map[string]any
	}
}

func (l *eventLog) len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.events)
}

// wait: the first event of a name since an index
func (l *eventLog) wait(t *testing.T, name string, timeout time.Duration, since int) map[string]any {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		l.mu.Lock()
		for _, e := range l.events[min(since, len(l.events)):] {
			if e.event == name {
				l.mu.Unlock()
				return e.data
			}
		}
		l.mu.Unlock()
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %s", name)
	return nil
}

func (l *eventLog) has(name string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, e := range l.events {
		if e.event == name {
			return true
		}
	}
	return false
}

// listen: the event stream of a server into a log; the retry line first
func listen(t *testing.T, base string) (*eventLog, func()) {
	t.Helper()
	req, _ := http.NewRequest("GET", base+"/api/vice/events", nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if ct := res.Header.Get("Content-Type"); ct != "text/event-stream; charset=utf-8" {
		t.Fatalf("content type %q", ct)
	}
	log := &eventLog{}
	first := make(chan string, 1)
	go func() {
		sc := bufio.NewScanner(res.Body)
		sc.Buffer(make([]byte, 1<<20), 1<<24)
		var block []string
		n := 0
		for sc.Scan() {
			line := sc.Text()
			if line != "" {
				block = append(block, line)
				continue
			}
			if n == 0 && len(block) > 0 {
				first <- block[0]
			}
			n++
			var event, data string
			for _, l := range block {
				if v, ok := strings.CutPrefix(l, "event: "); ok {
					event = v
				} else if v, ok := strings.CutPrefix(l, "data: "); ok {
					data = v
				}
			}
			block = nil
			if event != "" && data != "" {
				var d map[string]any
				json.Unmarshal([]byte(data), &d)
				log.mu.Lock()
				log.events = append(log.events, struct {
					event string
					data  map[string]any
				}{event, d})
				log.mu.Unlock()
			}
		}
	}()
	select {
	case l := <-first:
		if l != "retry: 2000" {
			t.Fatalf("first line %q", l)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no retry line")
	}
	return log, func() { res.Body.Close() }
}

type result struct {
	status int
	json   any
}

func (r result) obj() map[string]any { m, _ := r.json.(map[string]any); return m }
func (r result) arr() []any          { a, _ := r.json.([]any); return a }

func call(t *testing.T, base, method, path string, body any) result {
	t.Helper()
	var rd io.Reader
	if body != nil {
		var data []byte
		if s, ok := body.(string); ok {
			data = []byte(s)
		} else {
			data, _ = json.Marshal(body)
		}
		rd = bytes.NewReader(data)
	}
	req, _ := http.NewRequest(method, base+path, rd)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatalf("%s %s: no JSON: %q", method, path, data)
	}
	return result{res.StatusCode, v}
}

func num(v any) int { f, _ := v.(float64); return int(f) }

func check(t *testing.T, ok bool, format string, a ...any) {
	t.Helper()
	if !ok {
		t.Fatalf(format, a...)
	}
}

// testServer: the API behind a server; fake - with a fake VICE found in the folder of the settings
func testServer(t *testing.T, fake bool) (string, *API, chan *fakeVice) {
	t.Helper()
	dir := t.TempDir()
	st := core.NewSettings(filepath.Join(dir, "settings.json"))
	var started chan *fakeVice
	opts := bridgeOptions{}
	if fake {
		bin := filepath.Join(dir, "vice")
		os.MkdirAll(bin, 0o755)
		os.WriteFile(filepath.Join(bin, exeName("x64sc")), []byte("fake"), 0o755)
		d := st.Get()
		d.Paths["VICE"] = bin
		if err := st.Save(d); err != nil {
			t.Fatal(err)
		}
		started = make(chan *fakeVice, 4)
		opts.spawn = fakeSpawn(started)
		opts.connectTimeout = 5 * time.Second
	}
	api := newAPI(core.Env{Settings: st, TmpDir: filepath.Join(dir, "tmp")}, opts)
	srv := httptest.NewServer(api)
	t.Cleanup(func() {
		api.Close()
		srv.CloseClientConnections()
		srv.Close()
	})
	return srv.URL, api, started
}

// runFlow: the run of test/vice.test.js
func runFlow(t *testing.T, base string, real bool) {
	events, stop := listen(t, base)
	defer stop()

	r := call(t, base, "GET", "/api/vice/status", nil)
	check(t, r.status == 200, "status %d", r.status)
	check(t, r.obj()["available"] == true, "x64sc must be found: %v", r.json)
	check(t, r.obj()["running"] == false, "running: %v", r.json)

	r = call(t, base, "GET", "/api/vice/registers", nil)
	check(t, r.status == 409, "registers without VICE: %d", r.status)
	check(t, r.obj()["error"] == "VICE is not running", "error %v", r.json)

	r = call(t, base, "POST", "/api/vice/start", map[string]any{"machine": "c64", "args": []string{"-sounddev", "dummy", "-warp"}})
	check(t, r.status == 200, "start: %v", r.json)
	check(t, r.obj()["running"] == true, "running: %v", r.json)
	check(t, r.obj()["connected"] == true, "connected: %v", r.json)
	check(t, r.obj()["stopped"] == false, "stopped: %v", r.json)
	v, _ := r.obj()["version"].(string)
	check(t, strings.HasPrefix(v, "3."), "version %q", v)

	// checkpoint at the subroutine
	r = call(t, base, "POST", "/api/vice/checkpoints", map[string]any{"start": 0x0814})
	check(t, r.status == 200, "checkpoint: %v", r.json)
	cpID := num(r.obj()["id"])
	check(t, r.obj()["exec"] == true && r.obj()["stop"] == true, "checkpoint %v", r.json)
	r = call(t, base, "GET", "/api/vice/status", nil)
	check(t, r.obj()["stopped"] == false, "transient commands keep the emulator running")

	// let the KERNAL boot (warp) before autostarting
	if real {
		time.Sleep(1500 * time.Millisecond)
	}
	mark := events.len()
	r = call(t, base, "POST", "/api/vice/load", map[string]any{"name": "test.prg", "prg": base64.StdEncoding.EncodeToString(testPRG), "run": true})
	check(t, r.status == 200, "load: %v", r.json)
	stopped := events.wait(t, "stopped", 20*time.Second, mark)
	check(t, num(stopped["pc"]) == 0x0814, "stopped at %v", stopped)
	check(t, num(stopped["registers"].(map[string]any)["pc"]) == 0x0814, "registers %v", stopped)
	cpEv := events.wait(t, "checkpoint", time.Second, mark)
	check(t, num(cpEv["id"]) == cpID && num(cpEv["pc"]) == 0x0814, "checkpoint event %v", cpEv)

	r = call(t, base, "GET", "/api/vice/status", nil)
	check(t, r.obj()["stopped"] == true && num(r.obj()["pc"]) == 0x0814, "status %v", r.json)

	r = call(t, base, "GET", "/api/vice/registers", nil)
	check(t, r.status == 200, "registers %d", r.status)
	for _, k := range []string{"pc", "a", "x", "y", "sp", "fl"} {
		_, ok := r.obj()[k]
		check(t, ok, "register %s", k)
	}
	check(t, num(r.obj()["pc"]) == 0x0814, "pc %v", r.json)
	x0 := num(r.obj()["x"])

	r = call(t, base, "GET", "/api/vice/memory?start=2049&end=2072", nil)
	check(t, r.status == 200, "memory %v", r.json)
	data, _ := base64.StdEncoding.DecodeString(r.obj()["data"].(string))
	check(t, bytes.Equal(data, testPRG[2:]), "memory %x", data)

	r = call(t, base, "POST", "/api/vice/memory", map[string]any{"start": 0x0813, "data": base64.StdEncoding.EncodeToString([]byte{0xea})})
	check(t, r.obj()["ok"] == true, "memory write %v", r.json)

	r = call(t, base, "GET", "/api/vice/banks", nil)
	check(t, len(r.arr()) > 0, "banks %v", r.json)

	r = call(t, base, "GET", "/api/vice/checkpoints", nil)
	check(t, len(r.arr()) == 1, "checkpoints %v", r.json)
	check(t, num(r.arr()[0].(map[string]any)["hits"]) >= 1, "hits %v", r.json)

	// step INC $D020 -> $0817, then INX -> $0818
	r = call(t, base, "POST", "/api/vice/step", map[string]any{"count": 2})
	check(t, r.status == 200, "step %v", r.json)
	check(t, num(r.obj()["pc"]) == 0x0818, "step pc %v", r.json)
	check(t, num(r.obj()["registers"].(map[string]any)["x"]) == (x0+1)&0xff, "x %v", r.json)

	// RTS -> back in the main loop at $0810
	r = call(t, base, "POST", "/api/vice/return", nil)
	check(t, r.status == 200 && num(r.obj()["pc"]) == 0x0810, "return %v", r.json)

	// step (over) the JMP at $0810 -> $080D
	r = call(t, base, "POST", "/api/vice/step", map[string]any{"count": 1, "over": true})
	check(t, num(r.obj()["pc"]) == 0x080d, "step over %v", r.json)

	r = call(t, base, "POST", "/api/vice/registers", map[string]any{"a": 0x42})
	check(t, r.status == 200 && num(r.obj()["a"]) == 0x42, "set registers %v", r.json)

	r = call(t, base, "GET", "/api/vice/display", nil)
	check(t, r.status == 200, "display %v", r.json)
	w, h := num(r.obj()["width"]), num(r.obj()["height"])
	rgba, _ := base64.StdEncoding.DecodeString(r.obj()["rgba"].(string))
	check(t, w > 0 && h > 0 && len(rgba) == w*h*4, "display %dx%d, %d bytes", w, h, len(rgba))

	// disable checkpoint and continue -> keeps running
	r = call(t, base, "POST", fmt.Sprintf("/api/vice/checkpoints/%d", cpID), map[string]any{"enabled": false})
	check(t, r.obj()["enabled"] == false, "toggle %v", r.json)
	mark2 := events.len()
	r = call(t, base, "POST", "/api/vice/continue", nil)
	check(t, r.obj()["stopped"] == false, "continue %v", r.json)
	events.wait(t, "resumed", 3*time.Second, mark2)

	// transient read while running does not stop it
	r = call(t, base, "GET", "/api/vice/memory?start=53280&end=53280", nil)
	check(t, r.status == 200, "memory %v", r.json)
	r = call(t, base, "GET", "/api/vice/status", nil)
	check(t, r.obj()["stopped"] == false, "still running %v", r.json)

	// pause stops and stays stopped
	r = call(t, base, "POST", "/api/vice/pause", nil)
	check(t, r.status == 200, "pause %v", r.json)
	pc := num(r.obj()["pc"])
	check(t, pc == 0x080d || pc == 0x0810 || pc == 0x0814 || pc == 0x0817 || pc == 0x0818, "pc in program: %d", pc)
	time.Sleep(300 * time.Millisecond)
	r = call(t, base, "GET", "/api/vice/status", nil)
	check(t, r.obj()["stopped"] == true, "paused %v", r.json)

	r = call(t, base, "DELETE", fmt.Sprintf("/api/vice/checkpoints/%d", cpID), nil)
	check(t, r.obj()["ok"] == true, "delete %v", r.json)
	r = call(t, base, "DELETE", fmt.Sprintf("/api/vice/checkpoints/%d", cpID), nil)
	check(t, r.status == 404, "delete again %d %v", r.status, r.json)

	r = call(t, base, "POST", "/api/vice/continue", nil)
	check(t, r.obj()["stopped"] == false, "continue %v", r.json)

	r = call(t, base, "POST", "/api/vice/keyboard", map[string]any{"text": "x"})
	check(t, r.obj()["ok"] == true, "keyboard %v", r.json)
	r = call(t, base, "POST", "/api/vice/joystick", map[string]any{"port": 2, "value": 16})
	check(t, r.obj()["ok"] == true, "joystick %v", r.json)

	r = call(t, base, "POST", "/api/vice/reset", map[string]any{"hard": false})
	check(t, r.status == 200, "reset %v", r.json)

	mark3 := events.len()
	r = call(t, base, "POST", "/api/vice/stop", nil)
	check(t, r.obj()["running"] == false, "stop %v", r.json)
	exit := events.wait(t, "exit", 5*time.Second, mark3)
	_, isNum := exit["code"].(float64)
	check(t, isNum, "exit code %v", exit)
}

// TestFlowFake: the run of the JS test against the fake VICE
func TestFlowFake(t *testing.T) {
	base, _, _ := testServer(t, true)
	runFlow(t, base, false)
}

// TestFlowVice: the run against a real x64sc (VICE_TEST=1)
func TestFlowVice(t *testing.T) {
	if os.Getenv("VICE_TEST") != "1" {
		t.Skip("set VICE_TEST=1 to run")
	}
	base, _, _ := testServer(t, false)
	runFlow(t, base, true)
}

// TestRequests: the checks of the values of the requests, the routes, the errors of VICE
func TestRequests(t *testing.T) {
	base, _, _ := testServer(t, true)

	r := call(t, base, "GET", "/api/vice/nothing", nil)
	check(t, r.status == 404 && r.obj()["error"] == "no route GET /api/vice/nothing", "%d %v", r.status, r.json)
	r = call(t, base, "GET", "/api/vicex", nil)
	check(t, r.status == 404 && r.obj()["error"] == "not found", "%d %v", r.status, r.json)
	r = call(t, base, "POST", "/api/vice/start", "{nope")
	check(t, r.status == 400 && r.obj()["error"] == "invalid JSON body", "%d %v", r.status, r.json)
	r = call(t, base, "POST", "/api/vice/start", map[string]any{"machine": "zx81"})
	check(t, r.status == 400 && r.obj()["error"] == "unknown machine 'zx81' (one of c64, c128, vic20, plus4, pet)", "%v", r.json)
	r = call(t, base, "POST", "/api/vice/start", map[string]any{"args": "-warp"})
	check(t, r.status == 400 && r.obj()["error"] == "'args' must be an array", "%v", r.json)
	r = call(t, base, "POST", "/api/vice/start", "null")
	check(t, r.status == 400 && r.obj()["error"] == "Cannot read properties of null (reading 'machine')", "%v", r.json)
	r = call(t, base, "POST", "/api/vice/start", map[string]any{"exe": "no-such-vice-anywhere"})
	check(t, r.status == 404 && r.obj()["error"] == "VICE executable for c64 not found", "%v", r.json)
	r = call(t, base, "POST", "/api/vice/pause", nil)
	check(t, r.status == 409 && r.obj()["error"] == "VICE is not running", "%v", r.json)
	r = call(t, base, "POST", "/api/vice/stop", nil)
	check(t, r.status == 200 && r.obj()["running"] == false, "%v", r.json)

	r = call(t, base, "POST", "/api/vice/start", nil)
	check(t, r.status == 200 && r.obj()["machine"] == "c64", "start %v", r.json)

	r = call(t, base, "GET", "/api/vice/memory?start=$0814&end=0x0810", nil)
	check(t, r.status == 400 && r.obj()["error"] == "'end' must be >= 'start'", "%v", r.json)
	r = call(t, base, "GET", "/api/vice/memory?start=70000", nil)
	check(t, r.status == 400 && r.obj()["error"] == "'start' must be an integer 0..65535", "%v", r.json)
	r = call(t, base, "GET", "/api/vice/memory?start=$c000", nil)
	check(t, r.status == 200 && num(r.obj()["end"]) == 0xc0ff, "%v", r.json)
	r = call(t, base, "POST", "/api/vice/memory", map[string]any{"data": "AA=="})
	check(t, r.status == 400 && r.obj()["error"] == "'start' is required", "%v", r.json)
	r = call(t, base, "POST", "/api/vice/memory", map[string]any{"start": 0xffff, "data": "AAA="})
	check(t, r.status == 400 && r.obj()["error"] == "data exceeds address space", "%v", r.json)
	r = call(t, base, "POST", "/api/vice/memory", map[string]any{"start": 1, "data": 5})
	check(t, r.status == 400 && r.obj()["error"] == "'data' must be a base64 string", "%v", r.json)
	r = call(t, base, "POST", "/api/vice/memory", map[string]any{"start": "4096", "data": "3q2+7w"})
	check(t, r.status == 200, "%v", r.json)
	r = call(t, base, "GET", "/api/vice/memory?start=4096&end=4099", nil)
	check(t, r.obj()["data"] == "3q2+7w==", "%v", r.json)

	r = call(t, base, "POST", "/api/vice/registers", map[string]any{"q": 1})
	check(t, r.status == 400 && r.obj()["error"] == "unknown register 'q'", "%v", r.json)
	r = call(t, base, "POST", "/api/vice/registers", map[string]any{"X": 1.5})
	check(t, r.status == 400 && r.obj()["error"] == "register 'X' needs an integer value", "%v", r.json)
	r = call(t, base, "POST", "/api/vice/registers", `{"Y": 7, "x": 3}`)
	check(t, r.status == 200 && num(r.obj()["y"]) == 7 && num(r.obj()["x"]) == 3, "%v", r.json)

	r = call(t, base, "POST", "/api/vice/checkpoints", map[string]any{"start": 0x1000, "exec": false})
	check(t, r.status == 400 && r.obj()["error"] == "one of exec/load/store must be true", "%v", r.json)
	r = call(t, base, "POST", "/api/vice/checkpoints", map[string]any{"start": 0x1000, "condition": "bad"})
	check(t, r.status == 400 && r.obj()["error"] == "invalid condition 'bad': VICE error 0x81 (invalid parameter) for command 0x22", "%v", r.json)
	r = call(t, base, "GET", "/api/vice/checkpoints", nil)
	check(t, len(r.arr()) == 0, "the checkpoint of a bad condition is deleted: %v", r.json)
	r = call(t, base, "POST", "/api/vice/checkpoints", map[string]any{"start": "$1000", "end": "0x1010", "store": "true", "exec": 0, "condition": "A == $10"})
	check(t, r.status == 200 && r.obj()["condition"] == "A == $10" && r.obj()["store"] == true && r.obj()["exec"] == false &&
		num(r.obj()["end"]) == 0x1010, "%v", r.json)
	id := num(r.obj()["id"])
	r = call(t, base, "PUT", fmt.Sprintf("/api/vice/checkpoints/%d", id), nil)
	check(t, r.status == 200 && r.obj()["enabled"] == true, "%v", r.json)
	r = call(t, base, "GET", fmt.Sprintf("/api/vice/checkpoints/%d", id), nil)
	check(t, r.status == 200 && r.obj()["condition"] == "A == $10", "%v", r.json)
	r = call(t, base, "GET", "/api/vice/checkpoints/99", nil)
	check(t, r.status == 404 && r.obj()["error"] == "VICE error 0x01 (object does not exist) for command 0x11", "%v", r.json)
	r = call(t, base, "GET", "/api/vice/checkpoints/99999999999", nil)
	check(t, r.status == 400 && r.obj()["error"] == "'id' must be an integer 0..4294967295", "%v", r.json)
	r = call(t, base, "PATCH", "/api/vice/checkpoints/1/", nil)
	check(t, r.status == 404, "%v", r.json) // the first checkpoint was deleted

	r = call(t, base, "POST", "/api/vice/step", map[string]any{"count": 0})
	check(t, r.status == 400 && r.obj()["error"] == "'count' must be an integer 1..65535", "%v", r.json)
	r = call(t, base, "POST", "/api/vice/keyboard", map[string]any{"text": 1})
	check(t, r.status == 400 && r.obj()["error"] == "'text' must be a string", "%v", r.json)
	r = call(t, base, "POST", "/api/vice/joystick", map[string]any{"port": 0})
	check(t, r.status == 400 && r.obj()["error"] == "'port' must be an integer 1..16", "%v", r.json)
	r = call(t, base, "POST", "/api/vice/load", map[string]any{"prg": "AQg="})
	check(t, r.status == 400 && r.obj()["error"] == "'prg' must contain a load address and data", "%v", r.json)
}

// TestReconnect: the connection drops, VICE runs on - the bridge connects again
func TestReconnect(t *testing.T) {
	base, _, started := testServer(t, true)
	events, stop := listen(t, base)
	defer stop()
	r := call(t, base, "POST", "/api/vice/start", nil)
	check(t, r.status == 200, "start %v", r.json)
	f := <-started
	mark := events.len()
	f.dropConnections()
	deadline := time.Now().Add(5 * time.Second)
	for {
		r = call(t, base, "GET", "/api/vice/status", nil)
		if r.obj()["connected"] == true && events.len() > mark {
			break
		}
		check(t, time.Now().Before(deadline), "not connected again: %v", r.json)
		time.Sleep(50 * time.Millisecond)
	}
	check(t, events.has("log"), "the log of the reconnect")
	r = call(t, base, "GET", "/api/vice/registers", nil)
	check(t, r.status == 200, "registers after the reconnect %v", r.json)
}

// TestCloseEndsStreams: Close ends the event streams and stops VICE
func TestCloseEndsStreams(t *testing.T) {
	base, api, _ := testServer(t, true)
	r := call(t, base, "POST", "/api/vice/start", nil)
	check(t, r.status == 200, "start %v", r.json)
	res, err := http.Get(base + "/api/vice/events")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	done := make(chan struct{})
	go func() { io.Copy(io.Discard, res.Body); close(done) }()
	api.Close()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the stream did not end")
	}
	check(t, !api.vice.running(), "VICE still runs")
}

func TestFindExecutable(t *testing.T) {
	dir := t.TempDir()
	st := core.NewSettings(filepath.Join(dir, "settings.json"))
	if _, err := FindExecutable(st, "zx81"); err == nil || err.Error() != "unknown machine 'zx81'" {
		t.Fatalf("unknown machine: %v", err)
	}
	bin := filepath.Join(dir, "bin")
	os.MkdirAll(bin, 0o755)
	exe := filepath.Join(bin, exeName("xvic"))
	os.WriteFile(exe, []byte("x"), 0o755)
	d := st.Get()
	d.Paths["VICE"] = exe // a file of the folder: its folder
	st.Save(d)
	p, err := FindExecutable(st, "vic20")
	check(t, err == nil && p == exe, "found %q %v", p, err)
	p, _ = findExecutable(st, "vic20", bin) // a folder given
	check(t, p == exe, "folder %q", p)
	p, _ = findExecutable(st, "vic20", exe) // a file given
	check(t, p == exe, "file %q", p)
}

func TestValues(t *testing.T) {
	n, err := toInt("$ff", "x", rng(0xffff))
	check(t, err == nil && n == 255, "$ff: %d %v", n, err)
	n, _ = toInt(" 12 ", "x", rng(0xffff))
	check(t, n == 12, " 12 : %d", n)
	_, err = toInt("12abc", "x", rng(0xffff))
	check(t, err != nil && err.Error() == "'x' must be an integer 0..65535", "12abc: %v", err)
	_, err = toInt(true, "x", rng(0xffff))
	check(t, err != nil, "true is no number")
	check(t, flag("true", false) && flag(1.0, false) && !flag("yes", true) && flag(nil, true) && flag("", true), "flags")
	check(t, bytes.Equal(decodeBase64("3q2-7w"), []byte{0xde, 0xad, 0xbe, 0xef}), "base64url")
	check(t, jsString(3.0) == "3" && jsString([]any{"a", 1.0, nil}) == "a,1," && jsString(true) == "true", "jsString")
	o, err := parseBody([]byte(`{"b": 1, "2": 2, "a": 3, "1": 4}`))
	check(t, err == nil && strings.Join(o.keys, ",") == "1,2,b,a", "order %v %v", o.keys, err)
	check(t, safeName("ä😀.prg") == "___.prg", "safe name %q", safeName("ä😀.prg"))
	check(t, toU16(-1) == 0xffff && toU16(65537) == 1, "u16")
}
