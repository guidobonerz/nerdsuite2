// Package vice: the bridge to the VICE emulator - its binary remote monitor (protocol.go), the
// process and the connection (vice.go) and the HTTP API under /api/vice with the events (api.go).
package vice

// The VICE binary remote monitor protocol (API version 2, VICE 3.5+).
// Reference: https://vice-emu.sourceforge.io/vice_13.html "The binary remote monitor"
//
// Request:  STX(0x02) VER(0x02) LEN(u32 body) REQID(u32) CMD(u8) BODY
// Response: STX(0x02) VER(0x02) LEN(u32 body) TYPE(u8) ERR(u8) REQID(u32) BODY
// Events carry request id 0xffffffff. All multi-byte values are little endian.

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf16"
)

const (
	stx                = 0x02
	apiVersion         = 0x02
	eventRequestID     = 0xffffffff
	requestHeaderSize  = 11
	responseHeaderSize = 12
)

// the commands
const (
	cmdMemoryGet           = 0x01
	cmdMemorySet           = 0x02
	cmdCheckpointGet       = 0x11
	cmdCheckpointSet       = 0x12
	cmdCheckpointDelete    = 0x13
	cmdCheckpointList      = 0x14
	cmdCheckpointToggle    = 0x15
	cmdConditionSet        = 0x22
	cmdRegistersGet        = 0x31
	cmdRegistersSet        = 0x32
	cmdDump                = 0x41
	cmdUndump              = 0x42
	cmdResourceGet         = 0x51
	cmdResourceSet         = 0x52
	cmdAdvanceInstructions = 0x71
	cmdKeyboardFeed        = 0x72
	cmdExecuteUntilReturn  = 0x73
	cmdPing                = 0x81
	cmdBanksAvailable      = 0x82
	cmdRegistersAvailable  = 0x83
	cmdDisplayGet          = 0x84
	cmdViceInfo            = 0x85
	cmdPaletteGet          = 0x91
	cmdJoyportSet          = 0xa2
	cmdUserportSet         = 0xb2
	cmdExit                = 0xaa
	cmdQuit                = 0xbb
	cmdReset               = 0xcc
	cmdAutostart           = 0xdd
)

// the types of the responses and the events
const (
	respInvalid            = 0x00
	respMemoryGet          = 0x01
	respCheckpointInfo     = 0x11
	respCheckpointList     = 0x14
	respRegisterInfo       = 0x31
	respUndump             = 0x42
	respResourceGet        = 0x51
	respJam                = 0x61
	respStopped            = 0x62
	respResumed            = 0x63
	respBanksAvailable     = 0x82
	respRegistersAvailable = 0x83
	respDisplayGet         = 0x84
	respViceInfo           = 0x85
	respPaletteGet         = 0x91
)

// the error codes of a response
const (
	errOK                = 0x00
	errObjectMissing     = 0x01
	errInvalidMemspace   = 0x02
	errInvalidLength     = 0x80
	errInvalidParameter  = 0x81
	errInvalidAPIVersion = 0x82
	errInvalidCommand    = 0x83
	errGeneralFailure    = 0x8f
)

var errorText = map[byte]string{
	0x01: "object does not exist",
	0x02: "invalid memspace",
	0x80: "incorrect command length",
	0x81: "invalid parameter",
	0x82: "API version not understood",
	0x83: "command type not understood",
	0x8f: "general failure",
}

// the memspaces, the operations of a checkpoint and the kinds of reset
const (
	memMain    = 0
	memDrive8  = 1
	memDrive9  = 2
	memDrive10 = 3
	memDrive11 = 4

	opLoad  = 0x01
	opStore = 0x02
	opExec  = 0x04

	resetSoft    = 0x00
	resetHard    = 0x01
	resetDrive8  = 0x08
	resetDrive9  = 0x09
	resetDrive10 = 0x0a
	resetDrive11 = 0x0b
)

// protocolError: VICE answered a command with an error code
type protocolError struct {
	code    byte
	command byte
}

func (e *protocolError) Error() string {
	text := errorText[e.code]
	if text == "" {
		text = "unknown"
	}
	return fmt.Sprintf("VICE error 0x%02x (%s) for command 0x%02x", e.code, text, e.command)
}

// rangeError: a value out of its range (a RangeError of the JS: the API answers 400)
type rangeError struct{ msg string }

func (e *rangeError) Error() string { return e.msg }

func rangeErr(format string, a ...any) error { return &rangeError{msg: fmt.Sprintf(format, a...)} }

// ---------------------------------------------------------------- helpers

// request: a command and its body
type request struct {
	command byte
	body    []byte
}

func u8(v int) []byte { return []byte{byte(v)} }
func u16(v int) []byte {
	b := make([]byte, 2)
	binary.LittleEndian.PutUint16(b, uint16(v))
	return b
}
func u32(v uint32) []byte {
	b := make([]byte, 4)
	binary.LittleEndian.PutUint32(b, v)
	return b
}
func boolb(v bool) []byte {
	if v {
		return []byte{1}
	}
	return []byte{0}
}

// latin1: a string as bytes, one per character (the low byte of each UTF-16 unit, as Buffer.from(s, 'latin1'))
func latin1(s string) []byte {
	units := utf16.Encode([]rune(s))
	out := make([]byte, len(units))
	for i, u := range units {
		out[i] = byte(u)
	}
	return out
}

// fromLatin1: bytes as a string, one character per byte
func fromLatin1(b []byte) string {
	var sb strings.Builder
	for _, c := range b {
		sb.WriteRune(rune(c))
	}
	return sb.String()
}

// str8: a string with its length in front (at most 255 bytes)
func str8(b []byte, what string) ([]byte, error) {
	if len(b) > 255 {
		return nil, rangeErr("%s too long (max 255 bytes)", what)
	}
	return append([]byte{byte(len(b))}, b...), nil
}

func checkAddr(a int, name string) error {
	if a < 0 || a > 0xffff {
		return rangeErr("%s must be an integer 0..65535", name)
	}
	return nil
}

func cat(parts ...[]byte) []byte { return bytes.Join(parts, nil) }

// ---------------------------------------------------------------- encoding

// encodeRequest: a full request frame
func encodeRequest(requestID uint32, command byte, body []byte) []byte {
	h := make([]byte, requestHeaderSize, requestHeaderSize+len(body))
	h[0] = stx
	h[1] = apiVersion
	binary.LittleEndian.PutUint32(h[2:], uint32(len(body)))
	binary.LittleEndian.PutUint32(h[6:], requestID)
	h[10] = command
	return append(h, body...)
}

// memOpts: the options of a memory access
type memOpts struct {
	sideEffects bool
	memspace    int
	bank        int
}

// checkpointOpts: a checkpoint to set; newCheckpointOpts has the defaults
type checkpointOpts struct {
	start, end                            int
	stop, enabled, exec, load, store, tmp bool
	memspace                              int
	condition                             string
}

// newCheckpointOpts: a checkpoint at an address with the defaults - it stops, enabled, exec
func newCheckpointOpts(start int) checkpointOpts {
	return checkpointOpts{start: start, end: start, stop: true, enabled: true, exec: true}
}

// regValue: a register and its value
type regValue struct {
	id    int
	value int
}

// builder: the body builders, one per command
type builder struct{}

var build builder

func (builder) memoryGet(start, end int, o memOpts) (request, error) {
	if err := checkAddr(start, "start"); err != nil {
		return request{}, err
	}
	if err := checkAddr(end, "end"); err != nil {
		return request{}, err
	}
	if end < start {
		return request{}, rangeErr("end must be >= start")
	}
	return request{cmdMemoryGet, cat(boolb(o.sideEffects), u16(start), u16(end), u8(o.memspace), u16(o.bank))}, nil
}

func (builder) memorySet(start int, data []byte, o memOpts) (request, error) {
	if err := checkAddr(start, "start"); err != nil {
		return request{}, err
	}
	if len(data) == 0 {
		return request{}, rangeErr("data must not be empty")
	}
	end := start + len(data) - 1
	if end > 0xffff {
		return request{}, rangeErr("data exceeds address space")
	}
	return request{cmdMemorySet, cat(boolb(o.sideEffects), u16(start), u16(end), u8(o.memspace), u16(o.bank), data)}, nil
}

func (builder) checkpointGet(id uint32) request { return request{cmdCheckpointGet, u32(id)} }

func (builder) checkpointSet(o checkpointOpts) (request, error) {
	if err := checkAddr(o.start, "start"); err != nil {
		return request{}, err
	}
	if err := checkAddr(o.end, "end"); err != nil {
		return request{}, err
	}
	op := 0
	if o.load {
		op |= opLoad
	}
	if o.store {
		op |= opStore
	}
	if o.exec {
		op |= opExec
	}
	if op == 0 {
		return request{}, rangeErr("checkpoint needs at least one of exec/load/store")
	}
	return request{cmdCheckpointSet, cat(u16(o.start), u16(o.end), boolb(o.stop), boolb(o.enabled), u8(op), boolb(o.tmp), u8(o.memspace))}, nil
}

func (builder) checkpointDelete(id uint32) request { return request{cmdCheckpointDelete, u32(id)} }
func (builder) checkpointList() request            { return request{cmdCheckpointList, nil} }
func (builder) checkpointToggle(id uint32, enabled bool) request {
	return request{cmdCheckpointToggle, cat(u32(id), boolb(enabled))}
}

func (builder) conditionSet(id uint32, expression string) (request, error) {
	s, err := str8(latin1(expression), "condition")
	if err != nil {
		return request{}, err
	}
	return request{cmdConditionSet, cat(u32(id), s)}, nil
}

func (builder) registersGet(memspace int) request { return request{cmdRegistersGet, u8(memspace)} }

// registersSet: regs - the registers and their values
func (builder) registersSet(regs []regValue, memspace int) request {
	body := cat(u8(memspace), u16(len(regs)))
	for _, r := range regs {
		body = append(body, cat(u8(3), u8(r.id), u16(r.value))...)
	}
	return request{cmdRegistersSet, body}
}

func (builder) dump(filename string, saveRoms, saveDisks bool) (request, error) {
	s, err := str8(latin1(filename), "filename")
	if err != nil {
		return request{}, err
	}
	return request{cmdDump, cat(boolb(saveRoms), boolb(saveDisks), s)}, nil
}

func (builder) undump(filename string) (request, error) {
	s, err := str8(latin1(filename), "filename")
	if err != nil {
		return request{}, err
	}
	return request{cmdUndump, s}, nil
}

func (builder) resourceGet(name string) (request, error) {
	s, err := str8(latin1(name), "resource name")
	if err != nil {
		return request{}, err
	}
	return request{cmdResourceGet, s}, nil
}

// resourceSet: value - an int (sent as a 32 bit integer) or a string
func (builder) resourceSet(name string, value any) (request, error) {
	var v []byte
	isInt := false
	switch x := value.(type) {
	case int:
		isInt = true
		v = u32(uint32(int32(x)))
	case float64:
		isInt = true
		v = u32(uint32(int32(x)))
	case string:
		v = latin1(x)
	default:
		v = latin1(fmt.Sprint(x))
	}
	n, err := str8(latin1(name), "resource name")
	if err != nil {
		return request{}, err
	}
	s, err := str8(v, "value")
	if err != nil {
		return request{}, err
	}
	t := 0
	if isInt {
		t = 1
	}
	return request{cmdResourceSet, cat(u8(t), n, s)}, nil
}

func (builder) advanceInstructions(count int, stepOver bool) request {
	return request{cmdAdvanceInstructions, cat(boolb(stepOver), u16(count))}
}

// keyboardFeed: text - PETSCII bytes
func (builder) keyboardFeed(text []byte) (request, error) {
	s, err := str8(text, "keyboard text")
	if err != nil {
		return request{}, err
	}
	return request{cmdKeyboardFeed, s}, nil
}

func (builder) executeUntilReturn() request { return request{cmdExecuteUntilReturn, nil} }
func (builder) ping() request               { return request{cmdPing, nil} }
func (builder) banksAvailable() request     { return request{cmdBanksAvailable, nil} }
func (builder) registersAvailable(memspace int) request {
	return request{cmdRegistersAvailable, u8(memspace)}
}

// displayGet: useVic - C128 only: true = VIC-II (40 col), false = VDC. format 0 = 8 bit indexed
func (builder) displayGet(useVic bool, format int) request {
	return request{cmdDisplayGet, cat(boolb(useVic), u8(format))}
}
func (builder) viceInfo() request              { return request{cmdViceInfo, nil} }
func (builder) paletteGet(useVic bool) request { return request{cmdPaletteGet, boolb(useVic)} }
func (builder) joyportSet(port, value int) request {
	return request{cmdJoyportSet, cat(u16(port), u16(value))}
}
func (builder) userportSet(value int) request { return request{cmdUserportSet, u16(value)} }
func (builder) exit() request                 { return request{cmdExit, nil} }
func (builder) quit() request                 { return request{cmdQuit, nil} }
func (builder) reset(t int) request           { return request{cmdReset, u8(t)} }

func (builder) autostart(filename string, run bool, index int) (request, error) {
	s, err := str8(latin1(filename), "filename")
	if err != nil {
		return request{}, err
	}
	return request{cmdAutostart, cat(boolb(run), u16(index), s)}, nil
}

// ---------------------------------------------------------------- decoding

// frame: a response or an event
type frame struct {
	apiVersion byte
	typ        byte
	err        byte
	requestID  uint32
	isEvent    bool
	body       []byte
}

// responseParser: the incremental frame parser - push() chunks, receive the complete frames
type responseParser struct{ buf []byte }

func (p *responseParser) push(chunk []byte) []frame {
	p.buf = append(p.buf, chunk...)
	var frames []frame
	for {
		// resync: drop garbage until STX
		if len(p.buf) > 0 && p.buf[0] != stx {
			i := bytes.IndexByte(p.buf, stx)
			if i < 0 {
				p.buf = nil
			} else {
				p.buf = p.buf[i:]
			}
		}
		if len(p.buf) < responseHeaderSize {
			break
		}
		total := responseHeaderSize + int(binary.LittleEndian.Uint32(p.buf[2:]))
		if len(p.buf) < total {
			break
		}
		id := binary.LittleEndian.Uint32(p.buf[8:])
		frames = append(frames, frame{
			apiVersion: p.buf[1],
			typ:        p.buf[6],
			err:        p.buf[7],
			requestID:  id,
			isEvent:    id == eventRequestID,
			body:       append([]byte{}, p.buf[responseHeaderSize:total]...),
		})
		p.buf = p.buf[total:]
	}
	if len(p.buf) == 0 {
		p.buf = nil
	}
	return frames
}

func (p *responseParser) reset() { p.buf = nil }

// encodeResponse: a raw response frame (for the tests and the fake VICE)
func encodeResponse(typ byte, requestID uint32, body []byte, errCode byte) []byte {
	h := make([]byte, responseHeaderSize, responseHeaderSize+len(body))
	h[0] = stx
	h[1] = apiVersion
	binary.LittleEndian.PutUint32(h[2:], uint32(len(body)))
	h[6] = typ
	h[7] = errCode
	binary.LittleEndian.PutUint32(h[8:], requestID)
	return append(h, body...)
}

// decodedRequest: a request frame as the fake VICE reads it
type decodedRequest struct {
	apiVersion byte
	requestID  uint32
	command    byte
	body       []byte
	size       int
}

// decodeRequest: a request frame (for the fake VICE / the tests); false if it is incomplete
func decodeRequest(buf []byte) (decodedRequest, bool) {
	if len(buf) < requestHeaderSize {
		return decodedRequest{}, false
	}
	n := int(binary.LittleEndian.Uint32(buf[2:]))
	if len(buf) < requestHeaderSize+n {
		return decodedRequest{}, false
	}
	return decodedRequest{
		apiVersion: buf[1],
		requestID:  binary.LittleEndian.Uint32(buf[6:]),
		command:    buf[10],
		body:       buf[requestHeaderSize : requestHeaderSize+n],
		size:       requestHeaderSize + n,
	}, true
}

// the readers of a body: a byte past the end is 0; a word past the end is a range error (as the
// read of a Buffer), caught by catchRange
func at(b []byte, o int) int {
	if o < 0 || o >= len(b) {
		return 0
	}
	return int(b[o])
}

func boundsPanic(o, max int) {
	if max < 0 {
		panic(&rangeError{msg: "Attempt to access memory outside buffer bounds"})
	}
	panic(&rangeError{msg: fmt.Sprintf(`The value of "offset" is out of range. It must be >= 0 and <= %d. Received %d`, max, o)})
}

func rd16(b []byte, o int) int {
	if o < 0 || o+2 > len(b) {
		boundsPanic(o, len(b)-2)
	}
	return int(binary.LittleEndian.Uint16(b[o:]))
}

func rd32(b []byte, o int) uint32 {
	if o < 0 || o+4 > len(b) {
		boundsPanic(o, len(b)-4)
	}
	return binary.LittleEndian.Uint32(b[o:])
}

// sub: a part of a body, clamped to its size (as subarray)
func sub(b []byte, s, e int) []byte {
	s = max(0, min(s, len(b)))
	e = max(s, min(e, len(b)))
	return b[s:e]
}

func catchRange(err *error) {
	if r := recover(); r != nil {
		if re, ok := r.(*rangeError); ok {
			*err = re
			return
		}
		panic(r)
	}
}

// checkpointInfo: a checkpoint as VICE reports it
type checkpointInfo struct {
	id                uint32
	hit               bool
	start, end        int
	stop, enabled     bool
	op                int
	load, store, exec bool
	temporary         bool
	hits, ignored     uint32
	hasCondition      bool
	memspace          int
}

// bank: a memory bank of the machine
type bank struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

// regInfo: a register the machine has
type regInfo struct {
	ID   int    `json:"id"`
	Bits int    `json:"bits"`
	Name string `json:"name"`
}

// display: a frame of the screen, 8 bit indexed
type display struct {
	width, height, innerX, innerY, innerWidth, innerHeight int
	bpp                                                    int
	pixels                                                 []byte
}

// viceInfo: the version of VICE
type viceInfo struct {
	version      string
	versionBytes []int
	svn          uint32
}

// parsers: the decoders of the bodies, one per response
type parsers struct{}

var parse parsers

func (parsers) memoryGet(b []byte) (out []byte, err error) {
	defer catchRange(&err)
	n := rd16(b, 0)
	// A full 64K read reports length 0 (u16 overflow); take what's there.
	data := b[2:]
	if n != 0 {
		data = sub(data, 0, n)
	}
	return append([]byte{}, data...), nil
}

func (parsers) checkpointInfo(b []byte) (cp checkpointInfo, err error) {
	defer catchRange(&err)
	op := at(b, 11)
	cp = checkpointInfo{
		id:           rd32(b, 0),
		hit:          at(b, 4) != 0,
		start:        rd16(b, 5),
		end:          rd16(b, 7),
		stop:         at(b, 9) != 0,
		enabled:      at(b, 10) != 0,
		op:           op,
		load:         op&opLoad != 0,
		store:        op&opStore != 0,
		exec:         op&opExec != 0,
		temporary:    at(b, 12) != 0,
		hits:         rd32(b, 13),
		ignored:      rd32(b, 17),
		hasCondition: at(b, 21) != 0,
	}
	if len(b) > 22 {
		cp.memspace = int(b[22])
	}
	return cp, nil
}

func (parsers) checkpointList(b []byte) (count uint32, err error) {
	defer catchRange(&err)
	return rd32(b, 0), nil
}

// registerInfo: the registers and their values
func (parsers) registerInfo(b []byte) (regs []regValue, err error) {
	defer catchRange(&err)
	count := rd16(b, 0)
	regs = []regValue{}
	o := 2
	for i := 0; i < count && o < len(b); i++ {
		size := at(b, o)
		r := regValue{id: at(b, o+1)}
		if size >= 3 {
			r.value = rd16(b, o+2)
		} else {
			r.value = at(b, o+2)
		}
		regs = append(regs, r)
		o += size + 1
	}
	return regs, nil
}

func (parsers) undump(b []byte) (pc int, err error) {
	defer catchRange(&err)
	return rd16(b, 0), nil
}

// resourceGet: an int or a string
func (parsers) resourceGet(b []byte) (v any, err error) {
	defer catchRange(&err)
	typ := at(b, 0)
	n := at(b, 1)
	raw := sub(b, 2, 2+n)
	if typ == 1 {
		switch n {
		case 4:
			return int(int32(rd32(raw, 0))), nil
		case 2:
			return int(int16(rd16(raw, 0))), nil
		case 1:
			if len(raw) < 1 {
				boundsPanic(0, -1)
			}
			return int(int8(raw[0])), nil
		}
		x := 0.0
		for i := n - 1; i >= 0; i-- {
			x = x*256 + float64(at(raw, i))
		}
		return int(x), nil
	}
	return fromLatin1(raw), nil
}

func (parsers) pc(b []byte) (pc int, err error) {
	defer catchRange(&err)
	return rd16(b, 0), nil
}

func (parsers) banksAvailable(b []byte) (banks []bank, err error) {
	defer catchRange(&err)
	count := rd16(b, 0)
	banks = []bank{}
	o := 2
	for i := 0; i < count && o < len(b); i++ {
		size := at(b, o)
		id := rd16(b, o+1)
		nl := at(b, o+3)
		banks = append(banks, bank{ID: id, Name: fromLatin1(sub(b, o+4, o+4+nl))})
		o += size + 1
	}
	return banks, nil
}

func (parsers) registersAvailable(b []byte) (regs []regInfo, err error) {
	defer catchRange(&err)
	count := rd16(b, 0)
	regs = []regInfo{}
	o := 2
	for i := 0; i < count && o < len(b); i++ {
		size := at(b, o)
		nl := at(b, o+3)
		regs = append(regs, regInfo{ID: at(b, o+1), Bits: at(b, o+2), Name: fromLatin1(sub(b, o+4, o+4+nl))})
		o += size + 1
	}
	return regs, nil
}

// maxPixels: the largest frame taken (a broken length must not take all the memory)
const maxPixels = 1 << 28

func (parsers) displayGet(b []byte) (d display, err error) {
	defer catchRange(&err)
	fieldsLen := int(rd32(b, 0))
	d = display{
		width:       rd16(b, 4),
		height:      rd16(b, 6),
		innerX:      rd16(b, 8),
		innerY:      rd16(b, 10),
		innerWidth:  rd16(b, 12),
		innerHeight: rd16(b, 14),
		bpp:         at(b, 16),
	}
	bufLenOffset := 4 + fieldsLen // FL counts the fields after itself
	bl := int(rd32(b, bufLenOffset))
	// VICE 3.10 (r45942) announces BL = width*height but its frame length is 4 bytes
	// short, so the last 4 pixels are missing. Pad to the announced size.
	n := max(bl, d.width*d.height)
	if n > maxPixels {
		return display{}, rangeErr("display buffer too large (%d bytes)", n)
	}
	d.pixels = make([]byte, n)
	copy(d.pixels, sub(b, bufLenOffset+4, min(len(b), bufLenOffset+4+bl)))
	return d, nil
}

func (parsers) viceInfo(b []byte) (info viceInfo, err error) {
	defer catchRange(&err)
	ml := at(b, 0)
	v := []int{}
	for _, c := range sub(b, 1, 1+ml) {
		v = append(v, int(c))
	}
	sl := at(b, 1+ml)
	sv := sub(b, 2+ml, 2+ml+sl)
	var svn uint32
	if sl >= 4 {
		svn = rd32(sv, 0)
	}
	// drop trailing zero components but keep at least major.minor.build
	parts := append([]int{}, v...)
	for len(parts) > 3 && parts[len(parts)-1] == 0 {
		parts = parts[:len(parts)-1]
	}
	s := make([]string, len(parts))
	for i, p := range parts {
		s[i] = strconv.Itoa(p)
	}
	return viceInfo{version: strings.Join(s, "."), versionBytes: v, svn: svn}, nil
}

func (parsers) paletteGet(b []byte) (colors [][3]byte, err error) {
	defer catchRange(&err)
	count := rd16(b, 0)
	colors = [][3]byte{}
	o := 2
	for i := 0; i < count && o < len(b); i++ {
		size := at(b, o)
		colors = append(colors, [3]byte{byte(at(b, o+1)), byte(at(b, o+2)), byte(at(b, o+3))})
		o += size + 1
	}
	return colors, nil
}

// indexedToRgba: an 8-bit indexed frame as RGBA8888 with a palette ([[r,g,b],...])
func indexedToRgba(pixels []byte, palette [][3]byte) []byte {
	out := make([]byte, len(pixels)*4)
	for i, p := range pixels {
		var c [3]byte
		if int(p) < len(palette) {
			c = palette[p]
		}
		o := i * 4
		out[o], out[o+1], out[o+2], out[o+3] = c[0], c[1], c[2], 255
	}
	return out
}
