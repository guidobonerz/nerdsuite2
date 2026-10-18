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
// Without cgo (a server of the net package only): every system is built from any other. The files of
// Windows and Linux can be packed with UPX (--upx): they stay files to run, unpacking themselves into
// memory at every start. Not the macOS one: UPX 4 does not pack macOS.
//
// usage: node tools/dist.mjs [--version v1.0] [--only windows-amd64,linux-amd64] [--upx | --no-upx]
//   --version  shown in the IDE (About) and in the file names (default: git describe)
//   --upx      pack with UPX, which must be there (CI); without either option: packed when upx is found
//   UPX_BIN=   the upx to use (default: upx on the PATH)

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'build', 'dist');
const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const TARGETS = [['windows', 'amd64'], ['linux', 'amd64'], ['linux', 'arm64'], ['darwin', 'arm64'], ['darwin', 'amd64']];
const only = arg('--only')?.split(',');

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) { console.error(`${cmd} ${args.join(' ')}: failed`); process.exit(1); }
};
const git = spawnSync('git', ['describe', '--tags', '--always'], { cwd: ROOT, encoding: 'utf8' });
const version = arg('--version') || (git.status === 0 ? git.stdout.trim() : 'dev');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
// the version in the file names: only letters, digits, '.', '_' and '-'
const tag = version.replace(/[^\w.-]/g, '_');
const name = (os, arch) => `nerdsuite-${tag}-${os === 'darwin' ? 'macos' : os}-${arch}${os === 'windows' ? '.exe' : ''}`;
const built = [];
for (const [os, arch] of TARGETS) {
  if (only && !only.includes(`${os}-${arch}`) && !only.includes(`${os === 'darwin' ? 'macos' : os}-${arch}`)) continue;
  const file = join(OUT, name(os, arch));
  run('go', ['build', '-trimpath', '-ldflags', `-s -w -X main.version=${version}`, '-o', file, './cmd/nerdsuite'],
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

for (const b of built) console.log(`${b.file.slice(ROOT.length + 1)}  ${(statSync(b.file).size / 1048576).toFixed(1)} MB`);
