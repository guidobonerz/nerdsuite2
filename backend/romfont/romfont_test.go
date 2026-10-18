package romfont

import (
	"os"
	"path/filepath"
	"testing"
)

// a folder of an emulator with a ROM file in it
func romIn(t *testing.T, folder, name string, data []byte) string {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, folder), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, folder, name), data, 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestPetSetsGetTheirInverseChars(t *testing.T) {
	data := make([]byte, 2048)
	data[8] = 0x18      // char 1 of the upper case set
	data[1024+8] = 0x3c // char 1 of the lower case set
	root := romIn(t, "PET", "characters-2.901447-10.bin", data)
	font, src := Read("pet", map[string][]string{"vice": {root}})
	if len(font) != 4096 || src == "" {
		t.Fatalf("got %d bytes from %q", len(font), src)
	}
	if font[8] != 0x18 || font[1024+8] != 0x18^0xff || font[2048+8] != 0x3c || font[3072+8] != 0x3c^0xff {
		t.Errorf("layout: % x % x % x % x", font[8], font[1024+8], font[2048+8], font[3072+8])
	}
}

func TestTedFontIsInTheKernal(t *testing.T) {
	data := make([]byte, 16384)
	data[0x1000+8] = 0x7e
	root := romIn(t, "PLUS4", "kernal-318004-05.bin", data)
	font, _ := Read("plus4", map[string][]string{"vice": {root}})
	if len(font) != 4096 || font[8] != 0x7e {
		t.Fatalf("got %d bytes, char 1 % x", len(font), font[8:9])
	}
}

func TestCpcFontAsItIs(t *testing.T) {
	data := make([]byte, 16384)
	data[0x3800+65*8] = 0x18
	root := romIn(t, "ROM", "OS6128.ROM", data)
	font, _ := Read("cpc464", map[string][]string{"winape": {root}}) // the 464 takes the 6128's when it has no OS464.ROM
	if len(font) != 2048 || font[65*8] != 0x18 {
		t.Fatalf("got %d bytes", len(font))
	}
}

func TestNoEmulatorNoFont(t *testing.T) {
	if font, src := Read("vic20", map[string][]string{}); font != nil || src != "" {
		t.Errorf("a font without VICE: %d bytes from %q", len(font), src)
	}
	if font, _ := Read("zx81", map[string][]string{"vice": {t.TempDir()}}); font != nil {
		t.Errorf("a ZX81 font")
	}
}
