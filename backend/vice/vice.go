package vice

// The process and the connection of the VICE emulator's binary remote monitor.
//
// Run-state behaviour of VICE 3.10 (verified against x64sc r45942):
//   - ANY binary-monitor command received while the CPU runs stops the emulation
//     ("enters the monitor"): VICE first sends an unsolicited register dump
//     (0x31, id 0xffffffff) and a STOPPED event (0x62), then the response.
//     The CPU then STAYS stopped until EXIT (0xaa) is sent, which answers 0xaa
//     followed by a RESUMED event (0x63).
//   - Therefore "pause" = send PING while running and keep it stopped.
//     "continue" = EXIT.
//   - Commands that are only meant to look at the machine (memory, display,
//     checkpoints, ...) are executed "transiently": if the CPU was running before,
//     the induced stop is hidden from listeners and EXIT is sent afterwards, so
//     for the IDE the emulator keeps running (it is halted for a few ms only).
//   - AUTOSTART (0xdd), RESET (0xcc), ADVANCE (0x71) and EXECUTE-UNTIL-RETURN
//     (0x73) resume the CPU by themselves (VICE sends RESUMED right after the
//     response). Advance/return then stop again: registers + STOPPED.
//   - A checkpoint hit sends 0x11 (id 0xffffffff, hit=1), registers, STOPPED.
//   - Pausing via VICE's own GUI pause (Alt+P) is not visible to the monitor.
//
// The locks: mu guards the state (the reader of the socket, the timers and the calls share it);
// opMu serializes the high level operations (the promise chain of the JS); writeMu keeps the
// requests in the order of their ids. The listener of the events is called with mu held: it must
// not block and not call back into the bridge.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf16"

	"nerdsuite/backend/core"
)

// machines: the machines VICE emulates and their programs (in this order)
var machines = []struct{ id, exe string }{
	{"c64", "x64sc"},
	{"c128", "x128"},
	{"vic20", "xvic"},
	{"plus4", "xplus4"},
	{"pet", "xpet"},
}

func machineExe(machine string) string {
	for _, m := range machines {
		if m.id == machine {
			return m.exe
		}
	}
	return ""
}

func machineIDs() []string {
	ids := make([]string, len(machines))
	for i, m := range machines {
		ids[i] = m.id
	}
	return ids
}

// defaultViceDir: where VICE is on this machine when neither the settings nor VICE name it
func defaultViceDir() string {
	return filepath.Join(core.AppsDir(), "GTK3VICE-3.10-win64-r45942", "bin")
}

func exeName(base string) string {
	if core.IsWindows && !strings.HasSuffix(strings.ToLower(base), ".exe") {
		return base + ".exe"
	}
	return base
}

// FindExecutable: the emulator of a machine ("" - c64): the folder of the settings (key VICE, a
// file there: its folder), else the default folder, else the PATH. "" when it is not found; an
// error for an unknown machine
func FindExecutable(st *core.Settings, machine string) (string, error) {
	return findExecutable(st, machine, "")
}

// findExecutable: as FindExecutable; exe - a program, a folder or a name on the PATH given instead
func findExecutable(st *core.Settings, machine, exe string) (string, error) {
	if machine == "" {
		machine = "c64"
	}
	base := machineExe(machine)
	if base == "" {
		return "", fmt.Errorf("unknown machine '%s'", machine)
	}
	if exe != "" {
		if core.IsFile(exe) {
			if abs, err := filepath.Abs(exe); err == nil {
				return abs, nil
			}
			return exe, nil
		}
		if core.IsDir(exe) {
			if p := filepath.Join(exe, exeName(base)); core.IsFile(p) {
				return p, nil
			}
		}
		return core.SearchPath(exe), nil
	}
	var dirs []string
	if v := st.ToolPath("VICE"); v != "" { // the settings, else the environment
		if core.IsFile(v) {
			v = filepath.Dir(v)
		}
		dirs = append(dirs, v)
	}
	dirs = append(dirs, defaultViceDir())
	for _, d := range dirs {
		if p := filepath.Join(d, exeName(base)); core.IsFile(p) {
			return p, nil
		}
	}
	return core.SearchPath(base), nil
}

// getFreePort: a port nobody listens on
func getFreePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	return port, nil
}

var ansi = regexp.MustCompile(`\x1b\[[0-9;]*[A-Za-z]`)
var newline = regexp.MustCompile(`\r?\n`)

// textToPetscii: ASCII/Unicode text as PETSCII bytes for the keyboard buffer.
// Letters of either case map to unshifted PETSCII letters (what you get when
// typing on a C64 in upper-case/graphics mode); newline -> RETURN.
func textToPetscii(text string) []byte {
	src := utf16.Encode([]rune(text))
	out := []byte{}
	for i := 0; i < len(src); i++ {
		c := int(src[i])
		switch {
		case c == '\r':
			if i+1 < len(src) && src[i+1] == '\n' {
				i++
			}
			out = append(out, 0x0d)
		case c == '\n':
			out = append(out, 0x0d)
		case c >= 0x61 && c <= 0x7a:
			out = append(out, byte(c-0x20))
		case c >= 0x20 && c < 0x60:
			out = append(out, byte(c))
		case c == '£':
			out = append(out, 0x5c)
		case c == '↑':
			out = append(out, 0x5e)
		case c == '←':
			out = append(out, 0x5f)
		case c == 'π':
			out = append(out, 0xff)
		case c < 0x20 || (c >= 0x80 && c <= 0xff): // control / raw PETSCII codes
			out = append(out, byte(c))
		}
	}
	return out
}

// resuming: the commands that let the CPU run again
var resuming = map[byte]bool{cmdExit: true, cmdAutostart: true, cmdReset: true, cmdAdvanceInstructions: true, cmdExecuteUntilReturn: true}

// viceError: an error of the bridge with the status of its answer
type viceError struct {
	msg    string
	status int
}

func (e *viceError) Error() string { return e.msg }

func vErr(status int, format string, a ...any) error {
	return &viceError{msg: fmt.Sprintf(format, a...), status: status}
}

// ---------------------------------------------------------------- the values of the events

// regs: the registers by name, in the order VICE reports them (a JSON object)
type regs []regKV

type regKV struct {
	name  string
	value int
}

func (r regs) get(name string) (int, bool) {
	for _, kv := range r {
		if kv.name == name {
			return kv.value, true
		}
	}
	return 0, false
}

func (r regs) MarshalJSON() ([]byte, error) {
	var sb strings.Builder
	sb.WriteByte('{')
	for i, kv := range r {
		if i > 0 {
			sb.WriteByte(',')
		}
		k, _ := json.Marshal(kv.name)
		sb.Write(k)
		sb.WriteByte(':')
		sb.WriteString(strconv.Itoa(kv.value))
	}
	sb.WriteByte('}')
	return []byte(sb.String()), nil
}

// stopInfo: where the CPU stopped
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

// checkpoint: a checkpoint as the API shows it
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
}

// checkpointEvent: a checkpoint hit, with the PC
type checkpointEvent struct {
	checkpoint
	PC *int `json:"pc"`
}

// viceStatus: the state of the emulator
type viceStatus struct {
	Running   bool    `json:"running"`
	Connected bool    `json:"connected"`
	Stopped   bool    `json:"stopped"`
	PC        *int    `json:"pc"`
	Machine   *string `json:"machine"`
	Version   *string `json:"version"`
	Exe       *string `json:"exe"`
}

// displayFrame: the screen in RGBA
type displayFrame struct {
	width, height, innerX, innerY, innerWidth, innerHeight int
	rgba                                                   []byte
}

func intp(v int) *int { return &v }
func strp(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// ---------------------------------------------------------------- the process

// viceProc: a started emulator. wait ends with it (the code, the signal or nil); kill ends it -
// force: at once (SIGKILL), else asked (SIGTERM). done is closed when it has ended.
type viceProc struct {
	wait func() (int, *string)
	kill func(force bool)
	done chan struct{}
}

// spawnFunc: starts the emulator; out gets what it writes (stdout and stderr)
type spawnFunc func(exe string, args []string, out io.Writer) (*viceProc, error)

var signalNames = map[syscall.Signal]string{
	syscall.SIGTERM: "SIGTERM", syscall.SIGKILL: "SIGKILL", syscall.SIGINT: "SIGINT",
	syscall.SIGHUP: "SIGHUP", syscall.SIGQUIT: "SIGQUIT", syscall.SIGABRT: "SIGABRT", syscall.SIGSEGV: "SIGSEGV",
}

// spawnProcess: the emulator as a process, in its folder, with a window of its own
func spawnProcess(exe string, args []string, out io.Writer) (*viceProc, error) {
	cmd := exec.Command(exe, args...)
	cmd.Dir = filepath.Dir(exe)
	cmd.Stdout = out
	cmd.Stderr = out
	cmd.WaitDelay = 2 * time.Second // a child that keeps the output open must not hold up the exit
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	var mu sync.Mutex
	killed := "" // the signal it was ended with (Windows reports no signal: the one asked for)
	p := &viceProc{done: make(chan struct{})}
	p.kill = func(force bool) {
		mu.Lock()
		if force {
			killed = "SIGKILL"
		} else if killed == "" {
			killed = "SIGTERM"
		}
		mu.Unlock()
		if force || core.IsWindows {
			cmd.Process.Kill()
		} else {
			cmd.Process.Signal(syscall.SIGTERM)
		}
	}
	p.wait = func() (int, *string) {
		cmd.Wait()
		ps := cmd.ProcessState
		if ps == nil {
			return -1, nil
		}
		if ws, ok := ps.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			name := signalNames[ws.Signal()]
			if name == "" {
				name = ws.Signal().String()
			}
			return -1, &name
		}
		mu.Lock()
		k := killed
		mu.Unlock()
		if core.IsWindows && k != "" && ps.ExitCode() != 0 {
			return -1, &k
		}
		return ps.ExitCode(), nil
	}
	return p, nil
}

// logWriter: the output of the emulator as log events, a line each
type logWriter struct{ b *bridge }

func (w *logWriter) Write(p []byte) (int, error) {
	w.b.mu.Lock()
	for _, line := range newline.Split(ansi.ReplaceAllString(string(p), ""), -1) {
		if strings.TrimSpace(line) != "" {
			w.b.emit("log", logEvent{Text: line})
		}
	}
	w.b.mu.Unlock()
	return len(p), nil
}

// ---------------------------------------------------------------- the bridge

// bridgeOptions: the timeouts (0 - the defaults) and how the emulator is started (nil - a process)
type bridgeOptions struct {
	requestTimeout time.Duration
	connectTimeout time.Duration
	spawn          spawnFunc
}

// pendingReq: a request waiting for its response
type pendingReq struct {
	command     byte
	frames      []frame
	ch          chan sendResult
	awaitStop   bool
	stopTimeout time.Duration
	inducing    bool
	timer       *time.Timer
}

// sendResult: the response (for CHECKPOINT_LIST the frames and the count; with awaitStop the stop)
type sendResult struct {
	frame  frame
	frames []frame
	count  uint32
	stop   stopInfo
	err    error
}

// sendOpts: the timeout of the response (0 - the default); awaitStop: also wait for the next
// STOPPED event after the response (stopTimeout: how long, 0 - 10 s)
type sendOpts struct {
	timeout     time.Duration
	awaitStop   bool
	stopTimeout time.Duration
}

type stopWaiter struct {
	p     *pendingReq
	timer *time.Timer
}

// bridge: the emulator and the connection to its monitor (the Vice class of the JS)
type bridge struct {
	st       *core.Settings
	opts     bridgeOptions
	listener func(event string, data any)

	opMu    sync.Mutex
	writeMu sync.Mutex
	mu      sync.Mutex

	proc    *viceProc
	exited  bool
	machine string
	exe     string
	port    int

	conn              net.Conn
	connected         bool
	parser            responseParser
	pending           map[uint32]*pendingReq
	nextID            uint32
	stopped           bool
	pc                *int
	lastRegisters     []regValue // nil: none yet
	regNames          map[int]string
	regIDs            map[string]int
	registersInfo     []regInfo
	banks             []bank // nil: not known
	version           *string
	inducing          int
	realStop          bool
	swallowResume     int
	stopSeq           int
	stopWaiters       []*stopWaiter
	pendingCheckpoint *checkpoint
	conditions        map[uint32]string
	reconnecting      bool
}

func newBridge(st *core.Settings, opts bridgeOptions) *bridge {
	if opts.requestTimeout == 0 {
		opts.requestTimeout = 5 * time.Second
	}
	if opts.connectTimeout == 0 {
		opts.connectTimeout = 20 * time.Second
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
	b.parser = responseParser{}
	b.pending = map[uint32]*pendingReq{}
	b.nextID = 1
	b.stopped = false
	b.pc = nil
	b.lastRegisters = nil
	b.regNames = map[int]string{} // id -> lowercased name
	b.regIDs = map[string]int{}   // lowercased name -> id
	b.banks = nil
	b.version = nil
	b.inducing = 0
	b.realStop = false
	b.swallowResume = 0
	b.stopSeq = 0
	b.stopWaiters = nil
	b.pendingCheckpoint = nil
	b.conditions = map[uint32]string{}
}

// emit: an event to the listener (mu held)
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

func (b *bridge) statusLocked() viceStatus {
	r := b.runningLocked()
	s := viceStatus{Running: r, Connected: b.connected, PC: b.pc, Version: b.version, Exe: strp(b.exe)}
	if r && b.connected {
		s.Stopped = b.stopped
	}
	if r {
		s.Machine = strp(b.machine)
	}
	return s
}

func (b *bridge) status() viceStatus {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.statusLocked()
}

// ------------------------------------------------------------ lifecycle

// startOpts: the machine, a program instead of the one found, more arguments, a port (0 - a free one)
type startOpts struct {
	machine string
	exe     string
	args    []string
	port    int
}

func (b *bridge) start(o startOpts) (viceStatus, error) {
	if b.running() {
		b.stop()
	}
	if o.machine == "" {
		o.machine = "c64"
	}
	exePath, err := findExecutable(b.st, o.machine, o.exe)
	if err != nil {
		return viceStatus{}, err
	}
	if exePath == "" {
		return viceStatus{}, vErr(404, "VICE executable for %s not found", o.machine)
	}
	port := o.port
	if port == 0 {
		if port, err = getFreePort(); err != nil {
			return viceStatus{}, err
		}
	}
	b.mu.Lock()
	b.reset()
	b.exited = false
	b.machine = o.machine
	b.exe = exePath
	b.port = port
	b.mu.Unlock()
	argv := append([]string{
		"-binarymonitor",
		"-binarymonitoraddress", fmt.Sprintf("ip4://127.0.0.1:%d", port),
		"-autostartprgmode", "1", // inject PRG into RAM
		"-jamaction", "2", // on CPU JAM enter the monitor (sends JAM event) instead of a dialog
	}, o.args...)
	proc, err := b.opts.spawn(exePath, argv, &logWriter{b})
	if err != nil {
		// it did not start: as an emulator that ended at once
		proc = &viceProc{wait: func() (int, *string) { return -1, nil }, kill: func(bool) {}, done: make(chan struct{})}
		b.mu.Lock()
		b.proc = proc
		b.emit("log", logEvent{Text: "failed to start VICE: " + err.Error()})
		b.mu.Unlock()
	} else {
		b.mu.Lock()
		b.proc = proc
		b.mu.Unlock()
	}
	exited := make(chan struct{})
	go func() {
		code, signal := proc.wait()
		b.onExit(proc, code, signal)
		close(exited)
	}()
	if err != nil {
		<-exited
	}
	if err := b.connect(b.opts.connectTimeout); err != nil {
		b.kill()
		return viceStatus{}, err
	}
	b.mu.Lock()
	b.emit("status", b.statusLocked())
	s := b.statusLocked()
	b.mu.Unlock()
	return s, nil
}

// onExit: the emulator has ended
func (b *bridge) onExit(p *viceProc, code int, signal *string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.exited = true
	b.onDisconnect(vErr(409, "VICE exited"), true)
	if b.proc == p {
		b.proc = nil
	}
	b.emit("exit", exitEvent{Code: code, Signal: signal})
	b.emit("status", b.statusLocked())
	close(p.done)
}

// dialError: the message of a failed connect (as Node words it for a refused one)
func dialError(err error, port int) string {
	var errno syscall.Errno
	if errors.As(err, &errno) && (errno == syscall.ECONNREFUSED || (core.IsWindows && errno == 10061)) {
		return fmt.Sprintf("connect ECONNREFUSED 127.0.0.1:%d", port)
	}
	return err.Error()
}

func (b *bridge) connect(timeout time.Duration) error {
	t0 := time.Now()
	var lastErr string
	for time.Since(t0) < timeout {
		b.mu.Lock()
		running, port := b.runningLocked(), b.port
		b.mu.Unlock()
		if !running {
			return vErr(500, "VICE exited during startup")
		}
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), timeout)
		if err == nil {
			b.mu.Lock()
			b.attach(conn)
			b.mu.Unlock()
			if err = b.handshake(); err == nil {
				return nil
			}
			lastErr = err.Error()
		} else {
			lastErr = dialError(err, port)
		}
		b.mu.Lock()
		if b.conn != nil {
			b.conn.Close()
			b.conn = nil
			b.connected = false
		}
		b.mu.Unlock()
		time.Sleep(250 * time.Millisecond)
	}
	if lastErr == "" {
		lastErr = "timeout"
	}
	return vErr(504, "cannot connect to VICE monitor: %s", lastErr)
}

// attach: a connected socket (mu held); its reader runs until it closes
func (b *bridge) attach(conn net.Conn) {
	if tc, ok := conn.(*net.TCPConn); ok {
		tc.SetNoDelay(true)
	}
	b.conn = conn
	b.connected = true
	b.parser.reset()
	go b.readLoop(conn)
}

func (b *bridge) readLoop(conn net.Conn) {
	buf := make([]byte, 64*1024)
	for {
		n, err := conn.Read(buf)
		if n > 0 {
			b.mu.Lock()
			if b.conn == conn {
				for _, f := range b.parser.push(buf[:n]) {
					b.onFrame(f)
				}
			}
			b.mu.Unlock()
		}
		if err != nil {
			b.mu.Lock()
			if b.conn == conn {
				if !errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) {
					b.emit("log", logEvent{Text: "monitor socket error: " + err.Error()})
				}
				b.onDisconnect(vErr(503, "connection to VICE lost"), false)
			}
			b.mu.Unlock()
			return
		}
	}
}

// onDisconnect: the connection is gone (mu held) - the waiting requests fail; final: VICE has
// ended, else it is connected again
func (b *bridge) onDisconnect(err error, final bool) {
	wasConnected := b.connected
	b.connected = false
	if b.conn != nil {
		b.conn.Close()
		b.conn = nil
	}
	for id, p := range b.pending {
		p.timer.Stop()
		p.ch <- sendResult{err: err}
		delete(b.pending, id)
	}
	for _, w := range b.stopWaiters {
		w.timer.Stop()
		w.p.ch <- sendResult{err: err}
	}
	b.stopWaiters = nil
	b.inducing = 0
	if wasConnected && !final {
		b.emit("status", b.statusLocked())
		if !b.reconnecting {
			b.reconnecting = true
			go b.reconnect()
		}
	}
}

func (b *bridge) reconnect() {
	for i := 0; i < 20; i++ {
		b.mu.Lock()
		again := b.runningLocked() && !b.connected
		if again {
			b.emit("log", logEvent{Text: "reconnecting to VICE monitor..."})
		}
		b.mu.Unlock()
		if !again {
			break
		}
		if b.connect(2*time.Second) == nil {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	b.mu.Lock()
	if b.connected {
		b.emit("status", b.statusLocked())
	}
	b.reconnecting = false
	b.mu.Unlock()
}

func (b *bridge) handshake() error {
	b.mu.Lock()
	wantStopped := b.stopped // keep the state we had before a reconnect
	b.mu.Unlock()
	// PING stops the CPU (if running); we then query static info and resume.
	if _, err := b.send(build.ping(), sendOpts{timeout: 3 * time.Second}); err != nil {
		return err
	}
	b.mu.Lock()
	b.stopped = true
	b.mu.Unlock()
	r, err := b.send(build.viceInfo(), sendOpts{})
	if err != nil {
		return err
	}
	info, err := parse.viceInfo(r.frame.body)
	if err != nil {
		return err
	}
	if r, err = b.send(build.registersAvailable(0), sendOpts{}); err != nil {
		return err
	}
	avail, err := parse.registersAvailable(r.frame.body)
	if err != nil {
		return err
	}
	var banks []bank
	if r, err := b.send(build.banksAvailable(), sendOpts{}); err == nil {
		banks, err = parse.banksAvailable(r.frame.body)
		if err != nil {
			banks = []bank{}
		}
	} else {
		banks = []bank{}
	}
	b.mu.Lock()
	b.version = &info.version
	b.regNames = map[int]string{}
	b.regIDs = map[string]int{}
	for _, a := range avail {
		b.regNames[a.ID] = strings.ToLower(a.Name)
		b.regIDs[strings.ToLower(a.Name)] = a.ID
	}
	b.registersInfo = avail
	b.banks = banks
	b.mu.Unlock()
	if r, err = b.send(build.registersGet(0), sendOpts{}); err != nil {
		return err
	}
	rs, err := parse.registerInfo(r.frame.body)
	if err != nil {
		return err
	}
	b.mu.Lock()
	b.lastRegisters = rs
	if pc, ok := b.regsToObject(rs).get("pc"); ok {
		b.pc = intp(pc)
	}
	if !wantStopped {
		b.swallowResume++
	}
	b.mu.Unlock()
	if !wantStopped {
		if _, err := b.send(build.exit(), sendOpts{}); err != nil {
			return err
		}
		b.mu.Lock()
		b.stopped = false
		b.mu.Unlock()
	}
	return nil
}

func (b *bridge) stop() viceStatus {
	b.mu.Lock()
	proc, connected := b.proc, b.connected
	b.mu.Unlock()
	if proc == nil {
		return b.status()
	}
	if connected {
		b.send(build.quit(), sendOpts{timeout: 2 * time.Second})
	}
	done := waitDone(proc.done, 3*time.Second)
	b.mu.Lock()
	same := b.proc == proc
	b.mu.Unlock()
	if !done && same {
		b.kill()
	}
	return b.status()
}

func (b *bridge) kill() {
	b.mu.Lock()
	proc := b.proc
	b.mu.Unlock()
	if proc == nil {
		return
	}
	proc.kill(false)
	if !waitDone(proc.done, 3*time.Second) {
		proc.kill(true)
		waitDone(proc.done, 2*time.Second)
	}
}

func waitDone(ch chan struct{}, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ch:
		return true
	case <-t.C:
		return false
	}
}

// ------------------------------------------------------------ transport

// assertConnected (mu held)
func (b *bridge) assertConnected() error {
	if !b.runningLocked() {
		return vErr(409, "VICE is not running")
	}
	if !b.connected {
		return vErr(503, "not connected to VICE monitor")
	}
	return nil
}

// send: a command; the response frame (for CHECKPOINT_LIST the frames and the count). With
// o.awaitStop it also waits for the next STOPPED event after the response.
func (b *bridge) send(r request, o sendOpts) (sendResult, error) {
	b.writeMu.Lock()
	b.mu.Lock()
	if b.conn == nil || !b.connected {
		b.mu.Unlock()
		b.writeMu.Unlock()
		return sendResult{}, vErr(503, "not connected to VICE monitor")
	}
	id := b.nextID
	b.nextID++
	if b.nextID >= 0xfffffff0 {
		b.nextID = 1
	}
	timeout := o.timeout
	if timeout == 0 {
		timeout = b.opts.requestTimeout
	}
	p := &pendingReq{command: r.command, ch: make(chan sendResult, 1), awaitStop: o.awaitStop, stopTimeout: o.stopTimeout, inducing: !b.stopped}
	if p.stopTimeout == 0 {
		p.stopTimeout = 10 * time.Second
	}
	if p.inducing {
		b.inducing++
	}
	p.timer = time.AfterFunc(timeout, func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		if b.pending[id] != p {
			return
		}
		delete(b.pending, id)
		if p.inducing {
			b.inducing = max(0, b.inducing-1)
		}
		p.ch <- sendResult{err: vErr(504, "timeout waiting for VICE response to command 0x%x", r.command)}
	})
	b.pending[id] = p
	conn := b.conn
	b.mu.Unlock()
	if _, err := conn.Write(encodeRequest(id, r.command, r.body)); err != nil {
		conn.Close() // the reader ends and the request fails with the connection
	}
	b.writeMu.Unlock()
	res := <-p.ch
	return res, res.err
}

// onFrame: a response or an event (mu held)
func (b *bridge) onFrame(f frame) {
	if !f.isEvent {
		p := b.pending[f.requestID]
		if p == nil {
			return
		}
		if p.command == cmdCheckpointList && f.typ == respCheckpointInfo && f.err == 0 {
			p.frames = append(p.frames, f)
			return
		}
		delete(b.pending, f.requestID)
		p.timer.Stop()
		if p.inducing {
			b.inducing = max(0, b.inducing-1)
		}
		if f.err != 0 {
			p.ch <- sendResult{err: &protocolError{code: f.err, command: p.command}}
			return
		}
		// These commands resume the CPU; VICE sends RESUMED right after the response
		// (possibly in a later TCP chunk). Update the state in stream order now.
		if resuming[p.command] {
			b.stopped = false
		}
		if f.typ == respRegisterInfo {
			if rs, err := parse.registerInfo(f.body); err == nil {
				b.lastRegisters = rs
			}
		}
		if p.command == cmdCheckpointList {
			count, err := parse.checkpointList(f.body)
			p.ch <- sendResult{frames: p.frames, count: count, err: err}
			return
		}
		if p.awaitStop {
			w := &stopWaiter{p: p}
			w.timer = time.AfterFunc(p.stopTimeout, func() {
				b.mu.Lock()
				defer b.mu.Unlock()
				for i, x := range b.stopWaiters {
					if x == w {
						b.stopWaiters = append(b.stopWaiters[:i:i], b.stopWaiters[i+1:]...)
						p.ch <- sendResult{err: vErr(504, "emulator did not stop in time (still running)")}
						return
					}
				}
			})
			b.stopWaiters = append(b.stopWaiters, w)
			p.frames = []frame{f}
			return
		}
		p.ch <- sendResult{frame: f}
		return
	}
	switch f.typ {
	case respRegisterInfo:
		if rs, err := parse.registerInfo(f.body); err == nil {
			b.lastRegisters = rs
		} else {
			b.emit("log", logEvent{Text: "protocol error: " + err.Error()})
		}
	case respCheckpointInfo:
		info, err := parse.checkpointInfo(f.body)
		if err != nil {
			b.emit("log", logEvent{Text: "protocol error: " + err.Error()})
			return
		}
		cp := b.checkpointToJSON(info)
		if cp.Stop {
			b.pendingCheckpoint = &cp
			b.realStop = true
		} else {
			b.emit("checkpoint", checkpointEvent{cp, b.pc})
		}
	case respJam:
		pc, err := parse.pc(f.body)
		if err != nil {
			b.emit("log", logEvent{Text: "protocol error: " + err.Error()})
			return
		}
		b.pc = intp(pc)
		b.realStop = true
		b.emit("jam", pcEvent{intp(pc)})
	case respStopped:
		pc, err := parse.pc(f.body)
		if err != nil {
			b.emit("log", logEvent{Text: "protocol error: " + err.Error()})
			return
		}
		b.stopped = true
		b.pc = intp(pc)
		b.swallowResume = 0
		registers := regs{{"pc", pc}}
		if b.lastRegisters != nil {
			registers = b.regsToObject(b.lastRegisters)
		}
		induced := b.inducing > 0 && !b.realStop
		b.realStop = false
		if b.pendingCheckpoint != nil {
			cp := *b.pendingCheckpoint
			b.pendingCheckpoint = nil
			b.emit("checkpoint", checkpointEvent{cp, intp(pc)})
		}
		waiters := b.stopWaiters
		b.stopWaiters = nil
		for _, w := range waiters {
			w.timer.Stop()
			w.p.ch <- sendResult{frame: w.p.frames[0], stop: stopInfo{PC: intp(pc), Registers: registers}}
		}
		if !induced {
			b.stopSeq++
			b.emit("stopped", stopInfo{PC: intp(pc), Registers: registers})
		}
	case respResumed:
		pc, err := parse.pc(f.body)
		if err != nil {
			b.emit("log", logEvent{Text: "protocol error: " + err.Error()})
			return
		}
		b.stopped = false
		b.pc = intp(pc)
		if b.swallowResume > 0 {
			b.swallowResume--
		} else {
			b.emit("resumed", pcEvent{intp(pc)})
		}
	}
}

// exclusive: serialize high level operations
func exclusive[T any](b *bridge, fn func() (T, error)) (T, error) {
	b.opMu.Lock()
	defer b.opMu.Unlock()
	b.mu.Lock()
	err := b.assertConnected()
	b.mu.Unlock()
	if err != nil {
		var zero T
		return zero, err
	}
	return fn()
}

// transient: run fn with the CPU stopped; if it was running, resume silently afterwards
func transient[T any](b *bridge, fn func() (T, error)) (T, error) {
	return exclusive(b, func() (T, error) {
		b.mu.Lock()
		wasRunning, seq := !b.stopped, b.stopSeq
		b.mu.Unlock()
		v, err := fn()
		b.mu.Lock()
		resume := wasRunning && b.stopped && seq == b.stopSeq && b.connected
		if resume {
			b.swallowResume++
		}
		b.mu.Unlock()
		if resume {
			b.send(build.exit(), sendOpts{})
		}
		return v, err
	})
}

// ------------------------------------------------------------ helpers

// regsToObject (mu held)
func (b *bridge) regsToObject(rs []regValue) regs {
	o := regs{}
	for _, r := range rs {
		name, ok := b.regNames[r.id]
		if !ok {
			name = "r" + strconv.Itoa(r.id)
		}
		dup := false
		for i := range o {
			if o[i].name == name {
				o[i].value, dup = r.value, true
				break
			}
		}
		if !dup {
			o = append(o, regKV{name, r.value})
		}
	}
	return o
}

// checkpointToJSON (mu held)
func (b *bridge) checkpointToJSON(cp checkpointInfo) checkpoint {
	out := checkpoint{
		ID: cp.id, Start: cp.start, End: cp.end, Stop: cp.stop, Enabled: cp.enabled,
		Exec: cp.exec, Load: cp.load, Store: cp.store, Temporary: cp.temporary,
		Hits: cp.hits, Ignored: cp.ignored, Hit: cp.hit, Memspace: cp.memspace,
	}
	if c, ok := b.conditions[cp.id]; ok {
		out.Condition = &c
	} else if cp.hasCondition {
		out.Condition = new(string)
	}
	return out
}

func (b *bridge) lockedRegs(rs []regValue) regs {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.regsToObject(rs)
}

func (b *bridge) lockedCheckpoint(cp checkpointInfo) checkpoint {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.checkpointToJSON(cp)
}

// sendBody: a command whose response body is all that counts
func (b *bridge) sendBody(r request, err error, o sendOpts) ([]byte, error) {
	if err != nil {
		return nil, err
	}
	res, err := b.send(r, o)
	if err != nil {
		return nil, err
	}
	return res.frame.body, nil
}

// ------------------------------------------------------------ the operations

// request: a raw command (no transient handling)
func (b *bridge) request(r request, o sendOpts) (sendResult, error) {
	return exclusive(b, func() (sendResult, error) { return b.send(r, o) })
}

func (b *bridge) pause() (stopInfo, error) {
	return exclusive(b, func() (stopInfo, error) {
		b.mu.Lock()
		stopped := b.stopped
		b.mu.Unlock()
		if !stopped {
			if _, err := b.send(build.ping(), sendOpts{}); err != nil {
				return stopInfo{}, err
			}
			b.mu.Lock()
			defer b.mu.Unlock()
			b.stopped = true
			s := stopInfo{PC: b.pc, Registers: b.regsToObject(b.lastRegisters)}
			b.stopSeq++
			b.emit("stopped", s)
			return s, nil
		}
		body, err := b.sendBody(build.registersGet(0), nil, sendOpts{})
		if err != nil {
			return stopInfo{}, err
		}
		rs, err := parse.registerInfo(body)
		if err != nil {
			return stopInfo{}, err
		}
		registers := b.lockedRegs(rs)
		pc, ok := registers.get("pc")
		if !ok {
			b.mu.Lock()
			defer b.mu.Unlock()
			return stopInfo{PC: b.pc, Registers: registers}, nil
		}
		return stopInfo{PC: intp(pc), Registers: registers}, nil
	})
}

func (b *bridge) resume() (viceStatus, error) {
	return exclusive(b, func() (viceStatus, error) {
		b.mu.Lock()
		stopped := b.stopped
		b.mu.Unlock()
		if stopped {
			if _, err := b.send(build.exit(), sendOpts{}); err != nil {
				return viceStatus{}, err
			}
		}
		return b.status(), nil
	})
}

func (b *bridge) step(count int, over bool) (stopInfo, error) {
	return exclusive(b, func() (stopInfo, error) {
		r, err := b.send(build.advanceInstructions(max(1, min(0xffff, count)), over), sendOpts{awaitStop: true})
		return r.stop, err
	})
}

func (b *bridge) stepReturn() (stopInfo, error) {
	return exclusive(b, func() (stopInfo, error) {
		r, err := b.send(build.executeUntilReturn(), sendOpts{awaitStop: true})
		return r.stop, err
	})
}

func (b *bridge) resetCPU(hard bool) (viceStatus, error) {
	return exclusive(b, func() (viceStatus, error) {
		t := resetSoft
		if hard {
			t = resetHard
		}
		if _, err := b.send(build.reset(t), sendOpts{}); err != nil {
			return viceStatus{}, err
		}
		return b.status(), nil
	})
}

func (b *bridge) autostart(file string, run bool) (viceStatus, error) {
	return exclusive(b, func() (viceStatus, error) {
		r, err := build.autostart(file, run, 0)
		if _, err := b.sendBody(r, err, sendOpts{timeout: 15 * time.Second}); err != nil {
			return viceStatus{}, err
		}
		return b.status(), nil
	})
}

func (b *bridge) getRegisters() (regs, error) {
	return transient(b, func() (regs, error) {
		body, err := b.sendBody(build.registersGet(0), nil, sendOpts{})
		if err != nil {
			return nil, err
		}
		rs, err := parse.registerInfo(body)
		if err != nil {
			return nil, err
		}
		return b.lockedRegs(rs), nil
	})
}

// regEntry: a register to set as the request names it, and its value (a JSON value)
type regEntry struct {
	name  string
	value any
}

func (b *bridge) setRegisters(values []regEntry) (regs, error) {
	var items []regValue
	b.mu.Lock()
	for _, e := range values {
		id, ok := b.regIDs[strings.ToLower(e.name)]
		if !ok {
			b.mu.Unlock()
			return nil, vErr(400, "unknown register '%s'", e.name)
		}
		f, isNum := e.value.(float64)
		if !isNum || !isInteger(f) {
			b.mu.Unlock()
			return nil, vErr(400, "register '%s' needs an integer value", e.name)
		}
		items = append(items, regValue{id: id, value: toU16(f)})
	}
	b.mu.Unlock()
	return transient(b, func() (regs, error) {
		if len(items) > 0 {
			if _, err := b.send(build.registersSet(items, 0), sendOpts{}); err != nil {
				return nil, err
			}
		}
		body, err := b.sendBody(build.registersGet(0), nil, sendOpts{})
		if err != nil {
			return nil, err
		}
		rs, err := parse.registerInfo(body)
		if err != nil {
			return nil, err
		}
		b.mu.Lock()
		defer b.mu.Unlock()
		o := b.regsToObject(rs)
		if pc, ok := o.get("pc"); ok {
			b.pc = intp(pc)
		}
		return o, nil
	})
}

func (b *bridge) readMemory(start, end int, o memOpts) ([]byte, error) {
	return transient(b, func() ([]byte, error) {
		r, err := build.memoryGet(start, end, o)
		body, err := b.sendBody(r, err, sendOpts{})
		if err != nil {
			return nil, err
		}
		return parse.memoryGet(body)
	})
}

func (b *bridge) writeMemory(start int, data []byte, o memOpts) (bool, error) {
	return transient(b, func() (bool, error) {
		r, err := build.memorySet(start, data, o)
		if _, err := b.sendBody(r, err, sendOpts{}); err != nil {
			return false, err
		}
		return true, nil
	})
}

func (b *bridge) getBanks() ([]bank, error) {
	b.mu.Lock()
	banks := b.banks
	b.mu.Unlock()
	if banks != nil {
		return banks, nil
	}
	return transient(b, func() ([]bank, error) {
		body, err := b.sendBody(build.banksAvailable(), nil, sendOpts{})
		if err != nil {
			return nil, err
		}
		banks, err := parse.banksAvailable(body)
		if err != nil {
			return nil, err
		}
		b.mu.Lock()
		b.banks = banks
		b.mu.Unlock()
		return banks, nil
	})
}

func (b *bridge) listCheckpoints() ([]checkpoint, error) {
	return transient(b, func() ([]checkpoint, error) {
		r, err := b.send(build.checkpointList(), sendOpts{})
		if err != nil {
			return nil, err
		}
		out := []checkpoint{}
		for _, f := range r.frames {
			info, err := parse.checkpointInfo(f.body)
			if err != nil {
				return nil, err
			}
			out = append(out, b.lockedCheckpoint(info))
		}
		return out, nil
	})
}

// fetchCheckpoint: a checkpoint as VICE has it (in an operation)
func (b *bridge) fetchCheckpoint(id uint32) (checkpointInfo, error) {
	body, err := b.sendBody(build.checkpointGet(id), nil, sendOpts{})
	if err != nil {
		return checkpointInfo{}, err
	}
	return parse.checkpointInfo(body)
}

func (b *bridge) getCheckpoint(id uint32) (checkpoint, error) {
	return transient(b, func() (checkpoint, error) {
		info, err := b.fetchCheckpoint(id)
		if err != nil {
			return checkpoint{}, err
		}
		return b.lockedCheckpoint(info), nil
	})
}

func (b *bridge) setCheckpoint(o checkpointOpts) (checkpoint, error) {
	return transient(b, func() (checkpoint, error) {
		r, err := build.checkpointSet(o)
		body, err := b.sendBody(r, err, sendOpts{})
		if err != nil {
			return checkpoint{}, err
		}
		cp, err := parse.checkpointInfo(body)
		if err != nil {
			return checkpoint{}, err
		}
		if o.condition != "" {
			r, err := build.conditionSet(cp.id, o.condition)
			if _, err = b.sendBody(r, err, sendOpts{}); err != nil {
				b.send(build.checkpointDelete(cp.id), sendOpts{})
				return checkpoint{}, vErr(400, "invalid condition '%s': %s", o.condition, err.Error())
			}
			b.mu.Lock()
			b.conditions[cp.id] = o.condition
			b.mu.Unlock()
			if cp, err = b.fetchCheckpoint(cp.id); err != nil {
				return checkpoint{}, err
			}
		}
		return b.lockedCheckpoint(cp), nil
	})
}

func (b *bridge) toggleCheckpoint(id uint32, enabled bool) (checkpoint, error) {
	return transient(b, func() (checkpoint, error) {
		if _, err := b.send(build.checkpointToggle(id, enabled), sendOpts{}); err != nil {
			return checkpoint{}, err
		}
		info, err := b.fetchCheckpoint(id)
		if err != nil {
			return checkpoint{}, err
		}
		return b.lockedCheckpoint(info), nil
	})
}

func (b *bridge) deleteCheckpoint(id uint32) (bool, error) {
	return transient(b, func() (bool, error) {
		if _, err := b.send(build.checkpointDelete(id), sendOpts{}); err != nil {
			return false, err
		}
		b.mu.Lock()
		delete(b.conditions, id)
		b.mu.Unlock()
		return true, nil
	})
}

// getDisplay: the screen in RGBA; vdc - the VDC of the C128 instead of the VIC-II
func (b *bridge) getDisplay(vdc bool) (displayFrame, error) {
	return transient(b, func() (displayFrame, error) {
		body, err := b.sendBody(build.displayGet(!vdc, 0), nil, sendOpts{timeout: 10 * time.Second})
		if err != nil {
			return displayFrame{}, err
		}
		d, err := parse.displayGet(body)
		if err != nil {
			return displayFrame{}, err
		}
		if body, err = b.sendBody(build.paletteGet(!vdc), nil, sendOpts{}); err != nil {
			return displayFrame{}, err
		}
		palette, err := parse.paletteGet(body)
		if err != nil {
			return displayFrame{}, err
		}
		return displayFrame{d.width, d.height, d.innerX, d.innerY, d.innerWidth, d.innerHeight, indexedToRgba(d.pixels, palette)}, nil
	})
}

// feedKeyboard: text converted to PETSCII
func (b *bridge) feedKeyboard(text string) (bool, error) {
	return b.feedKeyboardBytes(textToPetscii(text))
}

// feedKeyboardBytes: raw PETSCII
func (b *bridge) feedKeyboardBytes(data []byte) (bool, error) {
	return transient(b, func() (bool, error) {
		for o := 0; o < len(data); o += 255 {
			r, err := build.keyboardFeed(data[o:min(len(data), o+255)])
			if _, err := b.sendBody(r, err, sendOpts{}); err != nil {
				return false, err
			}
		}
		return true, nil
	})
}

func (b *bridge) setJoystick(port, value int) (bool, error) {
	return transient(b, func() (bool, error) {
		if _, err := b.send(build.joyportSet(port, value), sendOpts{}); err != nil {
			return false, err
		}
		return true, nil
	})
}

func (b *bridge) setUserport(value int) (bool, error) {
	return transient(b, func() (bool, error) {
		if _, err := b.send(build.userportSet(value), sendOpts{}); err != nil {
			return false, err
		}
		return true, nil
	})
}

func (b *bridge) getResource(name string) (any, error) {
	return transient(b, func() (any, error) {
		r, err := build.resourceGet(name)
		body, err := b.sendBody(r, err, sendOpts{})
		if err != nil {
			return nil, err
		}
		return parse.resourceGet(body)
	})
}

func (b *bridge) setResource(name string, value any) (bool, error) {
	return transient(b, func() (bool, error) {
		r, err := build.resourceSet(name, value)
		if _, err := b.sendBody(r, err, sendOpts{}); err != nil {
			return false, err
		}
		return true, nil
	})
}

func (b *bridge) dump(file string, saveRoms, saveDisks bool) (bool, error) {
	return transient(b, func() (bool, error) {
		r, err := build.dump(file, saveRoms, saveDisks)
		if _, err := b.sendBody(r, err, sendOpts{timeout: 15 * time.Second}); err != nil {
			return false, err
		}
		return true, nil
	})
}

func (b *bridge) undump(file string) (int, error) {
	return transient(b, func() (int, error) {
		r, err := build.undump(file)
		body, err := b.sendBody(r, err, sendOpts{timeout: 15 * time.Second})
		if err != nil {
			return 0, err
		}
		return parse.undump(body)
	})
}
