package ultimate

import (
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"nerdsuite/backend/core"
)

func TestDeviceURL(t *testing.T) {
	for in, want := range map[string]string{"192.168.1.64": "http://192.168.1.64", "http://u64.local:8080/": "http://u64.local:8080", "[fe80::1]": "http://[fe80::1]", "": ""} {
		got, err := DeviceURL(in)
		if err != nil || got != want {
			t.Errorf("DeviceURL(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"u64/v1/../x", "https://u64", "user@host"} {
		if _, err := DeviceURL(bad); err == nil || !strings.Contains(err.Error(), "no address") {
			t.Errorf("DeviceURL(%q): want an error, got %v", bad, err)
		}
	}
}

// a fake Ultimate: its REST API, a password
func TestStatusRunResetPassword(t *testing.T) {
	type seen struct {
		method, path, typ, password string
		bytes                       int
	}
	var got []seen
	dev := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got = append(got, seen{r.Method, r.URL.Path, r.Header.Get("Content-Type"), r.Header.Get("X-Password"), len(b)})
		if r.Header.Get("X-Password") != "secret" {
			w.WriteHeader(403)
			w.Write([]byte(`{"errors":["forbidden"]}`))
			return
		}
		if r.URL.Path == "/v1/version" {
			w.Write([]byte(`{"version":"0.1","errors":[]}`))
			return
		}
		w.Write([]byte(`{"errors":[]}`))
	}))
	defer dev.Close()
	st := core.NewSettings(filepath.Join(t.TempDir(), "settings.json"))
	host := strings.TrimPrefix(dev.URL, "http://")
	st.Save(core.SettingsData{Ultimate: &core.Ultimate{Host: host, Password: "wrong"}})
	api := New(core.Env{Settings: st})

	do := func(method, path, body string, origin string) (int, string) {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		rec := httptest.NewRecorder()
		api.ServeHTTP(rec, req)
		return rec.Code, rec.Body.String()
	}
	if _, body := do("GET", "/api/ultimate/status", "", ""); !strings.Contains(body, "the password is wrong") {
		t.Fatalf("wrong password: %s", body)
	}
	st.Save(core.SettingsData{Ultimate: &core.Ultimate{Host: host, Password: "secret"}})
	if _, body := do("GET", "/api/ultimate/status", "", ""); !strings.Contains(body, `"reachable":true`) || !strings.Contains(body, `"version":"0.1"`) {
		t.Fatalf("status: %s", body)
	}
	prg := base64.StdEncoding.EncodeToString([]byte{1, 8, 0x60})
	if code, body := do("POST", "/api/ultimate/run", `{"name":"x","data":"`+prg+`"}`, ""); code != 200 || !strings.Contains(body, `"bytes":3`) {
		t.Fatalf("run: %d %s", code, body)
	}
	if code, _ := do("POST", "/api/ultimate/reset", `{}`, ""); code != 200 {
		t.Fatalf("reset: %d", code)
	}
	if code, _ := do("POST", "/api/ultimate/run", `{}`, "http://evil.example"); code != 403 {
		t.Fatalf("a foreign page: %d", code)
	}
	last := got[len(got)-2]
	if last.method != "POST" || last.path != "/v1/runners:run_prg" || last.typ != "application/octet-stream" || last.bytes != 3 {
		t.Fatalf("the device saw %+v", last)
	}
	if got[len(got)-1].path != "/v1/machine:reset" || got[len(got)-1].method != "PUT" {
		t.Fatalf("reset: %+v", got[len(got)-1])
	}
}

func TestNotSetUp(t *testing.T) {
	api := New(core.Env{Settings: core.NewSettings(filepath.Join(t.TempDir(), "s.json"))})
	t.Setenv("ULTIMATE", "")
	rec := httptest.NewRecorder()
	api.ServeHTTP(rec, httptest.NewRequest("GET", "/api/ultimate/status", nil))
	if !strings.Contains(rec.Body.String(), `"configured":false`) {
		t.Fatal(rec.Body.String())
	}
}
