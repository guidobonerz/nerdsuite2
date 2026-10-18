package emu

// The tests of test/dsk.test.js: the AMSDOS names and headers, the Extended DSK container, the
// directory and where the data goes - byte for byte.

import (
	"bytes"
	"encoding/binary"
	"strings"
	"testing"
)

func findSector(t *testing.T, tr *dskTrack, id byte) []byte {
	t.Helper()
	for _, s := range tr.Sectors {
		if s.ID == id {
			return s.Data
		}
	}
	t.Fatalf("no sector %#x on track %d", id, tr.Track)
	return nil
}

func all(b []byte, v byte) bool {
	for _, x := range b {
		if x != v {
			return false
		}
	}
	return true
}

func intp(n int) *int { return &n }

func TestAmsdosName(t *testing.T) {
	// amsdosName normalizes to 8.3 uppercase
	if n, x, d := amsdosName("hello world.bas", ""); n != "HELLOWOR" || x != "BAS" || d != "HELLOWOR.BAS" {
		t.Errorf("hello world.bas: %q %q %q", n, x, d)
	}
	if n, x, d := amsdosName("x", "BIN"); n != "X       " || x != "BIN" || d != "X.BIN" {
		t.Errorf("x: %q %q %q", n, x, d)
	}
	if _, _, d := amsdosName("", ""); d != "PROGRAM" {
		t.Errorf("empty: %q", d)
	}
}

func TestAmsdosHeader(t *testing.T) {
	// AMSDOS header layout and checksum
	h := makeAmsdosHeader("demo.bin", fileBinary, 0x4000, 0x4010, 0x123)
	le := binary.LittleEndian
	if len(h) != 128 {
		t.Fatalf("length %d", len(h))
	}
	if s := string(h[1:12]); s != "DEMO    BIN" {
		t.Errorf("name %q", s)
	}
	if h[18] != 2 || le.Uint16(h[21:]) != 0x4000 || le.Uint16(h[26:]) != 0x4010 || le.Uint16(h[24:]) != 0x123 {
		t.Errorf("fields % x", h[18:28])
	}
	if !bytes.Equal(h[64:67], []byte{0x23, 0x01, 0x00}) {
		t.Errorf("24-bit length % x", h[64:67])
	}
	sum := 0
	for i := 0; i <= 66; i++ {
		sum += int(h[i])
	}
	if int(le.Uint16(h[67:])) != sum&0xffff || int(headerChecksum(h)) != sum&0xffff {
		t.Errorf("checksum")
	}
	if !hasAmsdosHeader(h) {
		t.Errorf("header not recognized")
	}
	if hasAmsdosHeader(make([]byte, 128)) {
		t.Errorf("all-zero block taken as a header")
	}
	p := parseAmsdosHeader(h)
	if p.Name != "DEMO" || p.Ext != "BIN" || p.Length != 0x123 || p.Exec != 0x4010 {
		t.Errorf("parsed %+v", p)
	}
}

func TestExtendedDskContainer(t *testing.T) {
	// extended DSK container: 40 tracks, 9 interleaved 512-byte sectors
	dsk := newAmsdosDisk().toExtendedDsk()
	if s := string(dsk[:34]); s != "EXTENDED CPC DSK File\r\nDisk-Info\r\n" {
		t.Errorf("signature %q", s)
	}
	if dsk[0x30] != 40 || dsk[0x31] != 1 || dsk[0x34] != 0x13 { // track size 0x1300
		t.Errorf("disk info % x", dsk[0x30:0x35])
	}
	if len(dsk) != 256+dskTracks*0x1300 {
		t.Errorf("size %d", len(dsk))
	}
	t0 := dsk[256:512]
	if s := string(t0[:12]); s != "Track-Info\r\n" {
		t.Errorf("track info %q", s)
	}
	if t0[0x14] != 2 || t0[0x15] != 9 || t0[0x16] != 0x4e || t0[0x17] != 0xe5 {
		t.Errorf("track fields % x", t0[0x14:0x18])
	}
	var ids []byte
	for i := 0; i < 9; i++ {
		ids = append(ids, t0[0x18+i*8+2])
	}
	if !bytes.Equal(ids, dskInterleave) {
		t.Errorf("interleave % x", ids)
	}
	parsed, err := parseExtendedDsk(dsk)
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed.Tracks) != 40 || parsed.Tracks[39].Track != 39 {
		t.Fatalf("tracks %d", len(parsed.Tracks))
	}
	for _, tr := range parsed.Tracks {
		if len(tr.Sectors) != dskSectors {
			t.Fatalf("track %d: %d sectors", tr.Track, len(tr.Sectors))
		}
		for _, s := range tr.Sectors {
			if s.Size != 512 {
				t.Fatalf("track %d: sector size %d", tr.Track, s.Size)
			}
		}
	}
	// empty directory is all &E5
	if !all(findSector(t, parsed.Tracks[0], 0xc1), 0xe5) {
		t.Errorf("empty directory is not all &E5")
	}
}

func TestDirectoryAndData(t *testing.T) {
	// directory entry and data placement
	disk := newAmsdosDisk()
	content := bytes.Repeat([]byte{0x11}, 3000)
	name, err := disk.addFile("game.bin", content, 0, "")
	if err != nil || name != "GAME.BIN" {
		t.Fatalf("%q %v", name, err)
	}
	parsed, _ := parseExtendedDsk(disk.toExtendedDsk())
	tracks := parsed.Tracks
	dir := findSector(t, tracks[0], 0xc1)
	if dir[0] != 0 { // user 0
		t.Errorf("user %d", dir[0])
	}
	if s := string(dir[1:12]); s != "GAME    BIN" {
		t.Errorf("name %q", s)
	}
	if dir[12] != 0 { // extent
		t.Errorf("extent %d", dir[12])
	}
	if dir[15] != (3000+127)/128 { // records = 24
		t.Errorf("records %d", dir[15])
	}
	if !bytes.Equal(dir[16:20], []byte{2, 3, 4, 0}) { // 3 blocks of 1K starting after the directory
		t.Errorf("blocks % x", dir[16:20])
	}
	if dir[32] != 0xe5 { // next entry free
		t.Errorf("next entry %#x", dir[32])
	}
	// block 2 = logical sectors 4,5 = track 0 sectors &C5,&C6
	if !all(findSector(t, tracks[0], 0xc5), 0x11) {
		t.Errorf("block 2 is not in sector &C5")
	}
	// block 4 second half: logical sector 9 -> track 1 sector &C1 (bytes 2560..3071 of the file; 3000.. filled with ^Z)
	s := findSector(t, tracks[1], 0xc1)
	if s[0] != 0x11 || s[3000-2560] != 0x1a {
		t.Errorf("track 1 sector &C1: %#x %#x", s[0], s[3000-2560])
	}
	if f := disk.readFile("GAME.BIN"); len(f) < 3000 || !bytes.Equal(f[:3000], content) {
		t.Errorf("read back differs")
	}
}

func TestSeveralExtents(t *testing.T) {
	// large file uses several extents
	disk := newAmsdosDisk()
	if _, err := disk.addFile("big.bin", bytes.Repeat([]byte{1}, 40*1024), 0, ""); err != nil {
		t.Fatal(err)
	}
	dir := disk.directory()
	if len(dir) != 3 {
		t.Fatalf("%d entries", len(dir))
	}
	for i, want := range []struct{ extent, records int }{{0, 128}, {1, 128}, {2, 64}} {
		if dir[i].Extent != want.extent || dir[i].Records != want.records {
			t.Errorf("entry %d: %+v", i, dir[i])
		}
	}
	if len(dir[0].Blocks) != 16 {
		t.Errorf("%d blocks", len(dir[0].Blocks))
	}
	if _, err := disk.addFile("huge.bin", make([]byte, 200*1024), 0, ""); err == nil || !strings.Contains(err.Error(), "disc full") {
		t.Errorf("huge file: %v", err)
	}
}

func TestBuildProgramDisk(t *testing.T) {
	// buildProgramDisk: binary gets a header, ascii gets CRLF + EOF
	bin, err := buildProgramDisk("my prog", "bin", []byte{0xc9}, intp(0x8000), intp(0x8000))
	if err != nil {
		t.Fatal(err)
	}
	if bin.Filename != "MYPROG.BIN" || bin.RunName != "MYPROG" {
		t.Errorf("%q %q", bin.Filename, bin.RunName)
	}
	f := bin.Disk.readFile("MYPROG.BIN")
	if !hasAmsdosHeader(f) || parseAmsdosHeader(f).Load != 0x8000 || f[128] != 0xc9 {
		t.Errorf("binary file % x", f[:130])
	}

	// already headed binary is kept (name rewritten, checksum still valid)
	pre := append(makeAmsdosHeader("OTHER.BIN", fileBinary, 0x4000, 0x4000, 1), 0xc9)
	bin2, err := buildProgramDisk("x", "bin", pre, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	f2 := bin2.Disk.readFile("X.BIN")
	if !hasAmsdosHeader(f2) {
		t.Errorf("headed binary lost its header")
	}
	if p := parseAmsdosHeader(f2); p.Load != 0x4000 || p.Name != "X" {
		t.Errorf("headed binary %+v", p)
	}

	bas, err := buildProgramDisk("hello.bas", "ascii", []byte("10 PRINT \"HI\"\n20 GOTO 10"), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if bas.Filename != "HELLO.BAS" {
		t.Errorf("%q", bas.Filename)
	}
	if txt := latin1(bas.Disk.readFile("HELLO.BAS")); !strings.HasPrefix(txt, "10 PRINT \"HI\"\r\n20 GOTO 10\r\n\x1a") {
		t.Errorf("basic text %q", txt[:40])
	}
	if _, err := buildProgramDisk("x", "bin", []byte{1}, nil, nil); err == nil || !strings.Contains(err.Error(), "load address") {
		t.Errorf("binary without a load address: %v", err)
	}
}
