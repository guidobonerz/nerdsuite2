package backend

import (
	"os"
	"sync"
	"time"
)

// The windows of the IDE, for a server that ends when they are closed (Options.Idle > 0, a desktop start):
// each window asks /api/info?window=ID now and then, and says /api/bye?window=ID when it is closed (a
// beacon of pagehide). The server ends byeGrace after a bye when no window is left that asked within Idle
// (a reload: the new page asks at once, as a window of its own); else Idle after the last request (a
// window that crashed says no bye).

// byeGrace: how long a bye waits for the new page of a reload
const byeGrace = 3 * time.Second

type windows struct {
	mu   sync.Mutex
	seen map[string]time.Time // window -> its last request
	bye  time.Time            // the last bye
}

// alive: a window asked
func (w *windows) alive(id string) {
	if id == "" {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.seen == nil {
		w.seen = map[string]time.Time{}
	}
	w.seen[id] = time.Now()
}

// closed: a window is gone
func (w *windows) closed(id string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	delete(w.seen, id)
	w.bye = time.Now()
}

// done: whether the server should end now - last: the time of its last request
func (w *windows) done(now, last time.Time, idle time.Duration) bool {
	if now.Sub(last) > idle {
		return true
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.bye.IsZero() || now.Sub(w.bye) < byeGrace {
		return false
	}
	for _, t := range w.seen {
		if now.Sub(t) <= idle {
			return false
		}
	}
	return true
}

// QuitWhenIdle: ends the program when the windows of the IDE are closed (see above)
func (s *Server) QuitWhenIdle() {
	s.last.Store(time.Now().UnixNano())
	for range time.Tick(time.Second) {
		if s.win.done(time.Now(), time.Unix(0, s.last.Load()), s.opts.Idle) {
			s.Close()
			os.Exit(0)
		}
	}
}
