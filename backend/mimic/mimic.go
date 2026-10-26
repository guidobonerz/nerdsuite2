// Package mimic: the mimic emulator (C64, C128, VIC-20, Plus/4, C16, PET, Atari 800 XL, Atari 2600, Amstrad CPC,
// Amiga 500) and
// its own debug protocol - run and debug, as the IDE does it with VICE, but without VICE's binary monitor.
//
// mimic (c:\Users\guido\git\mimic, docs/usage.md) is started with
//
//	mimic.exe --machine c64 [--model 464] --rom-dir <its folder>\roms --debug 127.0.0.1:<port> --preview 127.0.0.1:<port>
//
// Programs: the Commodore machines take a .prg, the Atari a .xex into the program slot (mimic puts it into
// the RAM once the machine has booted - RUN for a BASIC program; the Atari loads it as DOS does and jumps to
// RUNAD); an Atari BASIC listing is typed in after a cold start into BASIC, then RUN. The CPC has no program slot: a binary is poked into the RAM once BASIC is up and started with
// CALL, a BASIC listing goes onto a disc in drive A (664, 6128) and is started with RUN"NAME - typed as key
// events of the CPC's keyboard matrix (input). The Atari 2600 takes an .a26 into its cartridge slot: inserting
// it powers the console up, the CPU starts at the RESET vector of the cartridge. The Amiga 500 boots an ADF
// from DF0: (a hard reset after the disk is in: Kickstart reads its bootblock and runs it); its 68000 has
// 24-bit addresses and 32-bit registers (d0-d7, a0-a7, pc, sr, usp, ssp).
//
// --debug serves the native protocol "mimic-debug" (version 7): TCP, a JSON object per line. A request is
// { id, cmd, ...fields }, its response { id, ok, result | error }; events have "event" instead of "id"
// (hello, resumed { pc }, stopped { reason, pc, beam }). --preview serves the picture (GET /snapshot.png)
// and the raw stream (WebSocket /stream: palette indices, only the lines that changed - passed through as
// /api/mimic/stream).
//
// Run-state behaviour (verified against mimic 6b1e902):
//   - The desktop program starts running; mimic-headless starts paused unless --run is given.
//   - pause stops a running machine: the response is the stop state and a stopped event follows.
//   - resume, step_over, step_out answer { running: true }, send resumed and later stopped (a step over
//     an instruction that calls nothing as well). The stopped event may come before the response.
//   - step_instr and reset are synchronous: the machine is stopped afterwards and no event is sent.
//   - peek and poke never stop the machine; break_* work while it runs.
//   - A breakpoint hit is a stopped event with reason { kind: "breakpoint", bp, hits }; a watchpoint
//     { kind: "watchpoint", bp, addr, write }; a jammed CPU { kind: "cpu_jam", pc }.
//
// The checkpoints of the IDE (an address range: exec, load, store, temporary, a condition) are kept here,
// each made of mimic breakpoints: one exec breakpoint per address, one read and one write watchpoint for
// the range.
//
// The locks: mu guards the state; opMu serializes the operations of the API; writeMu the lines sent. The
// listener of the events is called with mu held: it must not block and not call back into the bridge.
package mimic

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"

	"nerdsuite/backend/core"
)

// Commodore: the Commodore platforms of the IDE mimic runs - their ids are mimic's --machine ids
var Commodore = []string{"c64", "c128", "vic20", "plus4", "c16", "pet"}

// Machines: mimic's --machine ids the IDE starts (the Atari 400/800/XL/XE, the Atari 2600, the CPC, the Amiga
// and the ZX81 besides the Commodore ones)
var Machines = append(append([]string{}, Commodore...), "atari8", "atari2600", "cpc", "amiga", "zx81")

// machineAliases: older ids of mimic's machines - the Atari 8-bit was "atari800xl"
var machineAliases = map[string]string{"atari800xl": "atari8"}

// addrTop, valueTop: the highest address of the machine's CPU (the 68000 of the Amiga: 24 bits) and the
// highest value of its registers (the 68000: 32 bits)
func addrTop(machine string) int {
	if machine == "amiga" {
		return 0xffffff
	}
	return 0xffff
}

func valueTop(machine string) int {
	if machine == "amiga" {
		return 0xffffffff
	}
	return 0xffff
}

// Tool: where mimic is - the settings (key MIMIC: the program or its folder), else ~/applications/mimic,
// else the PATH. The desktop program (mimic.exe, built as mimic-desktop) has a window;
// mimic-headless works as well (no window, no sound)
var Tool = core.ToolDef{ID: "mimic", Name: "Mimic", Env: "MIMIC", Platforms: Machines,
	Dir: filepath.Join(core.AppsDir(), "mimic"), DirNames: []string{exeName("mimic"), exeName("mimic-desktop")},
	Path: []string{"mimic", "mimic-desktop"}}

func exeName(base string) string {
	if core.IsWindows {
		return base + ".exe"
	}
	return base
}

func knownMachine(m string) bool {
	for _, id := range Machines {
		if id == m {
			return true
		}
	}
	return false
}

// FindExecutable: mimic, or "" when it is not found
func FindExecutable(st *core.Settings) string { return core.ResolveExe(st, Tool) }

// romDir: the ROMs next to the program (roms\c64, roms\drives ...), or "" (then EMU_ROM_DIR or none)
func romDir(exe string) string {
	if d := filepath.Join(filepath.Dir(exe), "roms"); core.IsDir(d) {
		return d
	}
	return ""
}

func getFreePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// mErr: an error with the status of its answer
func mErr(status int, format string, a ...any) error { return core.Errorf(status, format, a...) }

// ---------------------------------------------------------------- the values of the events

// regKV, regs: the registers by name as the IDE names them (pc, a, x, y, sp, fl - VICE's names), in
// mimic's order - a JSON object
type regKV struct {
	name  string
	value int
}

type regs []regKV

func (r regs) get(name string) (int, bool) {
	for _, kv := range r {
		if kv.name == name {
			return kv.value, true
		}
	}
	return 0, false
}

func (r regs) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, kv := range r {
		if i > 0 {
			b.WriteByte(',')
		}
		k, _ := json.Marshal(kv.name)
		fmt.Fprintf(&b, "%s:%d", k, kv.value)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// ideName, mimicName: S and P of the 6502 are sp and fl in the IDE (as VICE names them); mimic takes SP
// for the 6502's S as well, so sp is SP for the Z80 and the 6502
func ideName(n string) string {
	switch n = strings.ToLower(n); n {
	case "s":
		return "sp"
	case "p":
		return "fl"
	}
	return n
}

func mimicName(n string) string {
	switch n = strings.ToLower(n); n {
	case "fl":
		return "P"
	}
	return strings.ToUpper(n)
}

type stopInfo struct {
	PC        *int `json:"pc"`
	Registers regs `json:"registers"`
}

type pcEvent struct {
	PC *int `json:"pc"`
}

type logEvent struct {
	Text string `json:"text"`
}

type exitEvent struct {
	Code   int     `json:"code"`
	Signal *string `json:"signal"`
}

// checkpoint: a checkpoint as the API shows it (the shape of /api/vice)
type checkpoint struct {
	ID        uint32  `json:"id"`
	Start     int     `json:"start"`
	End       int     `json:"end"`
	Stop      bool    `json:"stop"`
	Enabled   bool    `json:"enabled"`
	Exec      bool    `json:"exec"`
	Load      bool    `json:"load"`
	Store     bool    `json:"store"`
	Temporary bool    `json:"temporary"`
	Hits      uint32  `json:"hits"`
	Ignored   uint32  `json:"ignored"`
	Hit       bool    `json:"hit"`
	Memspace  int     `json:"memspace"`
	Condition *string `json:"condition"`

	bps   []uint32 // the breakpoints of mimic it is made of
	space int      // the memory space of mimic
}

type checkpointEvent struct {
	checkpoint
	PC *int `json:"pc"`
}

// status: the state of the emulator
type status struct {
	Running   bool    `json:"running"`
	Connected bool    `json:"connected"`
	Stopped   bool    `json:"stopped"`
	PC        *int    `json:"pc"`
	Machine   *string `json:"machine"`
	Version   *string `json:"version"`
	Exe       *string `json:"exe"`
}

// bank: a memory space of the main CPU
type bank struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

// displayFrame: the screen in RGBA
type displayFrame struct {
	width, height int
	rgba          []byte
}

func intp(v int) *int { return &v }
func strp(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// ---------------------------------------------------------------- the process

// proc: a started emulator. wait ends with it; kill ends it; done is closed when it has ended
type proc struct {
	wait func() int
	kill func()
	done chan struct{}
}

// spawnFunc: starts the emulator; out gets what it writes
type spawnFunc func(exe string, args []string, out io.Writer) (*proc, error)

func spawnProcess(exe string, args []string, out io.Writer) (*proc, error) {
	cmd := exec.Command(exe, args...)
	cmd.Dir = filepath.Dir(exe)
	cmd.Stdout = out
	cmd.Stderr = out
	cmd.WaitDelay = 2 * time.Second
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &proc{
		done: make(chan struct{}),
		kill: func() { cmd.Process.Kill() },
		wait: func() int {
			cmd.Wait()
			if cmd.ProcessState == nil {
				return -1
			}
			return cmd.ProcessState.ExitCode()
		},
	}, nil
}

var ansi = regexp.MustCompile(`\x1b\[[0-9;]*[A-Za-z]`)

// logWriter: the output of the emulator as log events, a line each
type logWriter struct{ b *bridge }

func (w *logWriter) Write(p []byte) (int, error) {
	w.b.mu.Lock()
	for _, line := range strings.Split(ansi.ReplaceAllString(string(p), ""), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			w.b.emit("log", logEvent{Text: line})
		}
	}
	w.b.mu.Unlock()
	return len(p), nil
}

// ---------------------------------------------------------------- the bridge

type bridgeOptions struct {
	requestTimeout time.Duration
	connectTimeout time.Duration
	stopTimeout    time.Duration
	spawn          spawnFunc
}

// reply: the response of a request
type reply struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result"`
	Error  string          `json:"error"`
	err    error
}

// message: a line of mimic - a response (id) or an event
type message struct {
	ID     *uint64         `json:"id"`
	Event  string          `json:"event"`
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result"`
	Error  string          `json:"error"`
	PC     *int            `json:"pc"`
	Reason *struct {
		Kind string  `json:"kind"`
		BP   *uint32 `json:"bp"`
		PC   *int    `json:"pc"`
	} `json:"reason"`
	Machine string `json:"machine"`
	Version int    `json:"version"`
}

type space struct {
	ID     int    `json:"id"`
	Name   string `json:"name"`
	Device string `json:"device"`
}

type bridge struct {
	st       *core.Settings
	opts     bridgeOptions
	listener func(event string, data any)

	opMu    sync.Mutex
	writeMu sync.Mutex
	mu      sync.Mutex

	proc        *proc
	exited      bool
	machine     string
	exe         string
	previewPort int

	conn      net.Conn
	connected bool
	hello     chan message
	events    chan message
	nextID    uint64
	pending   map[uint64]chan reply
	version   *string
	stopped   bool
	pc        *int
	spaces    []space
	waiters   []chan stopInfo
	cps       map[uint32]*checkpoint
	bpOf      map[uint32]uint32 // mimic breakpoint -> checkpoint
	nextCP    uint32
	slotProg  *int
	slotDisk  *int // drive A of the CPC, DF0: of the Amiga
	slotCart  *int // the cartridge of the 2600
	slotTape  *int // the tape of the ZX81 (a .P file, read by the LOAD trap)
}

func newBridge(st *core.Settings, opts bridgeOptions) *bridge {
	if opts.requestTimeout == 0 {
		opts.requestTimeout = 5 * time.Second
	}
	if opts.connectTimeout == 0 {
		opts.connectTimeout = 20 * time.Second
	}
	if opts.stopTimeout == 0 {
		opts.stopTimeout = 10 * time.Second
	}
	if opts.spawn == nil {
		opts.spawn = spawnProcess
	}
	b := &bridge{st: st, opts: opts}
	b.reset()
	return b
}

// reset: a new connection (mu held)
func (b *bridge) reset() {
	b.conn = nil
	b.connected = false
	b.pending = map[uint64]chan reply{}
	b.nextID = 1
	b.version = nil
	b.stopped = false
	b.pc = nil
	b.spaces = nil
	b.waiters = nil
	b.cps = map[uint32]*checkpoint{}
	b.bpOf = map[uint32]uint32{}
	b.nextCP = 1
	b.slotProg = nil
	b.slotDisk = nil
	b.slotCart = nil
	b.slotTape = nil
}

func (b *bridge) emit(event string, data any) {
	if b.listener != nil {
		b.listener(event, data)
	}
}

func (b *bridge) runningLocked() bool { return b.proc != nil && !b.exited }

func (b *bridge) running() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.runningLocked()
}

func (b *bridge) statusLocked() status {
	r := b.runningLocked()
	s := status{Running: r, Connected: b.connected, Version: b.version, Exe: strp(b.exe)}
	if r {
		s.Machine = strp(b.machine)
		s.PC = b.pc
		s.Stopped = b.connected && b.stopped
	}
	return s
}

func (b *bridge) status() status {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.statusLocked()
}

// ------------------------------------------------------------ lifecycle

// startOpts: the machine and its model ("" - mimic's default), a program instead of the one found, more
// arguments
type startOpts struct {
	machine string
	model   string
	exe     string
	args    []string
}

func (b *bridge) start(o startOpts) (status, error) {
	b.stop()
	if o.machine == "" {
		o.machine = "c64"
	}
	if !knownMachine(o.machine) {
		return status{}, mErr(400, "unknown machine '%s' (one of %s)", o.machine, strings.Join(Machines, ", "))
	}
	exe := o.exe
	if exe == "" {
		exe = FindExecutable(b.st)
	}
	if exe == "" {
		return status{}, mErr(404, "mimic not found: set MIMIC to mimic.exe or its folder")
	}
	debugPort, err := getFreePort()
	if err != nil {
		return status{}, err
	}
	previewPort, err := getFreePort()
	if err != nil {
		return status{}, err
	}
	args := []string{"--machine", o.machine}
	if o.model != "" {
		args = append(args, "--model", o.model)
	}
	if d := romDir(exe); d != "" {
		args = append(args, "--rom-dir", d)
	}
	args = append(args, "--debug", fmt.Sprintf("127.0.0.1:%d", debugPort), "--preview", fmt.Sprintf("127.0.0.1:%d", previewPort))
	if strings.Contains(strings.ToLower(filepath.Base(exe)), "headless") {
		args = append(args, "--run") // the desktop program runs from the start, mimic-headless only so
	}
	args = append(args, o.args...)

	b.mu.Lock()
	b.reset()
	b.exited = false
	b.machine = o.machine
	b.exe = exe
	b.previewPort = previewPort
	b.mu.Unlock()
	p, err := b.opts.spawn(exe, args, &logWriter{b})
	if err != nil {
		return status{}, mErr(500, "failed to start mimic: %v", err)
	}
	b.mu.Lock()
	b.proc = p
	b.mu.Unlock()
	go func() {
		code := p.wait()
		b.onExit(p, code)
	}()
	if err := b.connect(debugPort); err != nil {
		b.kill()
		return status{}, err
	}
	b.mu.Lock()
	b.emit("status", b.statusLocked())
	s := b.statusLocked()
	b.mu.Unlock()
	return s, nil
}

func (b *bridge) onExit(p *proc, code int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.proc == p {
		b.exited = true
		b.disconnect(mErr(409, "mimic exited"))
		b.proc = nil
		b.emit("exit", exitEvent{Code: code})
		b.emit("status", b.statusLocked())
	}
	close(p.done)
}

// connect: to the debug port, until the hello of mimic; then what the machine has
func (b *bridge) connect(port int) error {
	t0 := time.Now()
	last := "timeout"
	for time.Since(t0) < b.opts.connectTimeout {
		if !b.running() {
			return mErr(500, "mimic exited during startup")
		}
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 2*time.Second)
		if err != nil {
			last = err.Error()
			time.Sleep(200 * time.Millisecond)
			continue
		}
		hello := make(chan message, 1)
		events := make(chan message, 256)
		b.mu.Lock()
		b.conn, b.hello, b.events = conn, hello, events
		b.mu.Unlock()
		go b.readLoop(conn, hello, events)
		go b.eventLoop(events)
		select {
		case h := <-hello:
			if h.Machine != "" && h.Machine != b.machine {
				conn.Close()
				return mErr(500, "mimic runs a %s, not a %s", h.Machine, b.machine)
			}
			b.mu.Lock()
			b.connected = true
			b.version = strp(fmt.Sprintf("mimic-debug %d", h.Version))
			b.mu.Unlock()
			return b.handshake()
		case <-time.After(5 * time.Second):
			conn.Close()
			last = "no hello from mimic"
		}
	}
	return mErr(504, "cannot connect to mimic: %s", last)
}

func (b *bridge) handshake() error {
	var info struct {
		Running bool    `json:"running"`
		Spaces  []space `json:"memory_spaces"`
	}
	if err := b.call("info", nil, &info, 0); err != nil {
		return err
	}
	var slots []struct {
		ID   int    `json:"id"`
		Kind string `json:"kind"`
		Name string `json:"name"`
	}
	if err := b.call("list_media_slots", nil, &slots, 0); err != nil {
		return err
	}
	rs, err := b.readRegs()
	if err != nil {
		return err
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.spaces = info.Spaces
	b.stopped = !info.Running
	for _, s := range slots {
		if s.Kind == "Program" {
			b.slotProg = intp(s.ID)
		}
		if s.Kind == "Disk" && (s.Name == "drive A" || s.Name == "DF0:") {
			b.slotDisk = intp(s.ID)
		}
		if s.Kind == "Cartridge" && b.machine == "atari2600" {
			b.slotCart = intp(s.ID)
		}
		if s.Kind == "Tape" && b.machine == "zx81" {
			b.slotTape = intp(s.ID)
		}
	}
	if pc, ok := rs.get("pc"); ok {
		b.pc = intp(pc)
	}
	return nil
}

// stop: the emulator ends (mimic has no command for it: the process is ended)
func (b *bridge) stop() status {
	b.kill()
	return b.status()
}

func (b *bridge) kill() {
	b.mu.Lock()
	p := b.proc
	b.mu.Unlock()
	if p == nil {
		return
	}
	p.kill()
	select {
	case <-p.done:
	case <-time.After(5 * time.Second):
	}
}

// disconnect: the connection is gone (mu held) - the waiting requests fail
func (b *bridge) disconnect(err error) {
	if b.conn != nil {
		b.conn.Close()
		b.conn = nil
	}
	b.connected = false
	for id, ch := range b.pending {
		ch <- reply{err: err}
		delete(b.pending, id)
	}
	for _, w := range b.waiters {
		close(w)
	}
	b.waiters = nil
}

// ------------------------------------------------------------ transport

func (b *bridge) readLoop(conn net.Conn, hello chan message, events chan message) {
	defer close(events)
	r := bufio.NewReaderSize(conn, 64*1024)
	for {
		line, err := r.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			var m message
			if json.Unmarshal(line, &m) != nil {
				b.mu.Lock()
				b.emit("log", logEvent{Text: "mimic sent no JSON: " + strings.TrimSpace(string(line))})
				b.mu.Unlock()
			} else if m.ID != nil {
				b.mu.Lock()
				if ch := b.pending[*m.ID]; ch != nil {
					delete(b.pending, *m.ID)
					ch <- reply{OK: m.OK, Result: m.Result, Error: m.Error}
				}
				b.mu.Unlock()
			} else if m.Event == "hello" {
				select {
				case hello <- m:
				default:
				}
			} else if m.Event != "" {
				events <- m
			}
		}
		if err != nil {
			b.mu.Lock()
			if b.conn == conn {
				b.disconnect(mErr(503, "connection to mimic lost"))
				b.emit("status", b.statusLocked())
			}
			b.mu.Unlock()
			return
		}
	}
}

// eventLoop: the events in their order; a stop asks for the registers, so it runs apart from the reader
func (b *bridge) eventLoop(events chan message) {
	for m := range events {
		switch m.Event {
		case "resumed":
			b.mu.Lock()
			b.stopped = false
			if m.PC != nil {
				b.pc = m.PC
			}
			b.emit("resumed", pcEvent{m.PC})
			b.mu.Unlock()
		case "stopped":
			b.onStopped(m)
		case "media_changed", "device_connected":
			// nothing the IDE shows
		}
	}
}

func (b *bridge) onStopped(m message) {
	rs, _ := b.readRegs()
	b.mu.Lock()
	defer b.mu.Unlock()
	b.stopped = true
	pc := m.PC
	if v, ok := rs.get("pc"); ok {
		pc = intp(v)
	}
	if pc == nil {
		pc = b.pc
	}
	b.pc = pc
	if rs == nil {
		rs = regs{}
		if pc != nil {
			rs = regs{{"pc", *pc}}
		}
	}
	s := stopInfo{PC: pc, Registers: rs}
	if m.Reason != nil {
		switch m.Reason.Kind {
		case "cpu_jam":
			jam := m.Reason.PC
			if jam == nil {
				jam = pc
			}
			b.emit("jam", pcEvent{jam})
		case "breakpoint", "watchpoint":
			if m.Reason.BP != nil {
				if cp := b.cps[b.bpOf[*m.Reason.BP]]; cp != nil {
					cp.Hits++
					hit := *cp
					hit.Hit = true
					b.emit("checkpoint", checkpointEvent{hit, pc})
					if cp.Temporary {
						go b.deleteCheckpoint(cp.ID)
					}
				}
			}
		}
	}
	waiters := b.waiters
	b.waiters = nil
	for _, w := range waiters {
		w <- s
	}
	b.emit("stopped", s)
}

// call: a command of mimic; its result into out (nil: not read). timeout 0: the default
func (b *bridge) call(cmd string, args map[string]any, out any, timeout time.Duration) error {
	req := map[string]any{"cmd": cmd}
	for k, v := range args {
		req[k] = v
	}
	b.writeMu.Lock()
	b.mu.Lock()
	if b.conn == nil {
		b.mu.Unlock()
		b.writeMu.Unlock()
		if !b.running() {
			return mErr(409, "mimic is not running")
		}
		return mErr(503, "not connected to mimic")
	}
	id := b.nextID
	b.nextID++
	req["id"] = id
	ch := make(chan reply, 1)
	b.pending[id] = ch
	conn := b.conn
	b.mu.Unlock()
	line, _ := json.Marshal(req)
	_, err := conn.Write(append(line, '\n'))
	b.writeMu.Unlock()
	if err != nil {
		conn.Close()
	}
	if timeout == 0 {
		timeout = b.opts.requestTimeout
	}
	t := time.NewTimer(timeout)
	defer t.Stop()
	var r reply
	select {
	case r = <-ch:
	case <-t.C:
		b.mu.Lock()
		delete(b.pending, id)
		b.mu.Unlock()
		return mErr(504, "timeout waiting for mimic's answer to %s", cmd)
	}
	if r.err != nil {
		return r.err
	}
	if !r.OK {
		return mErr(400, "%s: %s", cmd, r.Error)
	}
	if out != nil && len(r.Result) > 0 {
		if err := json.Unmarshal(r.Result, out); err != nil {
			return mErr(502, "%s: unexpected answer of mimic: %v", cmd, err)
		}
	}
	return nil
}

// ------------------------------------------------------------ the operations

func (b *bridge) exclusive(fn func() error) error {
	b.opMu.Lock()
	defer b.opMu.Unlock()
	b.mu.Lock()
	running, connected := b.runningLocked(), b.connected
	b.mu.Unlock()
	if !running {
		return mErr(409, "mimic is not running")
	}
	if !connected {
		return mErr(503, "not connected to mimic")
	}
	return fn()
}

func (b *bridge) readRegs() (regs, error) {
	var r struct {
		Regs []struct {
			Name  string `json:"name"`
			Value int    `json:"value"`
		} `json:"regs"`
	}
	if err := b.call("regs", nil, &r, 0); err != nil {
		return nil, err
	}
	out := regs{}
	for _, x := range r.Regs {
		out = append(out, regKV{ideName(x.Name), x.Value})
	}
	return out, nil
}

// stopState: the registers where it stands now, as a stop (and the state updated)
func (b *bridge) stopState() (stopInfo, error) {
	rs, err := b.readRegs()
	if err != nil {
		return stopInfo{}, err
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.stopped = true
	if pc, ok := rs.get("pc"); ok {
		b.pc = intp(pc)
	}
	return stopInfo{PC: b.pc, Registers: rs}, nil
}

// awaitStop: runs an asynchronous command and waits for the stop that ends it
func (b *bridge) awaitStop(cmd string, args map[string]any) (stopInfo, error) {
	w := make(chan stopInfo, 1)
	b.mu.Lock()
	b.waiters = append(b.waiters, w)
	b.mu.Unlock()
	drop := func() {
		b.mu.Lock()
		for i, x := range b.waiters {
			if x == w {
				b.waiters = append(b.waiters[:i:i], b.waiters[i+1:]...)
			}
		}
		b.mu.Unlock()
	}
	if err := b.call(cmd, args, nil, 0); err != nil {
		drop()
		return stopInfo{}, err
	}
	select {
	case s, ok := <-w:
		if !ok {
			return stopInfo{}, mErr(503, "connection to mimic lost")
		}
		return s, nil
	case <-time.After(b.opts.stopTimeout):
		drop()
		return stopInfo{}, mErr(504, "emulator did not stop in time (still running)")
	}
}

func (b *bridge) pause() (stopInfo, error) {
	var s stopInfo
	err := b.exclusive(func() error {
		// a running machine sends a stopped event as well: that one goes to the listeners
		if err := b.call("pause", nil, nil, 0); err != nil {
			return err
		}
		var err error
		s, err = b.stopState()
		return err
	})
	return s, err
}

func (b *bridge) resume() (status, error) {
	err := b.exclusive(func() error {
		b.mu.Lock()
		stopped := b.stopped
		b.mu.Unlock()
		if !stopped {
			return nil
		}
		return b.call("resume", nil, nil, 0)
	})
	return b.status(), err
}

// step: count instructions; over: subroutine calls as one
func (b *bridge) step(count int, over bool) (stopInfo, error) {
	var s stopInfo
	err := b.exclusive(func() error {
		var err error
		if over {
			for i := 0; i < count; i++ {
				if s, err = b.awaitStop("step_over", nil); err != nil {
					return err
				}
			}
			return nil
		}
		if err = b.call("step_instr", map[string]any{"count": min(count, 100000)}, nil, 30*time.Second); err != nil {
			return err
		}
		if s, err = b.stopState(); err != nil {
			return err
		}
		b.mu.Lock()
		b.emit("stopped", s) // step_instr sends no event
		b.mu.Unlock()
		return nil
	})
	return s, err
}

func (b *bridge) stepReturn() (stopInfo, error) {
	var s stopInfo
	err := b.exclusive(func() error {
		var err error
		s, err = b.awaitStop("step_out", nil)
		return err
	})
	return s, err
}

// resetCPU: a reset, then it runs (as VICE does)
func (b *bridge) resetCPU(hard bool) (status, error) {
	kind := "soft"
	if hard {
		kind = "hard"
	}
	err := b.exclusive(func() error {
		if err := b.call("reset", map[string]any{"kind": kind}, nil, 0); err != nil {
			return err
		}
		return b.call("resume", nil, nil, 0)
	})
	return b.status(), err
}

// load: a reset, the program into the program slot - mimic puts it into the RAM once BASIC is up (and
// types RUN for a BASIC program) - or the cartridge of the 2600 into its slot, and it runs
func (b *bridge) load(file string, run bool) (status, error) {
	err := b.exclusive(func() error {
		b.mu.Lock()
		slot := b.slotProg
		if slot == nil {
			slot = b.slotCart
		}
		b.mu.Unlock()
		if slot == nil {
			return mErr(400, "this machine of mimic has no program slot")
		}
		if err := b.call("reset", map[string]any{"kind": "soft"}, nil, 0); err != nil {
			return err
		}
		if err := b.call("insert_media", map[string]any{"slot": *slot, "path": file}, nil, 15*time.Second); err != nil {
			return err
		}
		if !run {
			return nil
		}
		return b.call("resume", nil, nil, 0)
	})
	return b.status(), err
}

// bootFrames: the frames from a reset to BASIC's Ready - the CPC takes about a second; the Atari at least
// these, then READY on its screen (atariReady); the ZX81 clears and tests its 16K first
var bootFrames = map[string]int{"cpc": 100, "atari8": 30, "zx81": 250}

// resetKind: the reset that starts BASIC - the Atari needs a cold start (BASIC is in when it powers up)
var resetKind = map[string]string{"cpc": "soft", "atari8": "hard", "zx81": "hard"}

// keyCount: the key codes of the machine's keyboard (the CPC's matrix; the Atari's POKEY codes, SHIFT,
// CONTROL, BREAK, START, SELECT, OPTION; the ZX81's 8 x 5 matrix)
var keyCount = map[string]int{"cpc": 80, "atari8": 70, "zx81": 40}

// boot: a reset, then it runs until BASIC is up (in an operation)
func (b *bridge) boot() error {
	machine := b.machineIs()
	var st struct {
		Beam *struct {
			Frame int `json:"frame"`
		} `json:"beam"`
	}
	if err := b.call("reset", map[string]any{"kind": resetKind[machine]}, &st, 0); err != nil {
		return err
	}
	// every key up: a stop (a breakpoint right after a typed RETURN) can leave one held, and the reset
	// drops the release still queued - a key held stays unseen when it is typed again
	var up []any
	for k := 0; k < keyCount[machine]; k++ {
		up = append(up, map[string]any{"target": "keyboard", "delay": 0, "event": map[string]any{"type": "key", "key": k, "down": false}})
	}
	if err := b.call("input", map[string]any{"events": up}, nil, 0); err != nil {
		return err
	}
	if err := b.call("resume", nil, nil, 0); err != nil {
		return err
	}
	if st.Beam == nil {
		time.Sleep(2 * time.Second)
		return nil
	}
	for t0 := time.Now(); time.Since(t0) < 20*time.Second; time.Sleep(50 * time.Millisecond) {
		var beam struct {
			Frame int `json:"frame"`
		}
		if err := b.call("beam", nil, &beam, 0); err != nil {
			return err
		}
		if beam.Frame < st.Beam.Frame+bootFrames[machine] {
			continue
		}
		if machine != "atari8" {
			return nil
		}
		// the Atari: its cold start takes as long as the OS waits for a disc - READY on the screen tells
		if ready, err := b.atariReady(); err != nil || ready {
			return err
		}
	}
	return mErr(504, "the machine did not boot in time")
}

// loadBinary: a reset, BASIC up, the code into the RAM at at, CALL start typed (the CPC)
func (b *bridge) loadBinary(body []byte, at, start int) (status, error) {
	err := b.exclusive(func() error {
		if b.machineIs() != "cpc" {
			return mErr(400, "binaries without a program slot are loaded on the CPC only")
		}
		if len(body) == 0 || at+len(body) > 0x10000 {
			return mErr(400, "the program does not fit at $%04x", at)
		}
		if err := b.boot(); err != nil {
			return err
		}
		list := make([]int, len(body))
		for i, v := range body {
			list[i] = int(v)
		}
		if err := b.call("poke", map[string]any{"addr": at, "bytes": list}, nil, 0); err != nil {
			return err
		}
		return b.call("input", map[string]any{"events": cpcKeyboard.typed(fmt.Sprintf("CALL &%X\r", start))}, nil, 0)
	})
	return b.status(), err
}

// loadDisk: a reset, BASIC up, the disc into drive A, RUN"name typed (the CPC 664 and 6128)
func (b *bridge) loadDisk(file, runName string) (status, error) {
	err := b.exclusive(func() error {
		b.mu.Lock()
		slot := b.slotDisk
		b.mu.Unlock()
		if slot == nil {
			return mErr(400, "this machine of mimic has no disc drive (the CPC 464: BASIC programs run on the 664 and the 6128)")
		}
		// the disc goes in once BASIC is up
		if err := b.boot(); err != nil {
			return err
		}
		if err := b.call("insert_media", map[string]any{"slot": *slot, "path": file}, nil, 15*time.Second); err != nil {
			return err
		}
		return b.call("input", map[string]any{"events": cpcKeyboard.typed(`RUN"` + runName + "\r")}, nil, 0)
	})
	return b.status(), err
}

// loadADF: the disk into DF0:, then a hard reset - Kickstart boots it (the Amiga)
func (b *bridge) loadADF(file string) (status, error) {
	err := b.exclusive(func() error {
		b.mu.Lock()
		slot := b.slotDisk
		b.mu.Unlock()
		if slot == nil || b.machineIs() != "amiga" {
			return mErr(400, "ADF disks boot on the Amiga only")
		}
		if err := b.call("insert_media", map[string]any{"slot": *slot, "path": file}, nil, 15*time.Second); err != nil {
			return err
		}
		if err := b.call("reset", map[string]any{"kind": "hard"}, nil, 0); err != nil {
			return err
		}
		return b.call("resume", nil, nil, 0)
	})
	return b.status(), err
}

// loadTape: a reset, BASIC up, the .P file into the tape slot, LOAD "" typed - the ROM's LOAD (a trap of
// mimic) takes the program in and runs the line its NXTLIN names (the ZX81)
func (b *bridge) loadTape(file string) (status, error) {
	err := b.exclusive(func() error {
		b.mu.Lock()
		slot := b.slotTape
		b.mu.Unlock()
		if slot == nil || b.machineIs() != "zx81" {
			return mErr(400, ".P files load on the ZX81 only")
		}
		if err := b.boot(); err != nil {
			return err
		}
		if err := b.call("insert_media", map[string]any{"slot": *slot, "path": file}, nil, 15*time.Second); err != nil {
			return err
		}
		// in K mode the J key is LOAD
		return b.call("input", map[string]any{"events": zx81Keyboard.typed("J\"\"\r")}, nil, 0)
	})
	return b.status(), err
}

// atariReady: whether the Atari's screen shows READY (the screen at SAVMSC, $58; in screen codes)
func (b *bridge) atariReady() (bool, error) {
	var r struct {
		Bytes []int `json:"bytes"`
	}
	if err := b.call("peek", map[string]any{"addr": 0x58, "len": 2}, &r, 0); err != nil || len(r.Bytes) < 2 {
		return false, err
	}
	screen := r.Bytes[0] | r.Bytes[1]<<8
	if screen == 0 || screen+960 > 0x10000 {
		return false, nil
	}
	if err := b.call("peek", map[string]any{"addr": screen, "len": 960}, &r, 0); err != nil {
		return false, err
	}
	ready := []int{0x32, 0x25, 0x21, 0x24, 0x39}
	for i := 0; i+len(ready) <= len(r.Bytes); i++ {
		if r.Bytes[i] == ready[0] && r.Bytes[i+1] == ready[1] && r.Bytes[i+2] == ready[2] && r.Bytes[i+3] == ready[3] && r.Bytes[i+4] == ready[4] {
			return true, nil
		}
	}
	return false, nil
}

// loadListing: a cold start into Atari BASIC, the listing typed line by line, then RUN (the Atari: its BASIC
// takes no file without a DOS)
func (b *bridge) loadListing(listing []byte) (status, error) {
	err := b.exclusive(func() error {
		if b.machineIs() != "atari8" {
			return mErr(400, "BASIC listings are typed into the Atari only")
		}
		b.mu.Lock()
		slot := b.slotProg
		b.mu.Unlock()
		if slot != nil { // a .xex not started yet would boot without BASIC
			b.call("eject_media", map[string]any{"slot": *slot}, nil, 0)
		}
		if err := b.boot(); err != nil {
			return err
		}
		return b.call("input", map[string]any{"events": atariKeyboard.typed("NEW\r" + strings.TrimRight(atasciiText(listing), "\r") + "\rRUN\r")}, nil, 0)
	})
	return b.status(), err
}

// typeText: text typed on the keyboard (the CPC, the Atari, the ZX81)
func (b *bridge) typeText(text string) error {
	return b.exclusive(func() error {
		kb := keyboards[b.machineIs()]
		if kb == nil {
			return mErr(501, "mimic types text on the CPC, the Atari and the ZX81 only")
		}
		return b.call("input", map[string]any{"events": kb.typed(text)}, nil, 0)
	})
}

func (b *bridge) machineIs() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.machine
}

// cpcK: a key of the CPC - line*8+bit of its keyboard matrix (mimic: crates/machine-cpc/src/keyboard.rs)
func cpcK(line, bit int) int { return line*8 + bit }

type cpcKey struct {
	key   int
	shift bool
}

var (
	cpcReturn = cpcK(2, 2)
	cpcShift  = cpcK(2, 5)
	// the keys of the characters, SHIFT held or not (UK layout; letters unshifted, BASIC takes them so)
	cpcKeys = map[rune]cpcKey{
		'A': {cpcK(8, 5), false}, 'B': {cpcK(6, 6), false}, 'C': {cpcK(7, 6), false}, 'D': {cpcK(7, 5), false},
		'E': {cpcK(7, 2), false}, 'F': {cpcK(6, 5), false}, 'G': {cpcK(6, 4), false}, 'H': {cpcK(5, 4), false},
		'I': {cpcK(4, 3), false}, 'J': {cpcK(5, 5), false}, 'K': {cpcK(4, 5), false}, 'L': {cpcK(4, 4), false},
		'M': {cpcK(4, 6), false}, 'N': {cpcK(5, 6), false}, 'O': {cpcK(4, 2), false}, 'P': {cpcK(3, 3), false},
		'Q': {cpcK(8, 3), false}, 'R': {cpcK(6, 2), false}, 'S': {cpcK(7, 4), false}, 'T': {cpcK(6, 3), false},
		'U': {cpcK(5, 2), false}, 'V': {cpcK(6, 7), false}, 'W': {cpcK(7, 3), false}, 'X': {cpcK(7, 7), false},
		'Y': {cpcK(5, 3), false}, 'Z': {cpcK(8, 7), false},
		'1': {cpcK(8, 0), false}, '2': {cpcK(8, 1), false}, '3': {cpcK(7, 1), false}, '4': {cpcK(7, 0), false},
		'5': {cpcK(6, 1), false}, '6': {cpcK(6, 0), false}, '7': {cpcK(5, 1), false}, '8': {cpcK(5, 0), false},
		'9': {cpcK(4, 1), false}, '0': {cpcK(4, 0), false}, '!': {cpcK(8, 0), true}, '"': {cpcK(8, 1), true},
		'#': {cpcK(7, 1), true}, '$': {cpcK(7, 0), true}, '%': {cpcK(6, 1), true}, '&': {cpcK(6, 0), true},
		'\'': {cpcK(5, 1), true}, '(': {cpcK(5, 0), true}, ')': {cpcK(4, 1), true}, '_': {cpcK(4, 0), true},
		'-': {cpcK(3, 1), false}, '=': {cpcK(3, 1), true}, '^': {cpcK(3, 0), false}, '@': {cpcK(3, 2), false},
		'|': {cpcK(3, 2), true}, '[': {cpcK(2, 1), false}, '{': {cpcK(2, 1), true}, ']': {cpcK(2, 3), false},
		'}': {cpcK(2, 3), true}, ';': {cpcK(3, 4), false}, '+': {cpcK(3, 4), true}, ':': {cpcK(3, 5), false},
		'*': {cpcK(3, 5), true}, ',': {cpcK(4, 7), false}, '<': {cpcK(4, 7), true}, '.': {cpcK(3, 7), false},
		'>': {cpcK(3, 7), true}, '/': {cpcK(3, 6), false}, '?': {cpcK(3, 6), true}, '\\': {cpcK(2, 6), false},
		'`': {cpcK(2, 6), true}, ' ': {cpcK(5, 7), false}, '\r': {cpcReturn, false}, '\n': {cpcReturn, false},
	}
)

// atariKeys: the POKEY key codes of the Atari's characters, SHIFT held or not (caps lock on, as after
// power-up: letters come out as capitals; mimic: crates/machine-atari8/src/keyboard.rs)
var atariKeys = map[rune]cpcKey{
	'A': {0x3f, false}, 'B': {0x15, false}, 'C': {0x12, false}, 'D': {0x3a, false}, 'E': {0x2a, false}, 'F': {0x38, false},
	'G': {0x3d, false}, 'H': {0x39, false}, 'I': {0x0d, false}, 'J': {0x01, false}, 'K': {0x05, false}, 'L': {0x00, false},
	'M': {0x25, false}, 'N': {0x23, false}, 'O': {0x08, false}, 'P': {0x0a, false}, 'Q': {0x2f, false}, 'R': {0x28, false},
	'S': {0x3e, false}, 'T': {0x2d, false}, 'U': {0x0b, false}, 'V': {0x10, false}, 'W': {0x2e, false}, 'X': {0x16, false},
	'Y': {0x2b, false}, 'Z': {0x17, false},
	'1': {0x1f, false}, '2': {0x1e, false}, '3': {0x1a, false}, '4': {0x18, false}, '5': {0x1d, false}, '6': {0x1b, false},
	'7': {0x33, false}, '8': {0x35, false}, '9': {0x30, false}, '0': {0x32, false}, '!': {0x1f, true}, '"': {0x1e, true},
	'#': {0x1a, true}, '$': {0x18, true}, '%': {0x1d, true}, '&': {0x1b, true}, '\'': {0x33, true}, '@': {0x35, true},
	'(': {0x30, true}, ')': {0x32, true}, ' ': {0x21, false}, '\r': {0x0c, false}, '\n': {0x0c, false}, ',': {0x20, false},
	'.': {0x22, false}, ';': {0x02, false}, ':': {0x02, true}, '+': {0x06, false}, '\\': {0x06, true}, '*': {0x07, false},
	'^': {0x07, true}, '-': {0x0e, false}, '_': {0x0e, true}, '=': {0x0f, false}, '|': {0x0f, true}, '/': {0x26, false},
	'?': {0x26, true}, '<': {0x36, false}, '>': {0x37, false},
	atariInverse: {0x27, false},
}

// zx81Keys: the ZX81's keys - row*5+column of its matrix (mimic: crates/machine-zx81/src/keyboard.rs);
// a letter is the keyword of its key in K mode (J: LOAD, R: RUN), SHIFT gives the symbols
var zx81Keys = func() map[rune]cpcKey {
	keys := map[rune]cpcKey{' ': {35, false}, '\r': {30, false}, '\n': {30, false}}
	for row, cols := range []string{" ZXCV", "ASDFG", "QWERT", "12345", "09876", "POIUY", " LKJH", " .MNB"} {
		for col, c := range cols {
			if c != ' ' {
				keys[c] = cpcKey{row*5 + col, false}
			}
		}
	}
	for sym, c := range map[rune]rune{'"': 'P', ',': '.', '-': 'J', '+': 'K', '*': 'B', '/': 'V', '=': 'L', '(': 'I', ')': 'O',
		'<': 'N', '>': 'M', ';': 'X', ':': 'Z', '?': 'C', '$': 'U'} {
		keys[sym] = cpcKey{keys[c].key, true}
	}
	return keys
}()

// atariInverse: the inverse video key (the Atari logo key) in a text to type
const atariInverse = '\x01'

// atasciiText: an ATASCII listing as text to type - EOL ($9B) a RETURN, inverse characters between two
// presses of the inverse key; control and graphics characters are left out (they need ESC or CTRL)
func atasciiText(data []byte) string {
	var sb strings.Builder
	inv := false
	for _, c := range data {
		if c == 0x9b || c == '\n' || c == '\r' {
			if inv {
				sb.WriteRune(atariInverse)
				inv = false
			}
			sb.WriteByte('\r')
			continue
		}
		ch := c & 0x7f
		if ch < 0x20 || ch == 0x7f {
			continue
		}
		if (c&0x80 != 0) != inv {
			sb.WriteRune(atariInverse)
			inv = !inv
		}
		sb.WriteByte(ch)
	}
	if inv {
		sb.WriteRune(atariInverse)
	}
	return sb.String()
}

// keyboard: how text is typed on a machine - its keys, SHIFT, and the timing in cycles: how long a key is
// held, the gap to the next one, how long SHIFT goes down before the key, the pause after RETURN (BASIC
// takes the line in)
type keyboard struct {
	keys                         map[rune]cpcKey
	shift                        int
	hold, gap, lead, afterReturn int
	ret                          int
}

var (
	// the CPC (4 MHz): the firmware scans the keyboard 50 times a second - a key is held for more than two
	// scans, SHIFT goes down a scan before it
	cpcKeyboard = &keyboard{keys: cpcKeys, shift: cpcShift, ret: cpcReturn, hold: 200_000, gap: 200_000, lead: 100_000}
	// the Atari (1.79 MHz): two passes of POKEY's scan held, a gap longer than the OS's repeat delay; Atari
	// BASIC needs a moment for a line
	atariKeyboard = &keyboard{keys: atariKeys, shift: 64, ret: 0x0c, hold: 30_000, gap: 90_000, afterReturn: 250_000}
	// the ZX81 (3.25 MHz): the ROM takes a key held for a few fields and waits for the keyboard to be idle
	// (mimic's typed_events: five fields down, twelve up), SHIFT a field before
	zx81Keyboard = &keyboard{keys: zx81Keys, shift: 0, ret: 30, hold: 325_000, gap: 780_000, lead: 65_000}
	keyboards    = map[string]*keyboard{"cpc": cpcKeyboard, "atari8": atariKeyboard, "zx81": zx81Keyboard}
)

// typed: the input events that type text (characters without a key are left out; CR LF is one RETURN)
func (kb *keyboard) typed(text string) []any {
	var out []any
	key := func(at, k int, down bool) {
		out = append(out, map[string]any{"target": "keyboard", "delay": at, "event": map[string]any{"type": "key", "key": k, "down": down}})
	}
	t := 0
	for _, c := range strings.ReplaceAll(text, "\r\n", "\r") {
		k, ok := kb.keys[unicode.ToUpper(c)]
		if !ok || c >= 0x80 {
			continue
		}
		lead := 0
		if k.shift {
			lead = kb.lead
			key(t, kb.shift, true)
		}
		key(t+lead, k.key, true)
		key(t+lead+kb.hold, k.key, false)
		if k.shift {
			key(t+lead+kb.hold, kb.shift, false)
		}
		t += lead + kb.hold + kb.gap
		if k.key == kb.ret {
			t += kb.afterReturn
		}
	}
	return out
}

func (b *bridge) getRegisters() (regs, error) {
	var rs regs
	err := b.exclusive(func() error {
		var err error
		rs, err = b.readRegs()
		return err
	})
	return rs, err
}

// setRegisters: the registers by the names of the IDE (pc, a, sp, fl ...)
func (b *bridge) setRegisters(values map[string]int) (regs, error) {
	var rs regs
	err := b.exclusive(func() error {
		names := make([]string, 0, len(values))
		for n := range values {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, n := range names {
			if err := b.call("set_reg", map[string]any{"name": mimicName(n), "value": values[n]}, nil, 0); err != nil {
				return err
			}
		}
		var err error
		if rs, err = b.readRegs(); err != nil {
			return err
		}
		if pc, ok := rs.get("pc"); ok {
			b.mu.Lock()
			b.pc = intp(pc)
			b.mu.Unlock()
		}
		return nil
	})
	return rs, err
}

func (b *bridge) readMemory(start, end, space int) ([]byte, error) {
	var out []byte
	err := b.exclusive(func() error {
		var r struct {
			Bytes []int `json:"bytes"`
		}
		if err := b.call("peek", map[string]any{"space": space, "addr": start, "len": end - start + 1}, &r, 0); err != nil {
			return err
		}
		out = make([]byte, len(r.Bytes))
		for i, v := range r.Bytes {
			out[i] = byte(v)
		}
		return nil
	})
	return out, err
}

func (b *bridge) writeMemory(start int, data []byte, space int) error {
	return b.exclusive(func() error {
		list := make([]int, len(data)) // bytes as numbers: a []byte would be base64 in JSON
		for i, v := range data {
			list[i] = int(v)
		}
		return b.call("poke", map[string]any{"space": space, "addr": start, "bytes": list}, nil, 0)
	})
}

// getBanks: the memory spaces of the main CPU (cpu: what it sees, ram, colorram ...)
func (b *bridge) getBanks() ([]bank, error) {
	out := []bank{}
	err := b.exclusive(func() error {
		b.mu.Lock()
		defer b.mu.Unlock()
		for _, s := range b.spaces {
			if s.Device == "cpu" {
				out = append(out, bank{s.ID, s.Name})
			}
		}
		return nil
	})
	return out, err
}

// ------------------------------------------------------------ checkpoints

// maxExecRange: the most addresses an exec checkpoint covers (a breakpoint each)
const maxExecRange = 256

type checkpointOpts struct {
	start, end, space        int
	exec, load, store        bool
	enabled, temporary, stop bool
	condition                string
}

func (b *bridge) listCheckpoints() ([]checkpoint, error) {
	out := []checkpoint{}
	err := b.exclusive(func() error {
		b.mu.Lock()
		defer b.mu.Unlock()
		for _, cp := range b.cps {
			out = append(out, *cp)
		}
		sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
		return nil
	})
	return out, err
}

func (b *bridge) getCheckpoint(id uint32) (checkpoint, error) {
	var out checkpoint
	err := b.exclusive(func() error {
		b.mu.Lock()
		defer b.mu.Unlock()
		cp := b.cps[id]
		if cp == nil {
			return mErr(404, "no checkpoint %d", id)
		}
		out = *cp
		return nil
	})
	return out, err
}

func (b *bridge) setCheckpoint(o checkpointOpts) (checkpoint, error) {
	var out checkpoint
	err := b.exclusive(func() error {
		if o.exec && o.end-o.start+1 > maxExecRange {
			return mErr(400, "an exec range covers %d addresses at most", maxExecRange)
		}
		var specs []map[string]any
		add := func(kind string, addr, n int) {
			s := map[string]any{"kind": kind, "addr": addr, "space": o.space, "enabled": o.enabled}
			if kind != "exec" {
				s["len"] = n
			}
			if o.condition != "" {
				s["condition"] = o.condition
			}
			specs = append(specs, s)
		}
		if o.exec {
			for a := o.start; a <= o.end; a++ {
				add("exec", a, 1)
			}
		}
		if o.load {
			add("read", o.start, o.end-o.start+1)
		}
		if o.store {
			add("write", o.start, o.end-o.start+1)
		}
		var bps []uint32
		for _, s := range specs {
			var r struct {
				BP uint32 `json:"bp"`
			}
			if err := b.call("break_add", s, &r, 0); err != nil {
				for _, bp := range bps {
					b.call("break_remove", map[string]any{"bp": bp}, nil, 0)
				}
				if o.condition != "" {
					return mErr(400, "invalid condition '%s': %v", o.condition, err)
				}
				return err
			}
			bps = append(bps, r.BP)
		}
		b.mu.Lock()
		defer b.mu.Unlock()
		cp := &checkpoint{ID: b.nextCP, Start: o.start, End: o.end, Stop: true, Enabled: o.enabled,
			Exec: o.exec, Load: o.load, Store: o.store, Temporary: o.temporary, bps: bps, space: o.space}
		if o.condition != "" {
			cp.Condition = strp(o.condition)
		}
		b.nextCP++
		b.cps[cp.ID] = cp
		for _, bp := range bps {
			b.bpOf[bp] = cp.ID
		}
		out = *cp
		return nil
	})
	return out, err
}

func (b *bridge) toggleCheckpoint(id uint32, enabled bool) (checkpoint, error) {
	var out checkpoint
	err := b.exclusive(func() error {
		b.mu.Lock()
		cp := b.cps[id]
		b.mu.Unlock()
		if cp == nil {
			return mErr(404, "no checkpoint %d", id)
		}
		for _, bp := range cp.bps {
			if err := b.call("break_enable", map[string]any{"bp": bp, "enabled": enabled}, nil, 0); err != nil {
				return err
			}
		}
		b.mu.Lock()
		cp.Enabled = enabled
		out = *cp
		b.mu.Unlock()
		return nil
	})
	return out, err
}

func (b *bridge) deleteCheckpoint(id uint32) error {
	return b.exclusive(func() error {
		b.mu.Lock()
		cp := b.cps[id]
		if cp != nil {
			delete(b.cps, id)
			for _, bp := range cp.bps {
				delete(b.bpOf, bp)
			}
		}
		b.mu.Unlock()
		if cp == nil {
			return mErr(404, "no checkpoint %d", id)
		}
		for _, bp := range cp.bps {
			if err := b.call("break_remove", map[string]any{"bp": bp}, nil, 0); err != nil {
				return err
			}
		}
		return nil
	})
}

// ------------------------------------------------------------ input and the screen

// setJoystick: port 1 or 2 as printed on the machine; value bits 1 up, 2 down, 4 left, 8 right, 16 fire
func (b *bridge) setJoystick(port, value int) error {
	return b.exclusive(func() error {
		dirs := []string{}
		for i, d := range []string{"up", "down", "left", "right"} {
			if value&(1<<i) != 0 {
				dirs = append(dirs, d)
			}
		}
		buttons := 0
		if value&16 != 0 {
			buttons = 1
		}
		ev := map[string]any{"target": map[string]any{"port": port - 1}, "delay": 0,
			"event": map[string]any{"type": "joystick", "dirs": dirs, "buttons": buttons}}
		return b.call("input", map[string]any{"events": []any{ev}}, nil, 0)
	})
}

// preview: the port of the preview server, 0 while mimic does not run
func (b *bridge) preview() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.runningLocked() {
		return 0
	}
	return b.previewPort
}

// getDisplay: the picture of the preview server as RGBA
func (b *bridge) getDisplay() (displayFrame, error) {
	var out displayFrame
	err := b.exclusive(func() error {
		b.mu.Lock()
		port := b.previewPort
		b.mu.Unlock()
		client := http.Client{Timeout: 10 * time.Second}
		res, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/snapshot.png", port))
		if err != nil {
			return mErr(502, "the picture of mimic: %v", err)
		}
		defer res.Body.Close()
		if res.StatusCode != 200 {
			return mErr(502, "the picture of mimic: %s", res.Status)
		}
		img, err := png.Decode(res.Body)
		if err != nil {
			return mErr(502, "the picture of mimic: %v", err)
		}
		rgba, ok := img.(*image.RGBA)
		if !ok || rgba.Rect.Min != (image.Point{}) || rgba.Stride != rgba.Rect.Dx()*4 {
			rgba = image.NewRGBA(image.Rect(0, 0, img.Bounds().Dx(), img.Bounds().Dy()))
			draw.Draw(rgba, rgba.Rect, img, img.Bounds().Min, draw.Src)
		}
		out = displayFrame{rgba.Rect.Dx(), rgba.Rect.Dy(), rgba.Pix}
		return nil
	})
	return out, err
}

// writeTemp: a program into a folder, under its name made safe
func writeTemp(dir, name string, data []byte) (string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	base := strings.TrimLeft(safeName.ReplaceAllString(filepath.Base(strings.ReplaceAll(name, "\\", "/")), "_"), ".")
	if base == "" || base == "_" {
		base = "program"
	}
	if !strings.Contains(base, ".") {
		base += ".prg"
	}
	file, err := filepath.Abs(filepath.Join(dir, base))
	if err != nil {
		return "", err
	}
	return file, os.WriteFile(file, data, 0o644)
}

var safeName = regexp.MustCompile(`[^A-Za-z0-9._ -]`)
