package emu

// Amstrad CPC disc images: Extended DSK container, AMSDOS DATA format.
//
// DATA format: 40 tracks, 1 side, 9 sectors of 512 bytes per track, sector IDs
// &C1..&C9, no reserved tracks. Allocation blocks of 1 KB (2 sectors); blocks 0-1
// hold the directory (64 entries of 32 bytes), blocks 2..179 hold file data.
// Logical sector L (counting from track 0 sector &C1) is track L/9, sector &C1+L%9.

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"sort"
	"strings"
	"unicode"
)

const (
	dskTracks      = 40
	dskSectors     = 9
	dskSectorSize  = 512
	dskFirstSector = 0xc1
	dskBlockSize   = 1024
	dskDirEntries  = 64
	dskDirBlocks   = 2
	dskTotalBlocks = dskTracks * dskSectors * dskSectorSize / dskBlockSize // 180
)

// physical order of sector IDs on the track (standard AMSDOS interleave)
var dskInterleave = []byte{0xc1, 0xc6, 0xc2, 0xc7, 0xc3, 0xc8, 0xc4, 0xc9, 0xc5}

// the file types of an AMSDOS header
const (
	fileBasic     = 0
	fileProtected = 1
	fileBinary    = 2
)

// amsdosAllowed: the characters an AMSDOS name keeps (after upper case)
func amsdosAllowed(r rune) bool {
	return r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("_-!#$%&'()@^{}~", r)
}

// jsUpper: upper case like JavaScript's toUpperCase (ß becomes SS there, Go keeps it)
func jsUpper(s string) string {
	return strings.ToUpper(strings.ReplaceAll(s, "ß", "SS"))
}

// lastSegment: the part of a path after the last slash or backslash
func lastSegment(s string) string {
	if i := strings.LastIndexAny(s, `\/`); i >= 0 {
		return s[i+1:]
	}
	return s
}

// amsdosName: a name normalized to AMSDOS 8.3: "HELLO   ", "BIN", "HELLO.BIN"
func amsdosName(filename, defaultExt string) (name, ext, display string) {
	if filename == "" {
		filename = "PROGRAM"
	}
	base := lastSegment(filename)
	dot := strings.LastIndex(base, ".")
	name, ext = base, defaultExt
	if dot > 0 {
		name, ext = base[:dot], base[dot+1:]
	}
	clean := func(s string) string {
		return strings.Map(func(r rune) rune {
			if amsdosAllowed(r) {
				return r
			}
			return -1
		}, jsUpper(s))
	}
	name = cut(clean(name), 8)
	if name == "" {
		name = "PROGRAM"
	}
	ext = cut(clean(ext), 3)
	display = name
	if ext != "" {
		display = name + "." + ext
	}
	return pad(name, 8), pad(ext, 3), display
}

func cut(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

func pad(s string, n int) string {
	for len(s) < n {
		s += " "
	}
	return s
}

// latin1: bytes as a string, one character per byte
func latin1(b []byte) string {
	r := make([]rune, len(b))
	for i, c := range b {
		r[i] = rune(c)
	}
	return string(r)
}

// trimEnd: without the white space at the end (like JavaScript's trimEnd)
func trimEnd(s string) string { return strings.TrimRightFunc(s, unicode.IsSpace) }

// headerChecksum: AMSDOS header checksum, 16-bit sum of bytes 0..66.
func headerChecksum(h []byte) uint16 {
	sum := 0
	for i := 0; i < 67; i++ {
		sum += int(h[i])
	}
	return uint16(sum & 0xffff)
}

// hasAmsdosHeader: buf starts with a valid AMSDOS header.
func hasAmsdosHeader(buf []byte) bool {
	if len(buf) < 128 {
		return false
	}
	if binary.LittleEndian.Uint16(buf[67:]) != headerChecksum(buf) {
		return false
	}
	// an all-zero block also "checks out"; require something meaningful
	for _, b := range buf[:69] {
		if b != 0 {
			return true
		}
	}
	return false
}

// makeAmsdosHeader: a 128-byte AMSDOS header (exec: the load address, unless another one is given)
func makeAmsdosHeader(filename string, typ byte, load, exec, length int) []byte {
	h := make([]byte, 128)
	name, ext, _ := amsdosName(filename, "BIN")
	h[0] = 0 // user
	copy(h[1:9], name)
	copy(h[9:12], ext)
	h[18] = typ
	binary.LittleEndian.PutUint16(h[19:], uint16(length&0xffff))          // data length
	binary.LittleEndian.PutUint16(h[21:], uint16(load&0xffff))            // load address
	h[23] = 0xff                                                          // first block
	binary.LittleEndian.PutUint16(h[24:], uint16(length&0xffff))          // logical length
	binary.LittleEndian.PutUint16(h[26:], uint16(exec&0xffff))            // entry address
	h[64], h[65], h[66] = byte(length), byte(length>>8), byte(length>>16) // file length (24 bit)
	binary.LittleEndian.PutUint16(h[67:], headerChecksum(h))
	return h
}

// amsdosHeader: a parsed AMSDOS header
type amsdosHeader struct {
	User     byte
	Name     string
	Ext      string
	Type     byte
	Load     int
	Length   int
	Exec     int
	Checksum int
}

// parseAmsdosHeader: the fields of an AMSDOS header
func parseAmsdosHeader(h []byte) amsdosHeader {
	return amsdosHeader{
		User:     h[0],
		Name:     trimEnd(latin1(h[1:9])),
		Ext:      trimEnd(latin1(h[9:12])),
		Type:     h[18],
		Load:     int(binary.LittleEndian.Uint16(h[21:])),
		Length:   int(h[64]) | int(h[65])<<8 | int(h[66])<<16,
		Exec:     int(binary.LittleEndian.Uint16(h[26:])),
		Checksum: int(binary.LittleEndian.Uint16(h[67:])),
	}
}

// amsdosDisk: an in-memory AMSDOS DATA-format disc.
type amsdosDisk struct {
	data    []byte // logical sector order
	used    map[int]bool
	entries int
}

func newAmsdosDisk() *amsdosDisk {
	return &amsdosDisk{data: bytes.Repeat([]byte{0xe5}, dskTracks*dskSectors*dskSectorSize), used: map[int]bool{0: true, 1: true}}
}

// sectorOffset: byte offset of a logical sector in data
func sectorOffset(track int, sectorID byte) int {
	return (track*dskSectors + int(sectorID) - dskFirstSector) * dskSectorSize
}

// addFile: add a file. content: for binaries include the AMSDOS header.
// Returns the display name ("HELLO.BIN").
func (d *amsdosDisk) addFile(filename string, content []byte, user byte, defaultExt string) (string, error) {
	name, ext, display := amsdosName(filename, defaultExt)
	blocksNeeded := max(1, (len(content)+dskBlockSize-1)/dskBlockSize)
	var free []int
	for b := dskDirBlocks; b < dskTotalBlocks && len(free) < blocksNeeded; b++ {
		if !d.used[b] {
			free = append(free, b)
		}
	}
	if len(free) < blocksNeeded {
		return "", fmt.Errorf("disc full: %s needs %d KB", display, blocksNeeded)
	}
	extents := (blocksNeeded + 15) / 16
	if d.entries+extents > dskDirEntries {
		return "", errors.New("directory full")
	}
	// write data
	for i, b := range free {
		off := b * dskBlockSize
		block := d.data[off : off+dskBlockSize]
		for j := range block {
			block[j] = 0x1a // CP/M EOF filler
		}
		if lo := i * dskBlockSize; lo < len(content) {
			copy(block, content[lo:min(len(content), lo+dskBlockSize)])
		}
		d.used[b] = true
	}
	// directory entries (one per 16 KB extent)
	records := (len(content) + 127) / 128
	for e := 0; e < extents; e++ {
		ent := make([]byte, 32)
		ent[0] = user
		copy(ent[1:9], name)
		copy(ent[9:12], ext)
		ent[12] = byte(e & 0x1f)        // EX
		ent[13] = 0                     // S1
		ent[14] = byte((e >> 5) & 0x3f) // S2
		recs := min(128, records-e*128)
		ent[15] = byte(max(0, recs)) // RC
		for i, b := range free[e*16 : min(len(free), e*16+16)] {
			ent[16+i] = byte(b)
		}
		copy(d.data[d.entries*32:], ent)
		d.entries++
	}
	return display, nil
}

// dirEntry: an entry of the directory
type dirEntry struct {
	User    byte
	Name    string
	Ext     string
	Extent  int
	Records int
	Blocks  []int
}

// directory: read the directory
func (d *amsdosDisk) directory() []dirEntry {
	var out []dirEntry
	for i := 0; i < dskDirEntries; i++ {
		e := d.data[i*32 : i*32+32]
		if e[0] == 0xe5 {
			continue
		}
		ext := make([]byte, 3)
		for j, c := range e[9:12] {
			ext[j] = c & 0x7f
		}
		var blocks []int
		for _, b := range e[16:32] {
			if b != 0 {
				blocks = append(blocks, int(b))
			}
		}
		out = append(out, dirEntry{
			User:    e[0],
			Name:    trimEnd(latin1(e[1:9])),
			Ext:     trimEnd(latin1(ext)),
			Extent:  int(e[12]) | int(e[14])<<5,
			Records: int(e[15]),
			Blocks:  blocks,
		})
	}
	return out
}

// readFile: read a file's raw bytes back (record granularity), nil when it is not there.
func (d *amsdosDisk) readFile(display string) []byte {
	parts := strings.Split(jsUpper(display), ".")
	n, x := parts[0], ""
	if len(parts) > 1 {
		x = parts[1]
	}
	var ents []dirEntry
	for _, e := range d.directory() {
		if e.Name == n && e.Ext == x {
			ents = append(ents, e)
		}
	}
	if len(ents) == 0 {
		return nil
	}
	sort.SliceStable(ents, func(i, j int) bool { return ents[i].Extent < ents[j].Extent })
	var out []byte
	records := 0
	for _, e := range ents {
		for _, b := range e.Blocks {
			out = append(out, d.data[b*dskBlockSize:(b+1)*dskBlockSize]...)
		}
		records += e.Records
	}
	return out[:min(len(out), records*128)]
}

// toExtendedDsk: serialize as Extended DSK image.
func (d *amsdosDisk) toExtendedDsk() []byte {
	trackSize := 256 + dskSectors*dskSectorSize // 0x1300
	header := make([]byte, 256)
	copy(header, "EXTENDED CPC DSK File\r\nDisk-Info\r\n")
	copy(header[0x22:0x22+14], pad("nerdsuite", 14))
	header[0x30] = dskTracks
	header[0x31] = 1 // sides
	for t := 0; t < dskTracks; t++ {
		header[0x34+t] = byte(trackSize >> 8)
	}
	out := header
	for t := 0; t < dskTracks; t++ {
		ti := make([]byte, 256)
		copy(ti, "Track-Info\r\n")
		ti[0x10] = byte(t)
		ti[0x11] = 0 // side
		ti[0x14] = 2 // N: 512 bytes
		ti[0x15] = dskSectors
		ti[0x16] = 0x4e // GAP#3
		ti[0x17] = 0xe5 // filler
		var datas []byte
		for i, id := range dskInterleave {
			o := 0x18 + i*8
			ti[o] = byte(t) // C
			ti[o+1] = 0     // H
			ti[o+2] = id    // R
			ti[o+3] = 2     // N
			ti[o+4] = 0     // ST1
			ti[o+5] = 0     // ST2
			binary.LittleEndian.PutUint16(ti[o+6:], dskSectorSize)
			off := sectorOffset(t, id)
			datas = append(datas, d.data[off:off+dskSectorSize]...)
		}
		out = append(out, ti...)
		out = append(out, datas...)
	}
	return out
}

// dskSector, dskTrack, parsedDsk: an extended DSK read back
type dskSector struct {
	C, H, ID, N byte
	Size        int
	Data        []byte
}

type dskTrack struct {
	Track, Side byte
	Sectors     []dskSector
}

type parsedDsk struct {
	Tracks []*dskTrack // nil: a track that is not there
	Sides  int
}

// parseExtendedDsk: parse an extended DSK back (for tests/inspection).
func parseExtendedDsk(buf []byte) (parsedDsk, error) {
	if len(buf) < 256 || !strings.HasPrefix(latin1(buf[:8]), "EXTENDED") {
		return parsedDsk{}, errors.New("not an extended DSK")
	}
	nt, ns := int(buf[0x30]), int(buf[0x31])
	var tracks []*dskTrack
	off := 256
	for i := 0; i < nt*ns; i++ {
		size := int(buf[0x34+i]) * 256
		if size == 0 {
			tracks = append(tracks, nil)
			continue
		}
		ti := buf[off : off+256]
		count := int(ti[0x15])
		var sectors []dskSector
		doff := off + 256
		for s := 0; s < count; s++ {
			o := 0x18 + s*8
			n := int(binary.LittleEndian.Uint16(ti[o+6:]))
			sectors = append(sectors, dskSector{C: ti[o], H: ti[o+1], ID: ti[o+2], N: ti[o+3], Size: n, Data: buf[doff:min(len(buf), doff+n)]})
			doff += n
		}
		tracks = append(tracks, &dskTrack{Track: ti[0x10], Side: ti[0x11], Sectors: sectors})
		off += size
	}
	return parsedDsk{Tracks: tracks, Sides: ns}, nil
}

// builtDisk: a disc with one program, its file name ("NAME.BIN") and the name to RUN ("NAME")
type builtDisk struct {
	Dsk      []byte
	Filename string
	RunName  string
	Disk     *amsdosDisk
}

// buildProgramDisk: build a DATA-format disc image with one program.
//
//	kind "bin":   content = raw program bytes (header added from load/exec) or already headed
//	kind "ascii": content = BASIC text (CRLF line ends are used; no AMSDOS header)
//
// load, exec: nil when not given (no integer)
func buildProgramDisk(name, kind string, content []byte, load, exec *int) (builtDisk, error) {
	disk := newAmsdosDisk()
	var file []byte
	var filename string
	n8, _, _ := amsdosName(name, "")
	if kind == "bin" {
		filename = strings.TrimSpace(n8) + ".BIN"
		if hasAmsdosHeader(content) {
			hdr := append([]byte{}, content[:128]...)
			// make the header name match the directory name (cosmetic) and re-checksum
			nn, ext, _ := amsdosName(filename, "")
			copy(hdr[1:9], nn)
			copy(hdr[9:12], ext)
			binary.LittleEndian.PutUint16(hdr[67:], headerChecksum(hdr))
			file = append(hdr, content[128:]...)
		} else {
			if load == nil {
				return builtDisk{}, errors.New("load address required for a binary without AMSDOS header")
			}
			e := *load
			if exec != nil {
				e = *exec
			}
			hdr := makeAmsdosHeader(filename, fileBinary, *load, e, len(content))
			file = append(hdr, content...)
		}
	} else {
		filename = strings.TrimSpace(n8) + ".BAS"
		var text []byte
		for i := 0; i < len(content); i++ {
			switch c := content[i]; c {
			case '\r':
				if i+1 < len(content) && content[i+1] == '\n' {
					i++
				}
				text = append(text, '\r', '\n')
			case '\n':
				text = append(text, '\r', '\n')
			default:
				text = append(text, c)
			}
		}
		if !bytes.HasSuffix(text, []byte("\r\n")) {
			text = append(text, '\r', '\n')
		}
		file = append(text, 0x1a)
	}
	if _, err := disk.addFile(filename, file, 0, ""); err != nil {
		return builtDisk{}, err
	}
	return builtDisk{Dsk: disk.toExtendedDsk(), Filename: filename, RunName: strings.Split(filename, ".")[0], Disk: disk}, nil
}

// CPCDisk: a DATA-format disc with one program (kind "bin" or "ascii", as buildProgramDisk) and the
// name to RUN - for emulators started elsewhere (backend/mimic)
func CPCDisk(name, kind string, content []byte, load, exec *int) (dsk []byte, runName string, err error) {
	built, err := buildProgramDisk(name, kind, content, load, exec)
	if err != nil {
		return nil, "", err
	}
	return built.Dsk, built.RunName, nil
}

// AmsdosBinary: a CPC binary without its AMSDOS header, where it loads and where it starts - the
// header's, else load (required) and exec (else load)
func AmsdosBinary(data []byte, load, exec *int) (body []byte, at, start int, err error) {
	if hasAmsdosHeader(data) {
		h := parseAmsdosHeader(data[:128])
		body = data[128:]
		if h.Length > 0 && h.Length < len(body) {
			body = body[:h.Length]
		}
		return body, h.Load, h.Exec, nil
	}
	if load == nil {
		return nil, 0, 0, errors.New("load address required for a binary without AMSDOS header")
	}
	start = *load
	if exec != nil {
		start = *exec
	}
	return data, *load, start, nil
}
