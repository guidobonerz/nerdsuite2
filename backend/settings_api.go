package backend

// The settings of the tools, as the Settings dialog of the IDE (public/js/settings.js) reads and writes
// them (core/settings.go keeps them):
//
//	GET /api/settings/tools   the tools: their path set here, the variable, the program found, available
//	PUT /api/settings/tools   { paths: { VICE: '...' }, preferred: { atari: 'altirra' }, toolchains: [...],
//	                          ultimate: { host, password } } -> the same
//
// The toolchains (compiler > packer > emulator, backend/toolchain) are replaced as a whole list.

import (
	"encoding/json"
	"net/http"
	"os"
	"regexp"
	"strings"
	"unicode/utf8"

	"nerdsuite/backend/core"
)

// tool: a program of the settings list; resolve: the program found, or ""
type tool struct {
	Key, Label, Group, Hint string
	Resolve                 func() string
}

// platformList: the emulators a platform can choose from, in their order
type platformList struct {
	ID        string
	Emulators []string
}

type settingsAPI struct {
	st        *core.Settings
	tools     []tool
	platforms []platformList
	onChange  func()
}

func (a *settingsAPI) describe() map[string]any {
	s := a.st.Get()
	tools := make([]map[string]any, 0, len(a.tools))
	for _, t := range a.tools {
		found := t.Resolve()
		var f any
		if found != "" {
			f = found
		}
		tools = append(tools, map[string]any{"key": t.Key, "label": t.Label, "group": t.Group, "hint": t.Hint,
			"value": s.Paths[t.Key], "env": os.Getenv(t.Key), "found": f, "available": found != ""})
	}
	platforms := make([]map[string]any, 0, len(a.platforms))
	for _, p := range a.platforms {
		platforms = append(platforms, map[string]any{"id": p.ID, "emulators": p.Emulators, "preferred": s.Preferred[p.ID]})
	}
	u := map[string]any{"host": "", "password": false, "env": os.Getenv("ULTIMATE")}
	if s.Ultimate != nil {
		u["host"], u["password"] = s.Ultimate.Host, s.Ultimate.Password != ""
	}
	return map[string]any{"file": a.st.File, "tools": tools, "platforms": platforms, "toolchains": s.Toolchains, "ultimate": u}
}

func bad(format string, a ...any) error { return core.Errorf(400, format, a...) }

// text: a text of max characters at most, trimmed; null or absent - ""
func text(v any, max int, what string) (string, error) {
	if v == nil {
		return "", nil
	}
	s, ok := v.(string)
	if !ok || utf8.RuneCountInString(s) > max {
		return "", bad("%s is no text of %d characters at most", what, max)
	}
	return strings.TrimSpace(s), nil
}

var idRe = regexp.MustCompile(`^[\w-]+$`)
var hostRe = regexp.MustCompile(`(?i)^(http://)?(\[[0-9a-f:]+\]|[a-z0-9.-]+)(:\d{1,5})?/?$`)

// CleanToolchain: a toolchain as the settings keep it: { id, name, machine, compiler: { kind, command },
// packer: { kind, args, command }, emulator: { kind, command } } - the kinds are checked where they are
// used (backend/toolchain)
func CleanToolchain(v any, i int) (core.Toolchain, error) {
	t, ok := v.(map[string]any)
	if !ok {
		return core.Toolchain{}, bad("toolchain %d is no object", i+1)
	}
	id, err := text(t["id"], 40, "the id of a toolchain")
	if err != nil {
		return core.Toolchain{}, err
	}
	if !idRe.MatchString(id) {
		return core.Toolchain{}, bad("'%s' is no id of a toolchain (letters, digits, - and _)", id)
	}
	kind := func(v any, what, def string) (string, error) {
		k, err := text(v, 40, what)
		if err != nil {
			return "", err
		}
		if k == "" {
			k = def
		}
		if !idRe.MatchString(k) {
			return "", bad("'%s' is no %s", k, what)
		}
		return k, nil
	}
	step := func(v any, what, def string, withArgs bool) (core.Step, error) {
		s, _ := v.(map[string]any)
		k, err := kind(s["kind"], "kind of "+what, def)
		if err != nil {
			return core.Step{}, err
		}
		cmd, err := text(s["command"], 2000, "the command of the "+what)
		if err != nil {
			return core.Step{}, err
		}
		out := core.Step{Kind: k, Command: cmd}
		if withArgs {
			if out.Args, err = text(s["args"], 500, "the options of the packer"); err != nil {
				return core.Step{}, err
			}
		}
		return out, nil
	}
	name, err := text(t["name"], 80, "the name of a toolchain")
	if err != nil {
		return core.Toolchain{}, err
	}
	if name == "" {
		name = id
	}
	machine, err := text(t["machine"], 20, "the machine of a toolchain")
	if err != nil {
		return core.Toolchain{}, err
	}
	out := core.Toolchain{ID: id, Name: name, Machine: machine}
	if out.Compiler, err = step(t["compiler"], "compiler", "project", false); err != nil {
		return core.Toolchain{}, err
	}
	if out.Packer, err = step(t["packer"], "packer", "none", true); err != nil {
		return core.Toolchain{}, err
	}
	if out.Emulator, err = step(t["emulator"], "emulator", "auto", false); err != nil {
		return core.Toolchain{}, err
	}
	return out, nil
}

func (a *settingsAPI) update(body map[string]json.RawMessage) error {
	next := a.st.Get()
	var paths map[string]any
	if raw, ok := body["paths"]; ok && string(raw) != "null" {
		if json.Unmarshal(raw, &paths) != nil {
			return bad("the paths are no object")
		}
	}
	for key, v := range paths {
		known := false
		for _, t := range a.tools {
			known = known || t.Key == key
		}
		if !known {
			return bad("unknown tool '%s'", key)
		}
		s, ok := v.(string)
		if !ok || utf8.RuneCountInString(s) > 1024 {
			return bad("the path of %s is no text", key)
		}
		if strings.TrimSpace(s) != "" {
			next.Paths[key] = strings.TrimSpace(s)
		} else {
			delete(next.Paths, key)
		}
	}
	var preferred map[string]any
	if raw, ok := body["preferred"]; ok && string(raw) != "null" {
		if json.Unmarshal(raw, &preferred) != nil {
			return bad("the preferred emulators are no object")
		}
	}
	for platform, v := range preferred {
		var list []string
		found := false
		for _, p := range a.platforms {
			if p.ID == platform {
				list, found = p.Emulators, true
			}
		}
		if !found {
			return bad("unknown platform '%s'", platform)
		}
		id, _ := v.(string)
		if id != "" {
			ok := false
			for _, e := range list {
				ok = ok || e == id
			}
			if !ok {
				return bad("'%s' does not run %s", id, platform)
			}
			next.Preferred[platform] = id
		} else {
			delete(next.Preferred, platform)
		}
	}
	if raw, ok := body["ultimate"]; ok {
		var u map[string]any
		json.Unmarshal(raw, &u)
		host, err := text(u["host"], 260, "the address of the Ultimate")
		if err != nil {
			return err
		}
		if host != "" && !hostRe.MatchString(host) {
			return bad("'%s' is no address of a device (a name or an IP, a port maybe)", host)
		}
		cur := core.Ultimate{}
		if next.Ultimate != nil {
			cur = *next.Ultimate
		}
		cur.Host = host
		// the password: only when one is sent ('' removes it)
		if pw, ok := u["password"]; ok {
			if cur.Password, err = text(pw, 200, "the password of the Ultimate"); err != nil {
				return err
			}
		}
		next.Ultimate = &cur
		if cur.Host == "" && cur.Password == "" {
			next.Ultimate = nil
		}
	}
	if raw, ok := body["toolchains"]; ok {
		var list []any
		if json.Unmarshal(raw, &list) != nil || list == nil || len(list) > 100 {
			return bad("the toolchains are a list of 100 at most")
		}
		next.Toolchains = make([]core.Toolchain, 0, len(list))
		ids := map[string]bool{}
		for i, v := range list {
			t, err := CleanToolchain(v, i)
			if err != nil {
				return err
			}
			if ids[t.ID] {
				return bad("two toolchains have the same id")
			}
			ids[t.ID] = true
			next.Toolchains = append(next.Toolchains, t)
		}
	}
	if err := a.st.Save(next); err != nil {
		return core.Errorf(500, "the settings were not written: %v", err)
	}
	if a.onChange != nil {
		a.onChange()
	}
	return nil
}

func (a *settingsAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch core.Route(r) {
	case "GET /api/settings/tools":
		core.WriteJSON(w, 200, a.describe())
	case "PUT /api/settings/tools":
		if !core.SameOrigin(r) {
			core.WriteJSON(w, 403, map[string]any{"error": "the settings are changed by the page of this server only"})
			return
		}
		var body map[string]json.RawMessage
		if err := core.ReadJSON(r, 64*1024, &body); err != nil {
			core.Fail(w, err)
			return
		}
		if err := a.update(body); err != nil {
			core.Fail(w, err)
			return
		}
		core.WriteJSON(w, 200, a.describe())
	default:
		core.WriteJSON(w, 404, map[string]any{"error": "not found"})
	}
}
