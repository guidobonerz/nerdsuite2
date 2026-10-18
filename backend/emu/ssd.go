package emu

// BBC Micro disc images: Acorn DFS, single sided, 40 tracks of 10 sectors of 256 bytes (.ssd).
//
// Sectors 0 and 1 hold the catalogue: sector 0 the first 8 characters of the title and the names
// (7 characters and the directory) of up to 31 files, sector 1 the rest of the title, the number of
// entries * 8, the boot option (*OPT 4,n: 3 = *EXEC !BOOT on SHIFT+BREAK) and the size of the disc,
// then per file its load and exec address, its length (bits 16-17 in a mixed byte) and its start
// sector. The files follow from sector 2, the catalogue lists the last one first.

import (
	"fmt"
	"strings"

	"nerdsuite/backend/core"
)

const (
	ssdSectors    = 400
	ssdSectorSize = 256
	ssdMaxFiles   = 31
	bootExec      = 3 // *OPT 4,3: SHIFT+BREAK runs *EXEC !BOOT
)

// dfsFile: a file of a DFS disc; Load and Exec with their bits 16-17 ($FFxxxx: the I/O processor)
type dfsFile struct {
	Name       string
	Load, Exec uint32
	Data       []byte
}

// buildSSD: the .ssd image of the files, the first one at sector 2
func buildSSD(title string, boot byte, files []dfsFile) ([]byte, error) {
	if len(files) > ssdMaxFiles {
		return nil, core.Errorf(400, "a DFS disc holds %d files", ssdMaxFiles)
	}
	img := make([]byte, ssdSectors*ssdSectorSize)
	cat0, cat1 := img[0:256], img[256:512]
	t := []byte(fmt.Sprintf("%-12s", cut(title, 12)))
	copy(cat0[0:8], t[:8])
	copy(cat1[0:4], t[8:12])
	cat1[5] = byte(len(files) * 8)
	cat1[6] = boot<<4 | byte(ssdSectors>>8&3)
	cat1[7] = byte(ssdSectors & 255)

	sector := 2
	starts := make([]int, len(files))
	for i, f := range files {
		n := (len(f.Data) + ssdSectorSize - 1) / ssdSectorSize
		if sector+n > ssdSectors {
			return nil, core.Errorf(400, "the files do not fit on a DFS disc (%d sectors)", ssdSectors)
		}
		copy(img[sector*ssdSectorSize:], f.Data)
		starts[i] = sector
		sector += n
	}
	// the catalogue: the file with the highest start sector first
	for k := range files {
		i := len(files) - 1 - k
		f := files[i]
		name := fmt.Sprintf("%-7s", cut(f.Name, 7))
		e0, e1 := cat0[8+k*8:16+k*8], cat1[8+k*8:16+k*8]
		copy(e0[0:7], name)
		e0[7] = '$'
		l, s := uint32(len(f.Data)), uint32(starts[i])
		e1[0], e1[1] = byte(f.Load), byte(f.Load>>8)
		e1[2], e1[3] = byte(f.Exec), byte(f.Exec>>8)
		e1[4], e1[5] = byte(l), byte(l>>8)
		e1[6] = byte(f.Exec>>16&3)<<6 | byte(l>>16&3)<<4 | byte(f.Load>>16&3)<<2 | byte(s>>8&3)
		e1[7] = byte(s)
	}
	return img, nil
}

// buildBBCDisc: the disc Run boots - a program (*RUN from !BOOT) or a BASIC listing (!BOOT types it in, then RUN)
func buildBBCDisc(stem, format string, data []byte, load, exec *int) ([]byte, error) {
	name := cut(stem, 7)
	switch format {
	case "bbc-bin":
		if load == nil {
			return nil, core.Errorf(400, "a BBC program needs its load address")
		}
		run := *load
		if exec != nil {
			run = *exec
		}
		// $FFxxxx: loaded into the BBC itself (not a second processor)
		boot := []byte("*RUN " + name + "\r")
		return buildSSD(name, bootExec, []dfsFile{
			{Name: "!BOOT", Data: boot},
			{Name: name, Load: 0x30000 | uint32(*load&0xffff), Exec: 0x30000 | uint32(run&0xffff), Data: data},
		})
	case "bbc-ascii":
		text := strings.ReplaceAll(strings.ReplaceAll(string(data), "\r\n", "\r"), "\n", "\r")
		if !strings.HasSuffix(text, "\r") {
			text += "\r"
		}
		return buildSSD(name, bootExec, []dfsFile{{Name: "!BOOT", Data: []byte(text + "RUN\r")}})
	}
	return nil, core.Errorf(400, "unsupported bbc format '%s'", format)
}
