#!/usr/bin/env node
// kickass-docs.mjs - writes public/js/kickass/docs.js: the directives, the preprocessor directives
// and the library (functions and constants) of the installed KickAssembler, as -asminfo gives them,
// for the completion of the code editor without a server. Run it again for a new KickAssembler.
//
// usage: node tools/kickass-docs.mjs [http://localhost:3064]   - asks a running server (npm start)
import { writeFileSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:3064';
const res = await fetch(`${base}/api/kickass/info`).catch(e => { console.error(`the server at ${base} does not answer (npm start): ${e.message}`); process.exit(1); });
const info = await res.json();
if (!res.ok) { console.error(`/api/kickass/info: ${info.error ?? res.status}`); process.exit(1); }
// one entry per name: the overloads of a function as one, with the argument counts
const lib = new Map();
for (const l of info.libraries) {
  const key = `${l.kind}:${l.name}`;
  if (!lib.has(key)) lib.set(key, { lib: l.lib, kind: l.kind, name: l.name, args: [] });
  if (l.args != null && !lib.get(key).args.includes(l.args)) lib.get(key).args.push(l.args);
}
const out = `// kickass/docs.js - made by tools/kickass-docs.mjs from KickAssembler ${info.version} (-asminfo): its
// directives, preprocessor directives and library, for the completion of the code editor
export const VERSION = ${JSON.stringify(info.version)};
export const DIRECTIVES = ${JSON.stringify(info.directives, null, 0)};
export const PPDIRECTIVES = ${JSON.stringify(info.ppdirectives, null, 0)};
export const LIBRARY = ${JSON.stringify([...lib.values()], null, 0)};
`;
writeFileSync(new URL('../public/js/kickass/docs.js', import.meta.url), out);
console.log(`KickAssembler ${info.version}: ${info.directives.length} directives, ${info.ppdirectives.length} preprocessor directives, ${lib.size} library entries`);
