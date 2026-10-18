package core

// The settings of the tools: where VICE, KickAssembler, Java, the packers and the other emulators
// are, which emulator runs a platform, the toolchains and the Ultimate 64. They are kept in
// ~/.nerdsuite/settings.json (or the file NERDSUITE_SETTINGS names); a path set there comes before the
// environment variable of the tool (VICE, KICKASS, JAVA, ALTIRRA ...), which still works when the
// settings leave it empty. The settings API (backend/settings_api.go) reads and writes them.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// Step: a step of a toolchain - compiler, packer (args: its options), emulator
type Step struct {
	Kind    string `json:"kind"`
	Command string `json:"command"`
	Args    string `json:"args,omitempty"`
}

// Toolchain: compiler > packer > emulator (backend/toolchain); a project names it by its id
type Toolchain struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Machine  string `json:"machine"`
	Compiler Step   `json:"compiler"`
	Packer   Step   `json:"packer"`
	Emulator Step   `json:"emulator"`
}

// MarshalJSON: as the settings keep a toolchain - the packer always with its args (an empty one too),
// the compiler and the emulator without
func (t Toolchain) MarshalJSON() ([]byte, error) {
	type step struct {
		Kind    string `json:"kind"`
		Command string `json:"command"`
	}
	type packer struct {
		Kind    string `json:"kind"`
		Command string `json:"command"`
		Args    string `json:"args"`
	}
	return json.Marshal(struct {
		ID       string `json:"id"`
		Name     string `json:"name"`
		Machine  string `json:"machine"`
		Compiler step   `json:"compiler"`
		Packer   packer `json:"packer"`
		Emulator step   `json:"emulator"`
	}{t.ID, t.Name, t.Machine, step{t.Compiler.Kind, t.Compiler.Command}, packer{t.Packer.Kind, t.Packer.Command, t.Packer.Args}, step{t.Emulator.Kind, t.Emulator.Command}})
}

// Ultimate: the Ultimate 64 on the network (backend/ultimate)
type Ultimate struct {
	Host     string `json:"host,omitempty"`
	Password string `json:"password,omitempty"`
}

// SettingsData: the file
type SettingsData struct {
	Paths      map[string]string `json:"paths"`
	Preferred  map[string]string `json:"preferred"`
	Toolchains []Toolchain       `json:"toolchains"`
	Ultimate   *Ultimate         `json:"ultimate,omitempty"`
}

// Settings: the file and what was read of it
type Settings struct {
	File  string
	mu    sync.Mutex
	cache *SettingsData
}

// NewSettings: the settings of a file; "" - NERDSUITE_SETTINGS, else ~/.nerdsuite/settings.json
func NewSettings(file string) *Settings {
	if file == "" {
		file = os.Getenv("NERDSUITE_SETTINGS")
	}
	if file == "" {
		home, _ := os.UserHomeDir()
		file = filepath.Join(home, ".nerdsuite", "settings.json")
	}
	return &Settings{File: file}
}

func (s *Settings) load() *SettingsData {
	if s.cache == nil {
		d := &SettingsData{}
		if data, err := os.ReadFile(s.File); err == nil {
			if json.Unmarshal(data, d) != nil {
				d = &SettingsData{}
			}
		}
		if d.Paths == nil {
			d.Paths = map[string]string{}
		}
		if d.Preferred == nil {
			d.Preferred = map[string]string{}
		}
		if d.Toolchains == nil {
			d.Toolchains = []Toolchain{}
		}
		s.cache = d
	}
	return s.cache
}

// Get: a copy of the settings
func (s *Settings) Get() SettingsData {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := *s.load()
	d.Paths = cloneMap(d.Paths)
	d.Preferred = cloneMap(d.Preferred)
	d.Toolchains = append([]Toolchain{}, d.Toolchains...)
	if d.Ultimate != nil {
		u := *d.Ultimate
		d.Ultimate = &u
	}
	return d
}

// Save: the settings into the file
func (s *Settings) Save(d SettingsData) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if d.Paths == nil {
		d.Paths = map[string]string{}
	}
	if d.Preferred == nil {
		d.Preferred = map[string]string{}
	}
	if d.Toolchains == nil {
		d.Toolchains = []Toolchain{}
	}
	data, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.File), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(s.File, append(data, '\n'), 0o644); err != nil {
		return err
	}
	s.cache = &d
	return nil
}

// ToolPath: the path of a tool - the one of the settings, else its environment variable, else ""
func (s *Settings) ToolPath(key string) string {
	if key == "" {
		return ""
	}
	s.mu.Lock()
	p := s.load().Paths[key]
	s.mu.Unlock()
	if p != "" {
		return p
	}
	return os.Getenv(key)
}

// Preferred: the emulator chosen for a platform in the settings, or "" (the first one found)
func (s *Settings) Preferred(platform string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.load().Preferred[platform]
}

// Toolchain: the toolchain of an id
func (s *Settings) Toolchain(id string) (Toolchain, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, t := range s.load().Toolchains {
		if t.ID == id {
			return t, true
		}
	}
	return Toolchain{}, false
}

// UltimateDevice: the address and the password of the Ultimate - the settings, else ULTIMATE and
// ULTIMATE_PASSWORD
func (s *Settings) UltimateDevice() (host, password string) {
	s.mu.Lock()
	u := s.load().Ultimate
	s.mu.Unlock()
	if u != nil {
		host, password = u.Host, u.Password
	}
	if host == "" {
		host = os.Getenv("ULTIMATE")
	}
	if password == "" {
		password = os.Getenv("ULTIMATE_PASSWORD")
	}
	return host, password
}

func cloneMap(m map[string]string) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// Env: what every part of the server gets - the settings and the folder for the temporary files
type Env struct {
	Settings *Settings
	TmpDir   string
}
