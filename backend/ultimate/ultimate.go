// Package ultimate: a real C64 - the Ultimate 64 (and the Ultimate-II+ cartridge) on the network,
// through the REST API of its firmware (3.11 and later): the program goes to it and runs there.
//
//	GET  /api/ultimate/status  -> { configured, host, reachable, version, error }
//	POST /api/ultimate/run     { name, data /*base64: a .prg*/ } -> { ok, host, bytes }
//	POST /api/ultimate/reset   -> { ok }
//
// Where it is: the Settings ({ ultimate: { host, password } }), else the environment variables
// ULTIMATE (its address) and ULTIMATE_PASSWORD. Only that address is asked: a request names no device
// of its own.
//
// The device: POST /v1/runners:run_prg with the program as the body runs it (the C64 is reset first),
// PUT /v1/machine:reset resets it, GET /v1/version answers; a password set on the device goes in
// X-Password.
package ultimate

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"regexp"
	"strings"
	"time"

	"nerdsuite/backend/core"
)

const timeout = 8 * time.Second

var hostRe = regexp.MustCompile(`(?i)^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(:\d{1,5})?$`)

// DeviceURL: the address of the device - a name or an IP, a port maybe; no path, no other scheme.
// "" for none
func DeviceURL(host string) (string, error) {
	h := strings.TrimSpace(host)
	if len(h) >= 7 && strings.EqualFold(h[:7], "http://") {
		h = h[7:]
	}
	h = strings.TrimRight(h, "/")
	if h == "" {
		return "", nil
	}
	if !hostRe.MatchString(h) {
		return "", core.Errorf(400, "'%s' is no address of a device (a name or an IP, a port maybe)", host)
	}
	return "http://" + h, nil
}

// API: the Ultimate of the settings
type API struct {
	env    core.Env
	client *http.Client
}

func New(env core.Env) *API {
	return &API{env: env, client: &http.Client{}}
}

// call: a request to the device -> its answer in JSON ({} for none)
func (a *API) call(method, path string, body []byte, contentType string) (map[string]any, error) {
	host, password := a.env.Settings.UltimateDevice()
	base, err := DeviceURL(host)
	if err != nil {
		return nil, err
	}
	if base == "" {
		return nil, core.Errorf(409, "no Ultimate 64 is set up: its address in the Settings (Assemblers and emulators)")
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, base+path, rd)
	if err != nil {
		return nil, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if password != "" {
		req.Header.Set("X-Password", password)
	}
	res, err := a.client.Do(req)
	if err != nil {
		why := err.Error()
		var op *net.OpError
		switch {
		case errors.Is(err, context.DeadlineExceeded):
			why = "no answer in time"
		case strings.Contains(strings.ToLower(err.Error()), "refused"):
			why = "connection refused"
		case errors.As(err, &op) && op.Err != nil:
			why = op.Err.Error()
		}
		return nil, core.Errorf(504, "the Ultimate at %s does not answer: %s", host, why)
	}
	defer res.Body.Close()
	text, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	var out map[string]any
	if json.Unmarshal(text, &out) != nil {
		out = map[string]any{}
	}
	var errs []string
	if list, ok := out["errors"].([]any); ok {
		for _, e := range list {
			if s, ok := e.(string); ok && s != "" {
				errs = append(errs, s)
			}
		}
	}
	if res.StatusCode >= 300 || len(errs) > 0 {
		why := strings.Join(errs, "; ")
		if res.StatusCode == 403 {
			why = "the password is wrong (Settings)"
		} else if why == "" {
			why = res.Status
		}
		return nil, core.Errorf(502, "the Ultimate at %s: %s", host, why)
	}
	return out, nil
}

func (a *API) status() map[string]any {
	host, _ := a.env.Settings.UltimateDevice()
	if host == "" {
		return map[string]any{"configured": false, "host": "", "reachable": false}
	}
	v, err := a.call("GET", "/v1/version", nil, "")
	if err != nil {
		return map[string]any{"configured": true, "host": host, "reachable": false, "error": err.Error()}
	}
	return map[string]any{"configured": true, "host": host, "reachable": true, "version": v["version"]}
}

func (a *API) run(r *http.Request) (map[string]any, error) {
	var body struct {
		Name string  `json:"name"`
		Data *string `json:"data"`
	}
	if err := core.ReadJSON(r, 2<<20, &body); err != nil {
		return nil, err
	}
	if body.Data == nil {
		return nil, core.Errorf(400, "'data' must be a base64 string")
	}
	prg, err := base64.StdEncoding.DecodeString(*body.Data)
	if err != nil {
		return nil, core.Errorf(400, "'data' must be a base64 string")
	}
	if len(prg) < 3 {
		return nil, core.Errorf(400, "the program has no load address and no data")
	}
	if _, err := a.call("POST", "/v1/runners:run_prg", prg, "application/octet-stream"); err != nil {
		return nil, err
	}
	host, _ := a.env.Settings.UltimateDevice()
	return map[string]any{"ok": true, "host": host, "bytes": len(prg)}, nil
}

func (a *API) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	route := core.Route(r)
	if route == "GET /api/ultimate/status" {
		core.WriteJSON(w, 200, a.status())
		return
	}
	if route != "POST /api/ultimate/run" && route != "POST /api/ultimate/reset" {
		core.WriteJSON(w, 404, map[string]any{"error": "not found"})
		return
	}
	// they drive a machine on the network: the page of this server only
	if !core.SameOrigin(r) {
		core.WriteJSON(w, 403, map[string]any{"error": "the Ultimate is driven by the page of this server only"})
		return
	}
	if route == "POST /api/ultimate/run" {
		out, err := a.run(r)
		if err != nil {
			core.Fail(w, err)
			return
		}
		core.WriteJSON(w, 200, out)
		return
	}
	var body map[string]any
	if err := core.ReadJSON(r, 2<<20, &body); err != nil {
		core.Fail(w, err)
		return
	}
	if _, err := a.call("PUT", "/v1/machine:reset", nil, ""); err != nil {
		core.Fail(w, err)
		return
	}
	core.WriteJSON(w, 200, map[string]any{"ok": true})
}
