# vendor

Libraries of the editor's UI, as the ES modules their packages publish - the editor has no
build step and no packages, the browser loads these files. The bare imports inside them
(`"preact"`, `"preact/hooks"`, `"@preact/signals-core"`) are rewritten to the files here.

| file | package | license |
|---|---|---|
| `preact.js`, `preact-hooks.js` | preact 10.27.2 | MIT (`LICENSE-preact`) |
| `htm.js` | htm 3.1.1 | Apache-2.0 (`LICENSE-htm`) |
| `signals-core.js`, `signals.js` | @preact/signals-core 1.12.1, @preact/signals 2.3.2 | MIT (the license of preact) |

Update: fetch the same paths from `https://unpkg.com/<package>@<version>/`, then rewrite the
imports again (see `git log` of this folder for the commands).
