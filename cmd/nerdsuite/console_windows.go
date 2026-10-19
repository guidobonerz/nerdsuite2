//go:build windows

package main

import (
	"os"
	"os/exec"
	"syscall"
	"unsafe"
)

// The Windows binary is built as a program with windows (-H windowsgui, tools/dist.mjs): a double click
// opens no console window. Started in a console, it writes into that one.

var (
	kernel32      = syscall.NewLazyDLL("kernel32.dll")
	attachConsole = kernel32.NewProc("AttachConsole")
	messageBox    = syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW")
)

// useConsole: the console the output goes to - its own (go run, a build without -H windowsgui), the
// pipes of who started it (tools/smoke.mjs), or the console of the cmd/PowerShell it was started in.
// false: there is none (a double click)
func useConsole() bool {
	if h, err := syscall.GetStdHandle(syscall.STD_OUTPUT_HANDLE); err == nil && h != 0 && h != syscall.InvalidHandle {
		return true
	}
	if r, _, _ := attachConsole.Call(uintptr(^uint32(0))); r == 0 { // ATTACH_PARENT_PROCESS
		return false
	}
	name, _ := syscall.UTF16PtrFromString("CONOUT$")
	h, err := syscall.CreateFile(name, syscall.GENERIC_READ|syscall.GENERIC_WRITE, syscall.FILE_SHARE_WRITE, nil, syscall.OPEN_EXISTING, 0, 0)
	if err != nil {
		return false
	}
	f := os.NewFile(uintptr(h), "CONOUT$")
	os.Stdout, os.Stderr = f, f
	return true
}

// alert: a message in a window, for a start without a console
func alert(msg string) {
	text, _ := syscall.UTF16PtrFromString(msg)
	title, _ := syscall.UTF16PtrFromString("NerdSuite")
	messageBox.Call(0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(title)), 0x10) // MB_ICONERROR
}

// detach: Windows needs none - the program has no console of its own
func detach(*exec.Cmd) {}
