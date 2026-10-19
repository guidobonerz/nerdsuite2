#!/usr/bin/env node
// dist.mjs - the binaries of nerdsuite: the Go server with the IDE built in (cmd/nerdsuite, embed.go),
// one file per system, into build/dist/ - the version in the name (v1.0: nerdsuite-v1.0-...):
//
//   nerdsuite-VERSION-windows-amd64.exe   Windows
//   nerdsuite-VERSION-linux-amd64         Linux on a PC
//   nerdsuite-VERSION-linux-arm64         Linux on ARM (Raspberry Pi 4/5)
//   nerdsuite-VERSION-macos               macOS, Apple silicon and Intel in one file (lipo, codesign ad hoc:
//                                         only on a Mac, CI dist-macos); elsewhere nerdsuite-VERSION-macos-arm64
//                                         and nerdsuite-VERSION-macos-amd64
//
// Before the binaries the front end is staged into build/webui: app.js and sidworklet.js bundled
// (esbuild) and obfuscated (tools/obfuscator.json), the rest of public/ and examples/demo copied as they
// are. The Go binaries are then built with -tags dist, which embeds build/webui (embed_dist.go) instead
// of the checkout (embed.go). esbuild and the obfuscator are installed once into a folder of their own in
// the temporary folder (npm). --plain stages the front end as it is instead, without npm (a build for
// trying it out); the binary is still -tags dist, just with the plain front end.
//
// Without cgo (a server of the net package only): every system is built from any other. The files of
// Windows and Linux can be packed with UPX (--upx): they stay files to run, unpacking themselves into
// memory at every start. Not the macOS one: UPX 4 does not pack macOS.
//
// usage: node tools/dist.mjs [--version v1.0] [--only windows-amd64,linux-amd64] [--upx | --no-upx] [--plain]
//   --version  shown in the IDE (About) and in the file names (default: git describe)
//   --upx      pack with UPX, which must be there (CI); without either option: packed when upx is found
//   --plain    the front end as it is, not obfuscated (no npm; a build for trying it out)
//   UPX_BIN=   the upx to use (default: upx on the PATH)

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'build', 'dist');
const WEBUI = join(ROOT, 'build', 'webui');
const PLAIN = process.argv.includes('--plain');
const TOOLS = { esbuild: '0.24.0', 'javascript-obfuscator': '5.8.0' };
const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const TARGETS = [['windows', 'amd64'], ['linux', 'amd64'], ['linux', 'arm64'], ['darwin', 'arm64'], ['darwin', 'amd64']];
const only = arg('--only')?.split(',');

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) { console.error(`${cmd} ${args.join(' ')}: failed`); process.exit(1); }
};
const git = spawnSync('git', ['describe', '--tags', '--always'], { cwd: ROOT, encoding: 'utf8' });
const version = arg('--version') || (git.status === 0 ? git.stdout.trim() : 'dev');

// --- the front end into build/webui -------------------------------------------------------------
// app.js and sidworklet.js bundled and obfuscated (or copied as they are with --plain), the rest of
// public/ and examples/demo copied. -tags dist embeds this (embed_dist.go).
async function stageWebui() {
  rmSync(WEBUI, { recursive: true, force: true });
  mkdirSync(join(WEBUI, 'public', 'js'), { recursive: true });
  const copy = (from, to) => cpSync(join(ROOT, from), join(WEBUI, to), { recursive: true });

  // the page and what it loads besides the front end, and the example project
  copy('public/index.html', 'public/index.html');
  for (const dir of ['css', 'fonts', 'images', 'vendor', 'handbook']) copy(`public/${dir}`, `public/${dir}`);
  copy('examples/demo', 'examples/demo');

  if (PLAIN) {
    copy('public/js', 'public/js');
    return;
  }

  // esbuild and the obfuscator, once, in a folder of their own in the temporary folder
  const dir = join(tmpdir(), `nerdsuite-webui-${Object.values(TOOLS).join('-')}`);
  if (!existsSync(join(dir, 'node_modules', 'javascript-obfuscator'))) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"private":true}');
    const r = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', ...Object.entries(TOOLS).map(([n, v]) => `${n}@${v}`)],
      { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status !== 0) { console.error('npm install failed: no network? node tools/dist.mjs --plain builds without'); process.exit(1); }
  }
  const require = createRequire(join(dir, 'package.json'));
  const esbuild = await import(pathToFileURL(require.resolve('esbuild')).href);
  const obfuscator = require('javascript-obfuscator');
  const options = JSON.parse(readFileSync(join(ROOT, 'tools', 'obfuscator.json'), 'utf8'));
  // app.js and everything it imports (the lazily loaded views too); '../vendor/*' stays an import of
  // the vendored files next to it, and './sidworklet.js' stays the sibling the AudioWorklet loads by
  // URL - it is its own bundle (the SID player and chip).
  for (const [entry, external] of [['app.js', ['../vendor/*', './sidworklet.js']], ['sidworklet.js', []]]) {
    const r = await esbuild.build({
      entryPoints: [join(ROOT, 'public', 'js', entry)], bundle: true, format: 'esm', minify: true,
      target: 'es2022', legalComments: 'none', external, write: false,
    });
    const code = obfuscator.obfuscate(r.outputFiles[0].text, options).getObfuscatedCode();
    writeFileSync(join(WEBUI, 'public', 'js', entry), code);
  }
  if (readdirSync(join(WEBUI, 'public', 'js')).length !== 2) throw new Error('the front end must be two files');
}

await stageWebui();

// --- the binaries -------------------------------------------------------------------------------
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
// the version in the file names: only letters, digits, '.', '_' and '-'
const tag = version.replace(/[^\w.-]/g, '_');
const name = (os, arch) => `nerdsuite-${tag}-${os === 'darwin' ? 'macos' : os}-${arch}${os === 'windows' ? '.exe' : ''}`;
const built = [];
for (const [os, arch] of TARGETS) {
  if (only && !only.includes(`${os}-${arch}`) && !only.includes(`${os === 'darwin' ? 'macos' : os}-${arch}`)) continue;
  const file = join(OUT, name(os, arch));
  // Windows: a program with windows (-H windowsgui) - a double click opens no console window
  const gui = os === 'windows' ? ' -H windowsgui' : '';
  run('go', ['build', '-tags', 'dist', '-trimpath', '-ldflags', `-s -w${gui} -X main.version=${version}`, '-o', file, './cmd/nerdsuite'],
    { cwd: ROOT, env: { ...process.env, GOOS: os, GOARCH: arch, CGO_ENABLED: '0' } });
  built.push({ os, arch, file });
}

// UPX: Windows and Linux (UPX 4 does not pack macOS)
const upx = process.env.UPX_BIN || 'upx';
const hasUpx = spawnSync(upx, ['--version'], { stdio: 'ignore' }).status === 0;
if (process.argv.includes('--upx') && !hasUpx) { console.error(`--upx: ${upx} was not found`); process.exit(1); }
if (hasUpx && !process.argv.includes('--no-upx')) {
  for (const b of built) if (b.os !== 'darwin') run(upx, ['--best', '-q', b.file]);
}

// macOS on a Mac: one file for Apple silicon and Intel, signed ad hoc (Apple silicon starts no program
// without a signature)
const macs = built.filter(b => b.os === 'darwin');
if (macs.length === 2 && process.platform === 'darwin') {
  const mac = join(OUT, `nerdsuite-${tag}-macos`);
  run('lipo', ['-create', '-output', mac, ...macs.map(b => b.file)]);
  run('codesign', ['-s', '-', '-f', mac]);
  for (const b of macs) rmSync(b.file);
  built.splice(0, built.length, ...built.filter(b => b.os !== 'darwin'), { os: 'darwin', arch: 'universal', file: mac });
}

for (const b of built) console.log(`${b.file.slice(ROOT.length + 1)}  ${(statSync(b.file).size / 1048576).toFixed(1)} MB${PLAIN ? ' (front end as it is)' : ''}`);
