// Package core: what the parts of the server share - the answers in JSON, the errors with their
// status, the requests of the page of this server only, where the tools are, and the settings.
package core

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"regexp"
	"strings"
)

// HTTPError: an error with the status of its answer (400, 404, ...)
type HTTPError struct {
	Status int
	Msg    string
}

func (e *HTTPError) Error() string { return e.Msg }

// Errorf: an error with a status
func Errorf(status int, format string, a ...any) error {
	return &HTTPError{Status: status, Msg: fmt.Sprintf(format, a...)}
}

// StatusOf: the status of an error (500 for one without)
func StatusOf(err error) int {
	var h *HTTPError
	if errors.As(err, &h) {
		return h.Status
	}
	return http.StatusInternalServerError
}

// WriteJSON: an answer in JSON, never cached
func WriteJSON(w http.ResponseWriter, status int, v any) {
	body, err := json.Marshal(v)
	if err != nil {
		status, body = http.StatusInternalServerError, []byte(`{"error":"the answer is no JSON"}`)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	w.Write(body)
}

// Fail: { error } with the status of the error
func Fail(w http.ResponseWriter, err error) {
	WriteJSON(w, StatusOf(err), map[string]any{"error": err.Error()})
}

// ReadJSON: the body of a request as JSON into v - an empty body is {}; max: its size at most
func ReadJSON(r *http.Request, max int64, v any) error {
	data, err := io.ReadAll(io.LimitReader(r.Body, max+1))
	if err != nil {
		return Errorf(400, "the request could not be read: %v", err)
	}
	if int64(len(data)) > max {
		return Errorf(413, "request too large")
	}
	if strings.TrimSpace(string(data)) == "" {
		data = []byte("{}")
	}
	if err := json.Unmarshal(data, v); err != nil {
		return Errorf(400, "the request is not JSON")
	}
	return nil
}

var jsonType = regexp.MustCompile(`^application/json\b`)

// SameOrigin: a request of the page of this server. A page of another site can send a form or a plain
// text, not JSON without asking first (the browser's preflight, which this server never allows)
func SameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	return (origin == "" || origin == "http://"+r.Host) && jsonType.MatchString(r.Header.Get("Content-Type"))
}

// LocalHost: a request to this server by its local name (localhost, 127.0.0.1, [::1]) - not by the name of
// another site that leads here (DNS rebinding: its page would be the same origin as the server)
func LocalHost(r *http.Request) bool {
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.Trim(strings.ToLower(host), "[]")
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

// Route: "GET /api/x" of a request, without a slash at the end
func Route(r *http.Request) string {
	return r.Method + " " + strings.TrimRight(r.URL.Path, "/")
}
