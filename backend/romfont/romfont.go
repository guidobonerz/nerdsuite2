// Package romfont: the character ROMs of the machines, read from the emulators installed on this computer -
// nothing of them is in nerdsuite. VICE has the VIC-20's, the PET's, the TED's (in the kernal of the
// Plus/4) and the C128's; WinAPE the CPC's (in its OS ROM).
//
//	GET /api/fonts/{machine} -> { machine, source: the file, font: base64 } or 404 { error }
//
// The font is in the layout of the C64's character ROM for the Commodores - the upper case set with its
// inverse chars (2K), then the lower case set with its own (2K): the PET and the TED invert in the video
// chip, so their 128 chars a set get their inverse ones here. The CPC's is its 256 chars (2K) as they are.
package romfont

import (
	"encoding/base64"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"nerdsuite/backend/core"
	"nerdsuite/backend/emu"
	"nerdsuite/backend/vice"
)

// where a font is: the folder of the emulator (vice: the machine's folder of VICE, winape: its ROM folder), the
// names of the file (the first one found), the offset and the size of the font in it, and its layout
type rom struct {
	in     string // "vice" or "winape"
	folder string // under it
	files  []string
	at     int
	size   int
	layout string // "c64": 4K as the C64's; "sets": two sets of 128 chars, no inverse ones; "raw": as it is
}

var roms = map[string]rom{
	"vic20":   {"vice", "VIC20", []string{"chargen-901460-03.bin", "chargen"}, 0, 4096, "c64"},
	"pet":     {"vice", "PET", []string{"characters-2.901447-10.bin", "chargen"}, 0, 2048, "sets"},
	"plus4":   {"vice", "PLUS4", []string{"kernal-318004-05.bin", "kernal.318004-05.bin", "kernal"}, 0x1000, 2048, "sets"},
	"c16":     {"vice", "PLUS4", []string{"kernal-318004-05.bin", "kernal.318004-05.bin", "kernal"}, 0x1000, 2048, "sets"},
	"c128":    {"vice", "C128", []string{"chargen-390059-01.bin", "chargen"}, 0, 4096, "c64"},
	"cpc464":  {"winape", "ROM", []string{"OS464.ROM", "OS6128.ROM"}, 0x3800, 2048, "raw"},
	"cpc6128": {"winape", "ROM", []string{"OS6128.ROM", "OS464.ROM"}, 0x3800, 2048, "raw"},
}

// API: the handler of /api/fonts
type API struct{ env core.Env }

func New(env core.Env) *API { return &API{env: env} }

// the folders the emulators keep their ROMs in: VICE's root (GTK3VICE: the folder above bin), WinAPE's folder
func (a *API) roots() map[string][]string {
	out := map[string][]string{}
	if exe, err := vice.FindExecutable(a.env.Settings, "c64"); err == nil {
		out["vice"] = []string{filepath.Dir(filepath.Dir(exe)), filepath.Dir(exe)}
	}
	for _, d := range emu.Emulators {
		if d.ID == "winape" {
			if exe := core.ResolveExe(a.env.Settings, d); exe != "" {
				out["winape"] = []string{filepath.Dir(exe)}
			}
		}
	}
	return out
}

// Read: the font of a machine from the folders of the emulators (roots: "vice" / "winape" -> folders), the
// file it came from; "" when there is none
func Read(machine string, roots map[string][]string) ([]byte, string) {
	r, ok := roms[machine]
	if !ok {
		return nil, ""
	}
	for _, root := range roots[r.in] {
		for _, name := range r.files {
			path := filepath.Join(root, r.folder, name)
			data, err := os.ReadFile(path)
			if err != nil || len(data) < r.at+r.size {
				continue
			}
			return shape(data[r.at:r.at+r.size], r.layout), path
		}
	}
	return nil, ""
}

// shape: the font in the layout the IDE reads (see the package comment)
func shape(font []byte, layout string) []byte {
	if layout != "sets" {
		return append([]byte(nil), font...)
	}
	out := make([]byte, 0, 4096)
	for set := 0; set < 2; set++ {
		chars := font[set*1024 : set*1024+1024]
		out = append(out, chars...)
		for _, b := range chars {
			out = append(out, b^0xff)
		}
	}
	return out
}

func (a *API) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	machine := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/fonts"), "/")
	if r.Method != http.MethodGet || machine == "" || strings.Contains(machine, "/") {
		core.WriteJSON(w, 404, map[string]any{"error": "GET /api/fonts/MACHINE"})
		return
	}
	font, source := Read(machine, a.roots())
	if font == nil {
		core.WriteJSON(w, 404, map[string]any{"error": "no character ROM of " + machine + " found (VICE or WinAPE)"})
		return
	}
	core.WriteJSON(w, 200, map[string]any{"machine": machine, "source": source, "font": base64.StdEncoding.EncodeToString(font)})
}
