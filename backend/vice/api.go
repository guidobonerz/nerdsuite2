package vice

// The HTTP/JSON + Server-Sent-Events API of the VICE bridge, under /api/vice:
//   GET  events                 the events: status, stopped, resumed, checkpoint, jam, exit, log
//   GET  status                 { available, exe, running, connected, stopped, pc, machine, version }
//   POST start { machine, args, exe }, stop, load { name, prg (base64), run }, pause, continue,
//        step { count, over }, return, reset { hard }, keyboard { text }, joystick { port, value }
//   GET  registers, POST registers { a: 1, ... }; GET memory ?start&end&bank&sideEffects&memspace,
//   POST memory { start, data (base64), bank, sideEffects, memspace }; GET banks; GET display ?vdc
//   GET/POST checkpoints, GET/POST/PUT/PATCH/DELETE checkpoints/<id>
// The values of a request are as loose as the JS takes them: numbers as "$c000", "0xc000" or
// "49152", flags as true, 1, "1" or "true".

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf16"

	"nerdsuite/backend/core"
)

const prefix = "/api/vice"

// maxBody: the largest request (a program in base64)
const maxBody = 32 * 1024 * 1024

// heartbeat: how often the event streams get a comment, so that no proxy closes them
const heartbeat = 15 * time.Second

// API: the bridge and the clients of its events
type API struct {
	env    core.Env
	tmpDir string
	vice   *bridge

	mu          sync.Mutex
	clients     map[*sseClient]struct{}
	lastMachine string

	closed    chan struct{}
	closeOnce sync.Once
}

// New: the API; the programs loaded go to env.TmpDir (else nerdsuite-vice in the temp folder)
func New(env core.Env) *API { return newAPI(env, bridgeOptions{}) }

func newAPI(env core.Env, opts bridgeOptions) *API {
	tmp := env.TmpDir
	if tmp == "" {
		tmp = filepath.Join(os.TempDir(), "nerdsuite-vice")
	}
	if env.Settings == nil {
		env.Settings = core.NewSettings("")
	}
	a := &API{env: env, tmpDir: tmp, clients: map[*sseClient]struct{}{}, lastMachine: "c64", closed: make(chan struct{})}
	a.vice = newBridge(env.Settings, opts)
	a.vice.listener = func(event string, data any) {
		if event == "status" {
			data = a.statusOf(data.(viceStatus))
		}
		a.broadcast(event, data)
	}
	go a.heartbeat()
	return a
}

// Close: the event streams end and VICE is stopped
func (a *API) Close() {
	a.closeOnce.Do(func() {
		close(a.closed)
		a.mu.Lock()
		for c := range a.clients {
			c.end()
		}
		a.clients = map[*sseClient]struct{}{}
		a.mu.Unlock()
		a.vice.stop()
	})
}

// apiStatus: the status the IDE shows
type apiStatus struct {
	Available bool    `json:"available"`
	Exe       *string `json:"exe"`
	Running   bool    `json:"running"`
	Connected bool    `json:"connected"`
	Stopped   bool    `json:"stopped"`
	PC        *int    `json:"pc"`
	Machine   *string `json:"machine"`
	Version   *string `json:"version"`
}

func (a *API) status() apiStatus { return a.statusOf(a.vice.status()) }

// statusOf: the status of a state of the bridge - whether VICE is there, and where
func (a *API) statusOf(s viceStatus) apiStatus {
	exe := s.Exe
	available := false
	machine := ""
	if s.Machine != nil {
		machine = *s.Machine
	} else {
		a.mu.Lock()
		machine = a.lastMachine
		a.mu.Unlock()
	}
	if found, err := findExecutable(a.env.Settings, machine, ""); err == nil {
		available = found != "" || (s.Running && s.Exe != nil)
		if !s.Running {
			exe = strp(found)
		}
	}
	out := apiStatus{Available: available, Exe: exe, Running: s.Running, Connected: s.Connected, Stopped: s.Stopped,
		Machine: s.Machine, Version: s.Version}
	if s.Running {
		out.PC = s.PC
	}
	return out
}

// ---------------------------------------------------------------- the events

// sseClient: an event stream; what is to be written waits in queue
type sseClient struct {
	mu     sync.Mutex
	queue  [][]byte
	notify chan struct{}
	done   chan struct{}
	once   sync.Once
}

func newClient() *sseClient {
	return &sseClient{notify: make(chan struct{}, 1), done: make(chan struct{})}
}

func (c *sseClient) push(msg []byte) {
	c.mu.Lock()
	c.queue = append(c.queue, msg)
	c.mu.Unlock()
	select {
	case c.notify <- struct{}{}:
	default:
	}
}

func (c *sseClient) take() [][]byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	q := c.queue
	c.queue = nil
	return q
}

func (c *sseClient) end() { c.once.Do(func() { close(c.done) }) }

func (a *API) broadcast(event string, data any) {
	body, err := json.Marshal(data)
	if err != nil {
		return
	}
	msg := []byte(fmt.Sprintf("event: %s\ndata: %s\n\n", event, body))
	a.mu.Lock()
	defer a.mu.Unlock()
	for c := range a.clients {
		c.push(msg)
	}
}

func (a *API) heartbeat() {
	t := time.NewTicker(heartbeat)
	defer t.Stop()
	for {
		select {
		case <-a.closed:
			return
		case <-t.C:
			a.mu.Lock()
			for c := range a.clients {
				c.push([]byte(": ping\n\n"))
			}
			a.mu.Unlock()
		}
	}
}

func (a *API) openEvents(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-cache, no-transform")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	rc := http.NewResponseController(w)
	rc.SetWriteDeadline(time.Time{}) // the stream stays open: no timeout of the server ends it
	c := newClient()
	st, _ := json.Marshal(a.status())
	c.push([]byte("retry: 2000\n\n"))
	c.push([]byte(fmt.Sprintf("event: status\ndata: %s\n\n", st)))
	select {
	case <-a.closed:
		return
	default:
	}
	a.mu.Lock()
	a.clients[c] = struct{}{}
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		delete(a.clients, c)
		a.mu.Unlock()
	}()
	for {
		for _, msg := range c.take() {
			if _, err := w.Write(msg); err != nil {
				return
			}
		}
		rc.Flush()
		select {
		case <-r.Context().Done():
			return
		case <-c.done:
			return
		case <-c.notify:
		}
	}
}

// ---------------------------------------------------------------- the values of a request

// object: the body of a request - its values by name and the names in the order of the JS
// (Object.entries: the names that are indexes first, then the others as they came)
type object struct {
	isNull bool
	keys   []string
	values map[string]any
}

// jsTypeError: a property of a null body (a TypeError of the JS: the API answers 400)
type jsTypeError struct{ msg string }

func (e *jsTypeError) Error() string { return e.msg }

// get: a value and whether it is there (undefined: not there; null: there, nil)
func (o object) get(name string) (any, bool) {
	if o.isNull {
		panic(&jsTypeError{fmt.Sprintf("Cannot read properties of null (reading '%s')", name)})
	}
	v, ok := o.values[name]
	return v, ok
}

// val: a value, nil when it is not there
func (o object) val(name string) any {
	v, _ := o.get(name)
	return v
}

var indexKey = regexp.MustCompile(`^(0|[1-9][0-9]*)$`)

func isIndex(k string) bool {
	if !indexKey.MatchString(k) {
		return false
	}
	n, err := strconv.ParseUint(k, 10, 64)
	return err == nil && n < 0xffffffff
}

func newObject() object { return object{values: map[string]any{}} }

func (o *object) set(k string, v any) {
	if _, ok := o.values[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.values[k] = v
}

// order: the names in the order of Object.entries
func (o *object) order() {
	var idx, rest []string
	for _, k := range o.keys {
		if isIndex(k) {
			idx = append(idx, k)
		} else {
			rest = append(rest, k)
		}
	}
	for i := 1; i < len(idx); i++ { // a few names only: insertion sort by number
		for j := i; j > 0; j-- {
			a, _ := strconv.ParseUint(idx[j-1], 10, 64)
			b, _ := strconv.ParseUint(idx[j], 10, 64)
			if a <= b {
				break
			}
			idx[j-1], idx[j] = idx[j], idx[j-1]
		}
	}
	o.keys = append(idx, rest...)
}

// entries: the names and their values
func (o object) entries() []regEntry {
	if o.isNull {
		return nil
	}
	out := make([]regEntry, len(o.keys))
	for i, k := range o.keys {
		out[i] = regEntry{k, o.values[k]}
	}
	return out
}

// isJSSpace: what String.prototype.trim removes
func isJSSpace(r rune) bool { return unicode.IsSpace(r) || r == '\uFEFF' }

// parseBody: the JSON of a body as an object; an empty body is {}
func parseBody(data []byte) (object, error) {
	text := strings.TrimFunc(string(data), isJSSpace)
	o := newObject()
	if text == "" {
		return o, nil
	}
	bad := vErr(400, "invalid JSON body")
	dec := json.NewDecoder(strings.NewReader(text))
	tok, err := dec.Token()
	if err != nil {
		return o, bad
	}
	if d, ok := tok.(json.Delim); ok && d == '{' {
		for dec.More() {
			kt, err := dec.Token()
			if err != nil {
				return o, bad
			}
			k, _ := kt.(string)
			var v any
			if err := dec.Decode(&v); err != nil {
				return o, bad
			}
			o.set(k, v)
		}
		if _, err := dec.Token(); err != nil {
			return o, bad
		}
		if _, err := dec.Token(); err != io.EOF {
			return o, bad
		}
		o.order()
		return o, nil
	}
	// not an object: the whole text as one value
	var v any
	if json.Unmarshal([]byte(text), &v) != nil {
		return o, bad
	}
	switch x := v.(type) {
	case nil:
		o.isNull = true
	case []any: // an array: its indexes
		for i, e := range x {
			o.set(strconv.Itoa(i), e)
		}
	case string: // a string: its characters
		for i, u := range utf16.Encode([]rune(x)) {
			o.set(strconv.Itoa(i), string(utf16.Decode([]uint16{u})))
		}
	}
	return o, nil
}

func readBody(r *http.Request) (object, error) {
	data, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if err != nil {
		return newObject(), err
	}
	if len(data) > maxBody {
		return newObject(), vErr(413, "request body too large")
	}
	return parseBody(data)
}

// jsNumberString: a number as String(n) writes it
func jsNumberString(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		return "0"
	}
	if a := math.Abs(f); a >= 1e21 || a < 1e-6 {
		s := strconv.FormatFloat(f, 'e', -1, 64)
		return strings.Replace(strings.Replace(s, "e+0", "e+", 1), "e-0", "e-", 1)
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}

// jsString: a value as String(v)
func jsString(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return x
	case bool:
		return strconv.FormatBool(x)
	case float64:
		return jsNumberString(x)
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			if e != nil {
				parts[i] = jsString(e)
			}
		}
		return strings.Join(parts, ",")
	default:
		return "[object Object]"
	}
}

// truthy: a value as a condition of the JS
func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0 && !math.IsNaN(x)
	case string:
		return x != ""
	default:
		return true
	}
}

var decimal = regexp.MustCompile(`^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$`)

// jsNumber: a string as Number(s)
func jsNumber(s string) float64 {
	s = strings.TrimFunc(s, isJSSpace)
	if s == "" {
		return 0
	}
	if len(s) > 2 && s[0] == '0' {
		base := 0
		switch s[1] {
		case 'x', 'X':
			base = 16
		case 'o', 'O':
			base = 8
		case 'b', 'B':
			base = 2
		}
		if base != 0 {
			return parseDigits(s[2:], base)
		}
	}
	switch s {
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	if !decimal.MatchString(s) {
		return math.NaN()
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return math.NaN()
	}
	return f
}

// parseDigits: digits of a base as a number (NaN for another character)
func parseDigits(s string, base int) float64 {
	if s == "" {
		return math.NaN()
	}
	f := 0.0
	for _, c := range strings.ToLower(s) {
		d := strings.IndexRune("0123456789abcdef"[:base], c)
		if d < 0 {
			return math.NaN()
		}
		f = f*float64(base) + float64(d)
	}
	return f
}

func isInteger(f float64) bool { return !math.IsInf(f, 0) && !math.IsNaN(f) && math.Trunc(f) == f }

// toU16: an integer as the low 16 bits of its 32 bit integer (as v & 0xffff)
func toU16(f float64) int {
	m := math.Mod(f, 65536)
	if m < 0 {
		m += 65536
	}
	return int(m)
}

var dollarHex = regexp.MustCompile(`(?i)^\$[0-9a-f]+$`)
var zeroXHex = regexp.MustCompile(`(?i)^0x[0-9a-f]+$`)

// intRange: the range of a number of a request; def - the value when it is missing (nil: required)
type intRange struct {
	min, max int
	def      *int
}

// toInt: a number of a request - a number, or a string ("$c000", "0xc000", "49152")
func toInt(v any, name string, r intRange) (int, error) {
	if v == nil || v == "" {
		if r.def != nil {
			return *r.def, nil
		}
		return 0, vErr(400, "'%s' is required", name)
	}
	n := math.NaN()
	switch x := v.(type) {
	case float64:
		n = x
	case int:
		n = float64(x)
	case string:
		switch {
		case dollarHex.MatchString(x):
			n = parseDigits(x[1:], 16)
		case zeroXHex.MatchString(x):
			n = parseDigits(x[2:], 16)
		default:
			n = jsNumber(x)
		}
	}
	if !isInteger(n) || n < float64(r.min) || n > float64(r.max) {
		return 0, vErr(400, "'%s' must be an integer %d..%d", name, r.min, r.max)
	}
	return int(n), nil
}

// rng: the range 0..max with a default (or none)
func rng(max int, def ...int) intRange {
	r := intRange{max: max}
	if len(def) > 0 {
		r.def = &def[0]
	}
	return r
}

// flag: a flag of a request; def when it is missing
func flag(v any, def bool) bool {
	if v == nil || v == "" {
		return def
	}
	return v == true || v == 1.0 || v == "1" || v == "true"
}

// decodeBase64: as Buffer.from(s, 'base64') - the url alphabet too, the padding optional, other
// characters skipped, the data ends at the first '='
func decodeBase64(s string) []byte {
	var clean []byte
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '=':
			i = len(s)
		case c == '-':
			clean = append(clean, '+')
		case c == '_':
			clean = append(clean, '/')
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '+', c == '/':
			clean = append(clean, c)
		}
	}
	if len(clean)%4 == 1 { // a single character left is no byte
		clean = clean[:len(clean)-1]
	}
	out, err := base64.RawStdEncoding.DecodeString(string(clean))
	if err != nil {
		return []byte{}
	}
	return out
}

func b64(v any, name string) ([]byte, error) {
	s, ok := v.(string)
	if !ok {
		return nil, vErr(400, "'%s' must be a base64 string", name)
	}
	return decodeBase64(s), nil
}

// errorStatus: the status of the answer to an error
func errorStatus(err error) int {
	var ve *viceError
	var pe *protocolError
	var re *rangeError
	var te *jsTypeError
	switch {
	case errors.As(err, &ve):
		return ve.status
	case errors.As(err, &pe):
		switch pe.code {
		case errObjectMissing:
			return 404
		case errInvalidParameter, errInvalidMemspace, errInvalidLength:
			return 400
		}
		return 502
	case errors.As(err, &re), errors.As(err, &te):
		return 400
	}
	return 500
}

// basename: the last part of a path (both slashes on Windows, as path.basename there)
func basename(p string) string {
	seps := "/"
	if core.IsWindows {
		seps = `/\`
	}
	p = strings.TrimRight(p, seps)
	if i := strings.LastIndexAny(p, seps); i >= 0 {
		p = p[i+1:]
	}
	return p
}

// safeName: a file name of letters, digits, '.', '_', ' ' and '-' (each other UTF-16 unit an '_')
func safeName(s string) string {
	var sb strings.Builder
	for _, r := range s {
		switch {
		case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '.', r == '_', r == ' ', r == '-':
			sb.WriteRune(r)
		case r > 0xffff:
			sb.WriteString("__")
		default:
			sb.WriteByte('_')
		}
	}
	return sb.String()
}

// writeTemp: a program into the temp folder, under its name made safe
func (a *API) writeTemp(name any, data []byte) (string, error) {
	if err := os.MkdirAll(a.tmpDir, 0o755); err != nil {
		return "", err
	}
	n := "program.prg"
	if truthy(name) {
		n = jsString(name)
	}
	base := strings.TrimLeft(safeName(basename(n)), ".")
	if base == "" {
		base = "program.prg"
	}
	if !strings.Contains(base, ".") {
		base += ".prg"
	}
	file, err := filepath.Abs(filepath.Join(a.tmpDir, base))
	if err != nil {
		return "", err
	}
	return file, os.WriteFile(file, data, 0o644)
}

// ---------------------------------------------------------------- the routes

// ServeHTTP: every route under /api/vice
func (a *API) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.EscapedPath()
	if path != prefix && !strings.HasPrefix(path, prefix+"/") {
		core.WriteJSON(w, 404, map[string]any{"error": "not found"})
		return
	}
	defer func() {
		if x := recover(); x != nil {
			te, ok := x.(*jsTypeError)
			if !ok {
				panic(x)
			}
			fail(w, te)
		}
	}()
	if err := a.route(w, r, path); err != nil {
		fail(w, err)
	}
}

func fail(w http.ResponseWriter, err error) {
	core.WriteJSON(w, errorStatus(err), map[string]any{"error": err.Error()})
}

func ok(w http.ResponseWriter, v any) error {
	core.WriteJSON(w, 200, v)
	return nil
}

// answer: the value of an operation, or its error
func answer[T any](w http.ResponseWriter, v T, err error) error {
	if err != nil {
		return err
	}
	return ok(w, v)
}

var okBody = map[string]any{"ok": true}

func (a *API) requireRunning() error {
	if !a.vice.running() {
		return vErr(409, "VICE is not running")
	}
	return nil
}

var checkpointPath = regexp.MustCompile(`^/checkpoints/([0-9]+)$`)

func (a *API) route(w http.ResponseWriter, r *http.Request, path string) error {
	method := strings.ToUpper(r.Method)
	sub := strings.TrimRight(path[len(prefix):], "/")
	if sub == "" {
		sub = "/"
	}
	q := r.URL.Query()
	query := func(name string) any {
		if !q.Has(name) {
			return nil
		}
		return q.Get(name)
	}

	if sub == "/events" && method == "GET" {
		a.openEvents(w, r)
		return nil
	}
	if sub == "/status" && method == "GET" {
		return ok(w, a.status())
	}

	body := newObject()
	if method == "POST" || method == "PUT" || method == "PATCH" {
		var err error
		if body, err = readBody(r); err != nil {
			return err
		}
	}

	switch method + " " + sub {
	case "POST /start":
		machine := "c64"
		if m := body.val("machine"); truthy(m) {
			machine = jsString(m)
		}
		if machineExe(machine) == "" {
			return vErr(400, "unknown machine '%s' (one of %s)", machine, strings.Join(machineIDs(), ", "))
		}
		argsV, has := body.get("args")
		argList, isList := argsV.([]any)
		if has && !isList {
			return vErr(400, "'args' must be an array")
		}
		a.mu.Lock()
		a.lastMachine = machine
		a.mu.Unlock()
		args := []string{}
		for _, x := range argList {
			args = append(args, jsString(x))
		}
		exe := ""
		if e := body.val("exe"); truthy(e) {
			exe = jsString(e)
		}
		if _, err := a.vice.start(startOpts{machine: machine, exe: exe, args: args}); err != nil {
			return err
		}
		return ok(w, a.status())
	case "POST /stop":
		a.vice.stop()
		return ok(w, a.status())
	case "POST /load":
		if err := a.requireRunning(); err != nil {
			return err
		}
		data, err := b64(body.val("prg"), "prg")
		if err != nil {
			return err
		}
		if len(data) < 3 {
			return vErr(400, "'prg' must contain a load address and data")
		}
		file, err := a.writeTemp(body.val("name"), data)
		if err != nil {
			return err
		}
		if _, err := a.vice.autostart(file, flag(body.val("run"), true)); err != nil {
			return err
		}
		return ok(w, a.status())
	case "POST /pause":
		if err := a.requireRunning(); err != nil {
			return err
		}
		s, err := a.vice.pause()
		return answer(w, s, err)
	case "POST /continue":
		if err := a.requireRunning(); err != nil {
			return err
		}
		if _, err := a.vice.resume(); err != nil {
			return err
		}
		return ok(w, a.status())
	case "POST /step":
		if err := a.requireRunning(); err != nil {
			return err
		}
		count, err := toInt(body.val("count"), "count", intRange{min: 1, max: 0xffff, def: intp(1)})
		if err != nil {
			return err
		}
		s, err := a.vice.step(count, flag(body.val("over"), false))
		return answer(w, s, err)
	case "POST /return":
		if err := a.requireRunning(); err != nil {
			return err
		}
		s, err := a.vice.stepReturn()
		return answer(w, s, err)
	case "POST /reset":
		if err := a.requireRunning(); err != nil {
			return err
		}
		if _, err := a.vice.resetCPU(flag(body.val("hard"), false)); err != nil {
			return err
		}
		return ok(w, a.status())
	case "GET /registers":
		if err := a.requireRunning(); err != nil {
			return err
		}
		v, err := a.vice.getRegisters()
		return answer(w, v, err)
	case "POST /registers":
		if err := a.requireRunning(); err != nil {
			return err
		}
		v, err := a.vice.setRegisters(body.entries())
		return answer(w, v, err)
	case "GET /memory":
		if err := a.requireRunning(); err != nil {
			return err
		}
		start, err := toInt(query("start"), "start", rng(0xffff, 0))
		if err != nil {
			return err
		}
		end, err := toInt(query("end"), "end", rng(0xffff, min(0xffff, start+255)))
		if err != nil {
			return err
		}
		if end < start {
			return vErr(400, "'end' must be >= 'start'")
		}
		bk, err := toInt(query("bank"), "bank", rng(0xffff, 0))
		if err != nil {
			return err
		}
		side := flag(query("sideEffects"), false)
		ms, err := toInt(query("memspace"), "memspace", rng(4, 0))
		if err != nil {
			return err
		}
		data, err := a.vice.readMemory(start, end, memOpts{bank: bk, sideEffects: side, memspace: ms})
		if err != nil {
			return err
		}
		return ok(w, map[string]any{"start": start, "end": end, "data": base64.StdEncoding.EncodeToString(data)})
	case "POST /memory":
		if err := a.requireRunning(); err != nil {
			return err
		}
		start, err := toInt(body.val("start"), "start", rng(0xffff))
		if err != nil {
			return err
		}
		data, err := b64(body.val("data"), "data")
		if err != nil {
			return err
		}
		if len(data) == 0 {
			return vErr(400, "'data' is empty")
		}
		if start+len(data) > 0x10000 {
			return vErr(400, "data exceeds address space")
		}
		bk, err := toInt(body.val("bank"), "bank", rng(0xffff, 0))
		if err != nil {
			return err
		}
		side := flag(body.val("sideEffects"), false)
		ms, err := toInt(body.val("memspace"), "memspace", rng(4, 0))
		if err != nil {
			return err
		}
		if _, err := a.vice.writeMemory(start, data, memOpts{bank: bk, sideEffects: side, memspace: ms}); err != nil {
			return err
		}
		return ok(w, okBody)
	case "GET /banks":
		if err := a.requireRunning(); err != nil {
			return err
		}
		v, err := a.vice.getBanks()
		return answer(w, v, err)
	case "GET /checkpoints":
		if err := a.requireRunning(); err != nil {
			return err
		}
		v, err := a.vice.listCheckpoints()
		return answer(w, v, err)
	case "POST /checkpoints":
		if err := a.requireRunning(); err != nil {
			return err
		}
		start, err := toInt(body.val("start"), "start", rng(0xffff))
		if err != nil {
			return err
		}
		end, err := toInt(body.val("end"), "end", rng(0xffff, start))
		if err != nil {
			return err
		}
		if end < start {
			return vErr(400, "'end' must be >= 'start'")
		}
		exec := flag(body.val("exec"), true)
		load := flag(body.val("load"), false)
		store := flag(body.val("store"), false)
		if !exec && !load && !store {
			return vErr(400, "one of exec/load/store must be true")
		}
		condition := ""
		if c := body.val("condition"); truthy(c) {
			condition = jsString(c)
		}
		o := checkpointOpts{start: start, end: end, exec: exec, load: load, store: store,
			stop: flag(body.val("stop"), true), enabled: flag(body.val("enabled"), true), tmp: flag(body.val("temporary"), false),
			condition: condition}
		if o.memspace, err = toInt(body.val("memspace"), "memspace", rng(4, 0)); err != nil {
			return err
		}
		v, err := a.vice.setCheckpoint(o)
		return answer(w, v, err)
	case "GET /display":
		if err := a.requireRunning(); err != nil {
			return err
		}
		d, err := a.vice.getDisplay(flag(query("vdc"), false))
		if err != nil {
			return err
		}
		return ok(w, struct {
			Width       int    `json:"width"`
			Height      int    `json:"height"`
			InnerX      int    `json:"innerX"`
			InnerY      int    `json:"innerY"`
			InnerWidth  int    `json:"innerWidth"`
			InnerHeight int    `json:"innerHeight"`
			RGBA        string `json:"rgba"`
		}{d.width, d.height, d.innerX, d.innerY, d.innerWidth, d.innerHeight, base64.StdEncoding.EncodeToString(d.rgba)})
	case "POST /keyboard":
		if err := a.requireRunning(); err != nil {
			return err
		}
		text, isText := body.val("text").(string)
		if !isText {
			return vErr(400, "'text' must be a string")
		}
		if _, err := a.vice.feedKeyboard(text); err != nil {
			return err
		}
		return ok(w, okBody)
	case "POST /joystick":
		if err := a.requireRunning(); err != nil {
			return err
		}
		// port: control port as printed on the machine (1 or 2; 3.. = extra joyports such as
		// userport adapters). VICE's binary monitor numbers joyports from 0.
		// value bits: 1 up, 2 down, 4 left, 8 right, 16 fire.
		port, err := toInt(body.val("port"), "port", intRange{min: 1, max: 16, def: intp(2)})
		if err != nil {
			return err
		}
		value, err := toInt(body.val("value"), "value", rng(0xffff, 0))
		if err != nil {
			return err
		}
		if _, err := a.vice.setJoystick(port-1, value); err != nil {
			return err
		}
		return ok(w, okBody)
	}

	if m := checkpointPath.FindStringSubmatch(sub); m != nil {
		n, err := toInt(jsNumber(m[1]), "id", rng(0xffffffff))
		if err != nil {
			return err
		}
		id := uint32(n)
		switch method {
		case "POST", "PUT", "PATCH":
			if err := a.requireRunning(); err != nil {
				return err
			}
			enabled, has := body.get("enabled")
			if !has {
				v, err := a.vice.getCheckpoint(id)
				return answer(w, v, err)
			}
			v, err := a.vice.toggleCheckpoint(id, flag(enabled, false))
			return answer(w, v, err)
		case "GET":
			if err := a.requireRunning(); err != nil {
				return err
			}
			v, err := a.vice.getCheckpoint(id)
			return answer(w, v, err)
		case "DELETE":
			if err := a.requireRunning(); err != nil {
				return err
			}
			if _, err := a.vice.deleteCheckpoint(id); err != nil {
				return err
			}
			return ok(w, okBody)
		}
	}
	return vErr(404, "no route %s %s", method, path)
}
