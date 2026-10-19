// The release build (-tags dist, tools/dist.mjs): the front end is not embedded from the checkout but
// from build/webui, where dist.mjs has staged it with app.js and sidworklet.js bundled (esbuild) and
// obfuscated (tools/obfuscator.json), and the rest of public/ and examples/demo copied as they are.
//
// fs.Sub strips the build/webui prefix so Public and Examples look exactly like the ones in embed.go:
// cmd/nerdsuite does fs.Sub(Public, "public") and fs.Sub(Examples, "examples/demo") either way.
//go:build dist

package nerdsuite

import (
	"embed"
	"io/fs"
)

//go:embed all:build/webui/public
var rawPublic embed.FS

//go:embed all:build/webui/examples
var rawExamples embed.FS

// Public holds public/..., Examples holds examples/demo/... - the same layout embed.go gives.
var Public, Examples fs.FS

func init() {
	var err error
	if Public, err = fs.Sub(rawPublic, "build/webui"); err != nil {
		panic(err)
	}
	if Examples, err = fs.Sub(rawExamples, "build/webui"); err != nil {
		panic(err)
	}
}
