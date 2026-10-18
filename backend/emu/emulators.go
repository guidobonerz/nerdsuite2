// Package emu: the launcher of the emulators that are not VICE (Atari 8-bit, Amstrad CPC, Atari 2600,
// NES, SNES) and the CPC disc images it builds for them.
//
//	GET  /api/emu/status -> { emulators: [{ id, platform, exe, available, running }] }
//	POST /api/emu/run { platform, emulator?, name, data /*base64*/, format, load?, exec?, machine? }
//	     -> { ok, emulator, file, command }
//	POST /api/emu/stop { platform? } -> { ok }
//
// Verified command lines (Windows, this machine):
//
//	Altirra 4.40, xex:          Altirra64.exe /nosingleinstance /run C:\..\prog.xex
//	Altirra 4.40, atascii-lst:  Altirra64.exe /nosingleinstance /basic /hdpath C:\..\dir /type "ENTER \"H:PROG.LST\"~RUN~"
//	     (H: device mapped to the temp dir, '~' types RETURN; BASIC must be enabled)
//	WinAPE 2.0:                 WinApe.exe C:\..\prog.dsk /A:PROG     (runs RUN"PROG from drive A)
//	Stella:                     Stella.exe C:\..\prog.a26
//
// NES and SNES (from their docs, not installed here): Mesen x.nes / x.sfc, fceux x.nes, nestopia x.nes,
// bsnes x.sfc, snes9x x.sfc, mame nes -cart x.nes, mame snes -cart x.sfc.
// Not installed here (command lines from their docs): atari800 -run x.xex,
// cap32 -a "run\"PROG" x.dsk, mame cpc6128 -flop1 x.dsk -autoboot_command ..., mame a2600 -cart x.a26.
//
// Note: Altirra pauses emulation while its window is inactive (default setting),
// so programs only start running once the window has the focus.
package emu

import (
	"path/filepath"
	"strings"

	"nerdsuite/backend/core"
)

func apps(p ...string) string { return filepath.Join(append([]string{core.AppsDir()}, p...)...) }

// emulator: a definition; its Name is the id with its first letter upper case (the label of the settings)
func emulator(d core.ToolDef) core.ToolDef {
	d.Name = strings.ToUpper(d.ID[:1]) + d.ID[1:]
	return d
}

// Emulators: the emulator definitions. core.ResolveExe(settings, def) -> the exe path or "".
var Emulators = []core.ToolDef{
	emulator(core.ToolDef{ID: "altirra", Platforms: []string{"atari"}, Env: "ALTIRRA",
		Defaults: []string{apps("Altirra", "Altirra64.exe"), apps("Altirra", "Altirra.exe")},
		Path:     []string{"Altirra64", "Altirra"}}),
	emulator(core.ToolDef{ID: "atari800", Platforms: []string{"atari"}, Env: "ATARI800", Defaults: []string{}, Path: []string{"atari800"}}),
	emulator(core.ToolDef{ID: "winape", Platforms: []string{"cpc"}, Env: "WINAPE", Defaults: []string{apps("winape", "WinApe.exe")}, Path: []string{"WinApe"}}),
	emulator(core.ToolDef{ID: "caprice", Platforms: []string{"cpc"}, Env: "CAPRICE", Defaults: []string{}, Path: []string{"cap32"}}),
	emulator(core.ToolDef{ID: "stella", Platforms: []string{"vcs"}, Env: "STELLA", Defaults: []string{}, Dir: apps("stella"), DirNames: []string{"Stella.exe", "stella.exe", "Stella64.exe"}, Path: []string{"Stella", "stella"}}),
	emulator(core.ToolDef{ID: "mesen", Platforms: []string{"nes", "snes"}, Env: "MESEN", Defaults: []string{}, Dir: apps("mesen"), DirNames: []string{"Mesen.exe", "Mesen2.exe"}, Path: []string{"Mesen", "mesen"}}),
	emulator(core.ToolDef{ID: "fceux", Platforms: []string{"nes"}, Env: "FCEUX", Defaults: []string{}, Dir: apps("fceux"), DirNames: []string{"fceux64.exe", "fceux.exe", "qfceux.exe"}, Path: []string{"fceux64", "fceux", "qfceux"}}),
	emulator(core.ToolDef{ID: "nestopia", Platforms: []string{"nes"}, Env: "NESTOPIA", Defaults: []string{}, Dir: apps("nestopia"), DirNames: []string{"nestopia.exe"}, Path: []string{"nestopia"}}),
	emulator(core.ToolDef{ID: "bsnes", Platforms: []string{"snes"}, Env: "BSNES", Defaults: []string{}, Dir: apps("bsnes"), DirNames: []string{"bsnes.exe"}, Path: []string{"bsnes"}}),
	emulator(core.ToolDef{ID: "snes9x", Platforms: []string{"snes"}, Env: "SNES9X", Defaults: []string{}, Dir: apps("snes9x"), DirNames: []string{"snes9x-x64.exe", "snes9x.exe"}, Path: []string{"snes9x-x64", "snes9x"}}),
	emulator(core.ToolDef{ID: "mame", Platforms: []string{"cpc", "vcs", "nes", "snes"}, Env: "MAME",
		Defaults: []string{apps("mame", "mame64.exe"), apps("mame", "mame.exe")},
		Path:     []string{"mame64", "mame"}}),
}

// PlatformEmulators: the emulators of a platform, the first one found runs it
type PlatformEmulators struct {
	ID        string
	Emulators []string
}

// Preferred: the order of the emulators of each platform (after the one chosen in the settings)
var Preferred = []PlatformEmulators{
	{"atari", []string{"altirra", "atari800"}},
	{"cpc", []string{"winape", "caprice", "mame"}},
	{"vcs", []string{"stella", "mame"}},
	{"nes", []string{"mesen", "fceux", "nestopia", "mame"}},
	{"snes", []string{"mesen", "bsnes", "snes9x", "mame"}},
}

// formats: the program formats each platform runs, in the order of the platforms
var formats = []struct {
	platform string
	formats  []string
}{
	{"atari", []string{"xex", "atascii-lst"}},
	{"cpc", []string{"amsdos-bin", "cpc-ascii"}},
	{"vcs", []string{"a26"}},
	{"nes", []string{"nes"}},
	{"snes", []string{"sfc"}},
}

func formatsOf(platform string) ([]string, bool) {
	for _, f := range formats {
		if f.platform == platform {
			return f.formats, true
		}
	}
	return nil, false
}

func preferredOf(platform string) []string {
	for _, p := range Preferred {
		if p.ID == platform {
			return p.Emulators
		}
	}
	return nil
}

func emulatorByID(id string) (core.ToolDef, bool) {
	for _, d := range Emulators {
		if d.ID == id {
			return d, true
		}
	}
	return core.ToolDef{}, false
}

func runsOn(d core.ToolDef, platform string) bool {
	for _, p := range d.Platforms {
		if p == platform {
			return true
		}
	}
	return false
}

// toAtascii: ATASCII text - accept \n / \r\n line ends and convert to EOL ($9B).
func toAtascii(buf []byte) []byte {
	out := make([]byte, 0, len(buf)+1)
	for i := 0; i < len(buf); i++ {
		c := buf[i]
		if c == 0x0d {
			if i+1 < len(buf) && buf[i+1] == 0x0a {
				i++
			}
			out = append(out, 0x9b)
		} else if c == 0x0a {
			out = append(out, 0x9b)
		} else {
			out = append(out, c)
		}
	}
	if len(out) > 0 && out[len(out)-1] != 0x9b {
		out = append(out, 0x9b)
	}
	return out
}

// dosStem: 8.3 uppercase file name stem for DOS/H:/AMSDOS ("" - PROGRAM).
func dosStem(name string) string {
	base := lastSegment(name)
	if i := strings.LastIndex(base, "."); i >= 0 {
		base = base[:i]
	}
	stem := strings.Map(func(r rune) rune {
		if r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, jsUpper(base))
	stem = cut(strings.TrimLeft(stem, "0123456789"), 8)
	if stem == "" {
		return "PROGRAM"
	}
	return stem
}

// runRequest: what is run - the platform, the emulator, the program and how it is loaded
type runRequest struct {
	Platform, Emulator, Name string
	Data                     []byte
	Format                   string
	Load, Exec               *int // nil: not given (no integer)
	Machine                  string
}

// planFile: a file to write before the start
type planFile struct {
	Path string
	Data []byte
}

// plan: the launch plan
type plan struct {
	Emulator string
	Exe      string
	Args     []string
	Files    []planFile
	File     string
	Cwd      string
}

// planRun: build the launch plan (pure, no side effects except returning files to write).
func planRun(r runRequest, tmpDir, exe string) (plan, error) {
	stem := dosStem(r.Name)
	dir := filepath.Join(tmpDir, r.Platform)
	var files []planFile
	var args []string
	var file string
	data := r.Data

	switch r.Platform + "/" + r.Emulator {
	case "atari/altirra", "atari/atari800":
		switch r.Format {
		case "xex":
			file = filepath.Join(dir, stem+".XEX")
			files = append(files, planFile{file, data})
			if r.Emulator == "altirra" {
				args = []string{"/nosingleinstance", "/run", file}
			} else {
				args = []string{"-run", file}
			}
		case "atascii-lst":
			hdir := filepath.Join(dir, "H")
			file = filepath.Join(hdir, stem+".LST")
			files = append(files, planFile{file, toAtascii(data)})
			if r.Emulator == "altirra" {
				args = []string{"/nosingleinstance", "/basic", "/hdpath", hdir, "/type", `ENTER "H:` + stem + `.LST"~RUN~`}
			} else {
				// atari800 has an H: device but no auto-type; the user types ENTER "H1:..." and RUN.
				args = []string{"-basic", "-H1", hdir}
			}
		default:
			return plan{}, core.Errorf(400, "unsupported atari format '%s'", r.Format)
		}
	case "cpc/winape", "cpc/caprice", "cpc/mame":
		var built builtDisk
		var err error
		switch r.Format {
		case "amsdos-bin":
			built, err = buildProgramDisk(stem, "bin", data, r.Load, r.Exec)
		case "cpc-ascii":
			built, err = buildProgramDisk(stem, "ascii", data, nil, nil)
		default:
			return plan{}, core.Errorf(400, "unsupported cpc format '%s'", r.Format)
		}
		if err != nil {
			return plan{}, err
		}
		file = filepath.Join(dir, stem+".DSK")
		files = append(files, planFile{file, built.Dsk})
		run := built.RunName
		switch r.Emulator {
		case "winape":
			args = []string{file, "/A:" + run}
		case "caprice":
			args = []string{"-a", `run"` + run, file}
		default:
			sys := "cpc6128"
			switch r.Machine {
			case "464", "cpc464":
				sys = "cpc464"
			case "664", "cpc664":
				sys = "cpc664"
			}
			args = []string{sys, "-flop1", file, "-autoboot_delay", "2", "-autoboot_command", `run"` + run + `\n`, "-window"}
		}
	case "vcs/stella", "vcs/mame":
		if r.Format != "a26" {
			return plan{}, core.Errorf(400, "unsupported vcs format '%s'", r.Format)
		}
		// allow odd sizes (e.g. 2K/4K padded by the assembler) but refuse an empty one
		if len(data) == 0 {
			return plan{}, core.Errorf(400, "empty cartridge image")
		}
		file = filepath.Join(dir, stem+".a26")
		files = append(files, planFile{file, data})
		if r.Emulator == "stella" {
			args = []string{file}
		} else {
			args = []string{"a2600", "-cart", file, "-window"}
		}
	case "nes/mesen", "nes/fceux", "nes/nestopia", "nes/mame":
		if r.Format != "nes" {
			return plan{}, core.Errorf(400, "unsupported nes format '%s'", r.Format)
		}
		if len(data) < 16 || string(data[:4]) != "NES\x1a" {
			return plan{}, core.Errorf(400, "no iNES header (NES and $1a)")
		}
		file = filepath.Join(dir, stem+".nes")
		files = append(files, planFile{file, data})
		if r.Emulator == "mame" {
			args = []string{"nes", "-cart", file, "-window"}
		} else {
			args = []string{file}
		}
	case "snes/mesen", "snes/bsnes", "snes/snes9x", "snes/mame":
		if r.Format != "sfc" {
			return plan{}, core.Errorf(400, "unsupported snes format '%s'", r.Format)
		}
		if len(data) < 0x8000 {
			return plan{}, core.Errorf(400, "a SNES ROM has 32K at least")
		}
		file = filepath.Join(dir, stem+".sfc")
		files = append(files, planFile{file, data})
		if r.Emulator == "mame" {
			args = []string{"snes", "-cart", file, "-window"}
		} else {
			args = []string{file}
		}
	default:
		return plan{}, core.Errorf(400, "emulator '%s' does not support platform '%s'", r.Emulator, r.Platform)
	}
	return plan{Emulator: r.Emulator, Exe: exe, Args: args, Files: files, File: file, Cwd: filepath.Dir(exe)}, nil
}

// the platforms for the message of an unknown one: "atari, cpc, vcs, nes, snes"
func platformList() string {
	var ids []string
	for _, f := range formats {
		ids = append(ids, f.platform)
	}
	return strings.Join(ids, ", ")
}
