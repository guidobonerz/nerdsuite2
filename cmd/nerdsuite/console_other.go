//go:build !windows

package main

import (
	"os"
	"os/exec"
	"syscall"
)

// useConsole: the output goes to a terminal or a pipe; false: to nowhere (started detached, or by a file
// manager without a terminal)
func useConsole() bool {
	st, err := os.Stdout.Stat()
	return err == nil && (st.Mode()&os.ModeCharDevice != 0 || st.Mode()&os.ModeNamedPipe != 0) && os.Getenv(detachedEnv) == ""
}

// alert: a message in a window, for a start without a terminal - with what the desktop has
func alert(msg string) {
	for _, c := range [][]string{{"zenity", "--error", "--title=NerdSuite", "--text=" + msg}, {"kdialog", "--title", "NerdSuite", "--error", msg},
		{"osascript", "-e", `display alert "NerdSuite" message ` + quoteAS(msg) + ` as critical`}, {"notify-send", "NerdSuite", msg}} {
		if p, err := exec.LookPath(c[0]); err == nil && exec.Command(p, c[1:]...).Run() == nil {
			return
		}
	}
}

func quoteAS(s string) string {
	out := []rune{'"'}
	for _, r := range s {
		if r == '"' || r == '\\' {
			out = append(out, '\\')
		}
		out = append(out, r)
	}
	return string(append(out, '"'))
}

// detach: the server in a session of its own, without the terminal - which closes when the first
// process ends
func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
