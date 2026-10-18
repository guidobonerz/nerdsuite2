package vice

// The tests of the protocol: the frames of the requests, the bodies of the commands, the parser of
// the responses and the decoders (test/vice-protocol.test.js).

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"reflect"
	"strings"
	"testing"
)

func hx(b []byte) string { return hex.EncodeToString(b) }
func unhex(s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return b
}
func hexOf(s string) string { return hex.EncodeToString([]byte(s)) }

// mustOf: the request of a builder that has to succeed
func mustOf(t *testing.T) func(request, error) request {
	return func(r request, err error) request {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
}

func eq(t *testing.T, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
}

func TestEncodeRequest(t *testing.T) {
	must := mustOf(t)
	r := must(build.memoryGet(0x0801, 0x0810, memOpts{}))
	buf := encodeRequest(0x12345678, r.command, r.body)
	eq(t, hx(buf), "02"+"02"+"08000000"+"78563412"+"01"+"00"+"0108"+"1008"+"00"+"0000")
	d, ok := decodeRequest(buf)
	if !ok {
		t.Fatal("incomplete")
	}
	eq(t, d.requestID, uint32(0x12345678))
	eq(t, d.command, byte(cmdMemoryGet))
	eq(t, d.size, len(buf))
}

func TestCommandBodies(t *testing.T) {
	must := mustOf(t)
	eq(t, hx(must(build.memorySet(0xc000, []byte{1, 2, 3}, memOpts{sideEffects: true, bank: 1})).body), "01"+"00c0"+"02c0"+"00"+"0100"+"010203")
	eq(t, hx(build.checkpointGet(7).body), "07000000")
	cp := checkpointOpts{start: 0x1000, end: 0x1001, stop: true, enabled: true, exec: true, load: true, tmp: true}
	eq(t, hx(must(build.checkpointSet(cp)).body), "0010"+"0110"+"01"+"01"+"05"+"01"+"00")
	eq(t, binary.LittleEndian.Uint16(must(build.checkpointSet(newCheckpointOpts(0x1000))).body[2:]), uint16(0x1000))
	noOp := newCheckpointOpts(1)
	noOp.exec = false
	if _, err := build.checkpointSet(noOp); err == nil {
		t.Fatal("a checkpoint without exec/load/store")
	}
	eq(t, hx(build.checkpointDelete(2).body), "02000000")
	eq(t, len(build.checkpointList().body), 0)
	eq(t, hx(build.checkpointToggle(3, false).body), "0300000000")
	eq(t, hx(must(build.conditionSet(1, "A == $10")).body), "01000000"+"08"+hexOf("A == $10"))
	eq(t, hx(build.registersGet(0).body), "00")
	eq(t, hx(build.registersSet([]regValue{{0, 0x12}, {3, 0x1000}}, 0).body), "00"+"0200"+"03"+"00"+"1200"+"03"+"03"+"0010")
	eq(t, hx(must(build.dump("a.vsf", true, false)).body), "01"+"00"+"05"+hexOf("a.vsf"))
	eq(t, hx(must(build.undump("a.vsf")).body), "05"+hexOf("a.vsf"))
	eq(t, hx(must(build.resourceGet("VICIIBorderMode")).body), "0f"+hexOf("VICIIBorderMode"))
	eq(t, hx(must(build.resourceSet("Foo", 3)).body), "01"+"03"+hexOf("Foo")+"04"+"03000000")
	eq(t, hx(must(build.resourceSet("Foo", "x")).body), "00"+"03"+hexOf("Foo")+"01"+"78")
	eq(t, hx(build.advanceInstructions(5, true).body), "01"+"0500")
	eq(t, hx(must(build.keyboardFeed([]byte("RUN\r"))).body), "04"+"52554e0d")
	eq(t, build.executeUntilReturn().command, byte(0x73))
	eq(t, build.ping().command, byte(0x81))
	eq(t, build.banksAvailable().command, byte(0x82))
	eq(t, hx(build.registersAvailable(1).body), "01")
	eq(t, hx(build.displayGet(true, 0).body), "0100")
	eq(t, build.viceInfo().command, byte(0x85))
	eq(t, hx(build.paletteGet(false).body), "00")
	eq(t, hx(build.joyportSet(2, 0x10).body), "0200"+"1000")
	eq(t, hx(build.userportSet(0xff).body), "ff00")
	eq(t, build.exit().command, byte(0xaa))
	eq(t, build.quit().command, byte(0xbb))
	eq(t, hx(build.reset(1).body), "01")
	eq(t, hx(must(build.autostart("x.prg", true, 0)).body), "01"+"0000"+"05"+hexOf("x.prg"))
	if _, err := build.keyboardFeed([]byte(strings.Repeat("x", 256))); err == nil {
		t.Fatal("256 bytes of keyboard text")
	}
	if _, err := build.memoryGet(10, 5, memOpts{}); err == nil {
		t.Fatal("end before start")
	}
}

func TestParserFragmentation(t *testing.T) {
	a := encodeResponse(respRegisterInfo, eventRequestID, unhex("0100"+"03"+"03"+"3412"), 0)
	b := encodeResponse(respStopped, eventRequestID, unhex("3412"), 0)
	c := encodeResponse(cmdPing, 5, nil, 0)
	all := bytes.Join([][]byte{a, b, c}, nil)
	// byte by byte
	var p responseParser
	var frames []frame
	for _, x := range all {
		frames = append(frames, p.push([]byte{x})...)
	}
	eq(t, len(frames), 3)
	eq(t, frames[0].typ, byte(0x31))
	if !frames[0].isEvent {
		t.Fatal("the registers are an event")
	}
	regs, err := parse.registerInfo(frames[0].body)
	eq(t, err, nil)
	eq(t, regs, []regValue{{id: 3, value: 0x1234}})
	pc, _ := parse.pc(frames[1].body)
	eq(t, pc, 0x1234)
	eq(t, frames[2].requestID, uint32(5))
	eq(t, frames[2].isEvent, false)
	// all at once
	var p2 responseParser
	eq(t, len(p2.push(all)), 3)
	// split in the middle of a header and body
	var p3 responseParser
	eq(t, len(p3.push(all[:5])), 0)
	eq(t, len(p3.push(all[5:len(a)+3])), 1)
	eq(t, len(p3.push(all[len(a)+3:])), 2)
}

func TestParserGarbage(t *testing.T) {
	var p responseParser
	frames := p.push(append([]byte{0xff, 0x00, 0x33}, encodeResponse(cmdPing, 7, nil, 0)...))
	eq(t, len(frames), 1)
	eq(t, frames[0].requestID, uint32(7))
}

func TestParserErrorCode(t *testing.T) {
	var p responseParser
	frames := p.push(encodeResponse(0x00, 9, nil, 0x01))
	eq(t, frames[0].err, byte(1))
	if msg := (&protocolError{code: 1, command: 0x51}).Error(); !strings.Contains(msg, "object does not exist") {
		t.Fatal(msg)
	}
	eq(t, (&protocolError{code: 0x81, command: 0x22}).Error(), "VICE error 0x81 (invalid parameter) for command 0x22")
}

func TestParseMemoryGet(t *testing.T) {
	m, _ := parse.memoryGet(unhex("0300aabbcc"))
	eq(t, m, []byte{0xaa, 0xbb, 0xcc})
	full := append(unhex("0000"), bytes.Repeat([]byte{7}, 0x10000)...)
	m, _ = parse.memoryGet(full)
	eq(t, len(m), 0x10000)
	if _, err := parse.memoryGet([]byte{1}); err == nil {
		t.Fatal("a body too short")
	}
}

func TestParseCheckpointInfo(t *testing.T) {
	b := unhex("02000000" + "01" + "0d08" + "0f08" + "01" + "01" + "04" + "00" + "05000000" + "01000000" + "01" + "00")
	cp, err := parse.checkpointInfo(b)
	eq(t, err, nil)
	eq(t, cp, checkpointInfo{
		id: 2, hit: true, start: 0x080d, end: 0x080f, stop: true, enabled: true, op: 4, load: false, store: false, exec: true,
		temporary: false, hits: 5, ignored: 1, hasCondition: true, memspace: 0,
	})
	n, _ := parse.checkpointList(unhex("03000000"))
	eq(t, n, uint32(3))
}

func TestParseRegistersBanks(t *testing.T) {
	regs, _ := parse.registerInfo(unhex("0200" + "03" + "00" + "4100" + "03" + "03" + "0d08"))
	eq(t, regs, []regValue{{0, 0x41}, {3, 0x080d}})
	banks, _ := parse.banksAvailable(unhex("0200" + "0a" + "0000" + "07" + hexOf("default") + "06" + "0100" + "03" + hexOf("cpu")))
	eq(t, banks, []bank{{0, "default"}, {1, "cpu"}})
	avail, _ := parse.registersAvailable(unhex("0200" + "05" + "03" + "10" + "02" + hexOf("PC") + "04" + "00" + "08" + "01" + hexOf("A")))
	eq(t, avail, []regInfo{{ID: 3, Bits: 16, Name: "PC"}, {ID: 0, Bits: 8, Name: "A"}})
}

func TestParseDisplayPaletteInfo(t *testing.T) {
	head := make([]byte, 4+13+4)
	binary.LittleEndian.PutUint32(head[0:], 13)
	binary.LittleEndian.PutUint16(head[4:], 4)
	binary.LittleEndian.PutUint16(head[6:], 2)
	binary.LittleEndian.PutUint16(head[8:], 1)
	binary.LittleEndian.PutUint16(head[10:], 0)
	binary.LittleEndian.PutUint16(head[12:], 2)
	binary.LittleEndian.PutUint16(head[14:], 1)
	head[16] = 8
	binary.LittleEndian.PutUint32(head[17:], 8)
	d, err := parse.displayGet(append(head, 0, 1, 2, 3, 0, 1, 2, 3))
	eq(t, err, nil)
	eq(t, d, display{width: 4, height: 2, innerX: 1, innerY: 0, innerWidth: 2, innerHeight: 1, bpp: 8, pixels: []byte{0, 1, 2, 3, 0, 1, 2, 3}})
	// VICE 3.10: the frame 4 bytes short - padded to the announced size
	d, _ = parse.displayGet(append(head, 0, 1, 2, 3))
	eq(t, d.pixels, []byte{0, 1, 2, 3, 0, 0, 0, 0})
	pal, _ := parse.paletteGet(unhex("0200" + "03" + "000000" + "03" + "ffffff"))
	eq(t, pal, [][3]byte{{0, 0, 0}, {255, 255, 255}})
	eq(t, indexedToRgba([]byte{1, 0}, pal), []byte{255, 255, 255, 255, 0, 0, 0, 255})
	// as reported by VICE 3.10 r45942
	info, _ := parse.viceInfo(unhex("04030a00000476b30000"))
	eq(t, info, viceInfo{version: "3.10.0", versionBytes: []int{3, 10, 0, 0}, svn: 45942})
	v, _ := parse.resourceGet(unhex("010401000000"))
	eq(t, v, 1)
	v, _ = parse.resourceGet(unhex("000361626364"))
	eq(t, v, "abc")
	pc, _ := parse.undump(unhex("0d08"))
	eq(t, pc, 0x080d)
}

func TestTextToPetscii(t *testing.T) {
	eq(t, textToPetscii("list\r\nRun\n"), []byte{0x4c, 0x49, 0x53, 0x54, 0x0d, 0x52, 0x55, 0x4e, 0x0d})
	eq(t, textToPetscii("£←"), []byte{0x5c, 0x5f})
}
