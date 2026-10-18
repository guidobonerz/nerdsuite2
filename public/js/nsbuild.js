// nsbuild.js - the project settings of nerdsuite and the build of a program in the browser:
// an assembler source with the ACME compatible assembler (acme/acme.js), a BASIC program with the
// tokenizer of its dialect (basic/basic.js). No server is involved.
//
// The settings are the file nerdsuite.json of the project:
//   { "machine": "c64", "main": "src/main.asm", "dialects": { "src/hello.bas": "v2" }, "cpu": "6502" }
// main: the program that Build, Run and Debug make; without one the source in the editor.

import { assemble, disassemble } from './acme/acme.js';
import { tokenize } from './basic/basic.js';
import { resolveLabels } from './basic/labels.js';
import { preprocess } from './basic/preprocess.js';
import { DIALECTS } from './basic/dialects.js';
import { allFiles, hasFile, readBinary, readText, writeText, isSource, toBase64, fromBase64 } from './project.js';
import { PLATFORMS, platformOf } from './platforms.js';

export const SETTINGS = 'nerdsuite.json';
export { disassemble };

// the machines: platforms.js (the settings call the platform 'machine')
export const MACHINES = PLATFORMS;
export const machineOf = platformOf;

// assembler: the assembler of the assembler sources, 'acme' or 'kickass'; assemblers: the one of a file of its own
const DEFAULTS = { machine: 'c64', main: null, dialects: {}, labelModes: {}, cpu: null, assembler: 'acme', assemblers: {} };
export const ASSEMBLERS = [{ id: 'acme', name: 'ACME' }, { id: 'kickass', name: 'KickAssembler' }];

export function readSettings() {
  try {
    return { ...DEFAULTS, ...(hasFile(SETTINGS) ? JSON.parse(readText(SETTINGS)) : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}
export function writeSettings(change) {
  const s = { ...readSettings(), ...change };
  writeText(SETTINGS, JSON.stringify(s, null, 2) + '\n');
  return s;
}

export const isAsm = p => /\.(asm|a|s|inc)$/i.test(p);
export const isBasic = p => /\.bas$/i.test(p);

// whether a BASIC file is in the label mode: labels instead of line numbers (labelModes: { path: true })
export const labelModeOf = (path, settings = readSettings()) => !!settings.labelModes?.[path];

// the dialect of a BASIC file: its own, else the first of the machine
export function dialectOf(path, settings = readSettings()) {
  const d = settings.dialects?.[path];
  return d && DIALECTS[d] ? d : platformOf(settings.machine).basic[0] ?? 'v2';
}

// the assembler of a source: its own, else the project's (KickAssembler only for the 6502 family)
export function assemblerOf(path, settings = readSettings()) {
  const a = settings.assemblers?.[path] ?? settings.assembler ?? 'acme';
  return a === 'kickass' ? 'kickass' : 'acme';
}

// the files the assembler can read: the sources as text, the rest as bytes. over: Map path -> text
// of the editors that is not saved yet
export function assemblerFiles(over = new Map()) {
  const files = new Map();
  for (const p of allFiles()) {
    if (p.startsWith('reference/')) continue;
    files.set(p, isSource(p) ? readText(p) : readBinary(p));
  }
  for (const [p, t] of over) files.set(p, t);
  return files;
}

const baseName = p => p.split('/').pop().replace(/\.[^.]*$/, '');
const BASIC_EXT = { 'atascii-lst': 'lst', 'cpc-ascii': 'bas', 'zx81-p': 'p', 'trs80-ascii': 'bas', 'bbc-ascii': 'bas' };

// build a program: { ok, kind: 'asm' | 'basic', main, name, file: { name, bytes, format }, prg (a cbm
//   .prg: a program VICE loads), start, exec, errors: [{ file, line, col, msg, severity }], symbols,
//   lines, viceLabels, listing, basicLines }
export function buildProgram(main, { over = new Map(), settings = readSettings() } = {}) {
  if (!main) return { ok: false, main, errors: [{ file: null, line: null, msg: 'no program to build: open a source or set the main program' }] };
  const text = over.get(main) ?? (hasFile(main) ? readText(main) : null);
  if (text == null) return { ok: false, main, errors: [{ file: main, line: null, msg: `${main} is not in the project` }] };
  const name = baseName(main);
  const platform = platformOf(settings.machine);
  if (isBasic(main)) {
    const dialect = dialectOf(main, settings);
    // the label mode: the lines get their numbers first (basic/labels.js), the line count stays
    // the directives first (basic/preprocess.js): #define, @if / @else / @end, DATA @embed - every line
    // remembers the line of the source it came from
    const labelMode = labelModeOf(main, settings);
    const pp = preprocess(text, { defines: settings.defines ?? '', labelMode, readFile: p => (hasFile(p) ? readBinary(p) : null) });
    const flat = pp.lines.map(l => l.text).join('\n'), srcLines = pp.lines.map(l => l.src);
    const labeled = labelMode ? resolveLabels(flat) : null;
    const fromFlat = e => ({ ...e, line: e.line != null ? srcLines[e.line - 1] ?? e.line : null });
    let r;
    try {
      r = tokenize(labeled ? labeled.text : flat, { dialect, machine: settings.machine === 'vic20' ? 'vic20' : undefined, srcLines });
      const before = [...pp.errors, ...(labeled?.errors ?? []).map(fromFlat)];
      if (before.length) r = { ...r, ok: false, errors: [...before, ...(r.errors ?? [])] };
    } catch (e) {
      r = { ok: false, errors: [{ line: e.line ?? null, msg: e.message }] };
    }
    const errors = (r.errors ?? []).map(e => ({ file: main, line: e.line ?? null, col: e.col ?? null, msg: e.msg ?? e.message, severity: 'error' }));
    // a Commodore dialect gives a tokenized .prg; Atari BASIC and Locomotive BASIC a listing to ENTER / LOAD
    const bytes = r.prg ?? r.listing ?? null;
    const format = r.prg ? 'cbm' : r.format ?? 'text';
    const file = bytes && { name: `${name}.${r.prg ? 'prg' : BASIC_EXT[format] ?? 'txt'}`, bytes, format };
    return { ok: !!r.ok && !errors.length && !!bytes, kind: 'basic', main, name, dialect, platform: platform.id, file, prg: r.prg ?? null, start: r.start, errors, basicLines: r.lines ?? [], symbols: [], lines: [] };
  }
  if (assemblerOf(main, settings) === 'kickass') return kickassBuild(main, name, platform, over);
  const cpu = settings.cpu || platform.cpu;
  // without !to the output of the platform (a .xex, a CPC binary ...); !to decides for itself
  const hasTo = /^\s*!to\b/m.test(text);
  let r;
  try {
    r = assemble(main, assemblerFiles(over), { cpu, ...(hasTo ? {} : { format: platform.format }) });
  } catch (e) {
    r = { ok: false, errors: [{ file: main, line: null, msg: `assembler failed: ${e.message}` }] };
  }
  const errors = [
    ...(r.errors ?? []).map(e => ({ ...e, severity: 'error' })),
    ...(r.warnings ?? []).map(e => ({ ...e, severity: 'warning' })),
  ];
  const out = r.output ?? null;
  const format = r.format ?? 'cbm';
  const outName = r.outputName ? r.outputName.split('/').pop() : `${name}.${format === 'cbm' ? 'prg' : platform.ext}`;
  // the program as VICE loads it: a cbm file has its load address, a plain one gets it
  let prg = null;
  if (out && format === 'cbm') prg = out;
  else if (out && format === 'plain' && platform.emulator.kind === 'vice') {
    prg = new Uint8Array(out.length + 2);
    prg[0] = r.start & 0xff; prg[1] = r.start >> 8;
    prg.set(out, 2);
  }
  return {
    ok: !!r.ok && !!out, kind: 'asm', main, name: baseName(outName), platform: platform.id, file: out && { name: outName, bytes: out, format },
    prg, start: r.start, end: r.end, exec: r.exec ?? r.start, errors,
    symbols: r.symbols ?? [], lines: r.lines ?? [], viceLabels: r.viceLabels ?? '', listing: r.listing ?? '',
  };
}

// --- KickAssembler: on the server (backend/kickass), a Java program -----------------------------------

// whether the server has KickAssembler and Java: { available, version } (asked once)
let kickStatus = null;
export async function kickassStatus() {
  kickStatus ??= fetch('api/kickass/status').then(r => r.json()).catch(() => ({ available: false }));
  return kickStatus;
}

async function kickassBuild(main, name, platform, over) {
  const fail = msg => ({ ok: false, kind: 'asm', main, name, errors: [{ file: main, line: null, msg, severity: 'error' }], symbols: [], lines: [] });
  if (platform.cpu === 'z80') return fail(`KickAssembler makes 6502 code: the ${platform.name} needs ACME (!cpu z80)`);
  if (platform.family !== 'commodore') return fail(`KickAssembler writes .prg files for the Commodore machines: the ${platform.name} needs ACME (its ${platform.format} output)`);
  const enc = new TextEncoder();
  const files = {};
  for (const p of allFiles()) if (!p.startsWith('reference/')) files[p] = toBase64(over.has(p) ? enc.encode(over.get(p)) : readBinary(p));
  for (const [p, t] of over) files[p] ??= toBase64(enc.encode(t));
  let r;
  try {
    const res = await fetch('api/kickass/assemble', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ main, files }) });
    r = await res.json();
    if (!res.ok) return fail(r.error ?? `${res.status} ${res.statusText}`);
  } catch (e) {
    return fail(`the server does not answer: ${e.message}`);
  }
  const out = r.output ? fromBase64(r.output) : null;
  return {
    ok: !!r.ok && !!out, kind: 'asm', assembler: 'kickass', main, name: baseName(r.outputName ?? name), platform: platform.id,
    file: out && { name: r.outputName ?? `${name}.prg`, bytes: out, format: 'cbm' }, prg: out,
    start: r.start, end: r.end, exec: r.start, errors: r.errors ?? [],
    symbols: r.symbols ?? [], lines: r.lines ?? [], viceLabels: r.viceLabels ?? '', listing: r.listing ?? '', memory: r.memory ?? '',
  };
}

// --- the debug info of a build: addresses <-> source lines --------------------------------------

export function debugInfo(build) {
  const byAddr = new Map(), byLine = new Map(), labels = new Map(), names = new Map();
  for (const l of build?.lines ?? []) {
    if (l.macro) continue;
    if (!byAddr.has(l.addr)) byAddr.set(l.addr, { file: l.file, line: l.line, size: l.size });
    const key = `${l.file}:${l.line}`;
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key).push(l.addr);
  }
  for (const s of build?.symbols ?? []) {
    if (s.kind === 'set') continue;
    if (!labels.has(s.value)) labels.set(s.value, s.name);
    names.set(s.name.toLowerCase(), s.value);
  }
  return {
    // the source line of an address: exact, else the statement it lies in
    lineOf(addr) {
      if (byAddr.has(addr)) return byAddr.get(addr);
      for (let a = addr - 1; a >= addr - 3; a--) { const x = byAddr.get(a); if (x && a + (x.size ?? 1) > addr) return x; }
      return null;
    },
    addrsOf: (file, line) => byLine.get(`${file}:${line}`) ?? [],
    label: addr => labels.get(addr) ?? null,
    valueOf: name => names.get(String(name).toLowerCase()),
    labels,
  };
}

// an address typed by the user: $c000, 0xc000, 49152, %..., or a label of the build
export function parseAddress(text, info) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  let m;
  if ((m = /^\$([0-9a-f]+)$/i.exec(t)) || (m = /^0x([0-9a-f]+)$/i.exec(t))) return parseInt(m[1], 16) & 0xffff;
  if (/^\d+$/.test(t)) return Number(t) & 0xffff;
  if ((m = /^%([01]+)$/.exec(t))) return parseInt(m[1], 2) & 0xffff;
  if ((m = /^(.+?)\s*([+-])\s*(\$?[0-9a-f]+)$/i.exec(t))) {
    const base = parseAddress(m[1], info), off = parseAddress(m[3].startsWith('$') ? m[3] : m[3], info);
    if (base != null && off != null) return (m[2] === '+' ? base + off : base - off) & 0xffff;
  }
  const v = info?.valueOf(t);
  return v == null ? null : v & 0xffff;
}

export const hex2 = n => n.toString(16).padStart(2, '0');
export const hex4 = n => n.toString(16).padStart(4, '0');
