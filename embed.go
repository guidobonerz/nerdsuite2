// Package nerdsuite holds the files the server hands out, built into the binary: the IDE (public/) and
// the example project (examples/demo). cmd/nerdsuite serves them; --root serves a checkout instead.
//
// This file (no build tags) embeds the front end as it is in the checkout: the development and plain
// `go build` binary. The release binaries are built with `-tags dist` (tools/dist.mjs): then embed_dist.go
// embeds build/webui instead, where the front end is bundled and obfuscated. Keep both in step.
//go:build !dist

package nerdsuite

import "embed"

//go:embed all:public
var Public embed.FS

//go:embed all:examples
var Examples embed.FS
