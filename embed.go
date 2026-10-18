// Package nerdsuite holds the files the server hands out, built into the binary: the IDE (public/) and
// the example project (examples/demo). cmd/nerdsuite serves them; --root serves a checkout instead.
package nerdsuite

import "embed"

//go:embed all:public
var Public embed.FS

//go:embed all:examples
var Examples embed.FS
