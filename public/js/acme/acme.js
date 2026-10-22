/*
 * ACME-compatible 6502 cross assembler for nerdsuite.
 *
 * Plain ES module without dependencies; runs unchanged in browsers and Node.
 * Compatibility target: ACME 0.97 (6502 family subset, see docs.js / README of the IDE).
 *
 *   assemble(main, files, opts) -> result object (never throws for source errors)
 *   disassemble(bytes, addr, cpu) -> [{ addr, bytes, text }]
 */

import { codeP } from '../zx81.js';
import { M68K_TABLE, m68kInstruction, disassembleM68k } from './m68k.js';

const MAX_PASSES = 24;
const MAX_DEPTH = 64;
const MAX_ERRORS = 100;
const LOOP_LIMIT = 100000;

// ------------------------------------------------------------------ CPU tables

/** Byte length of each addressing mode (opcode included). */
export const MODE_LEN = {
  imp: 1, imm: 2, zp: 2, zpx: 2, zpy: 2, abs: 3, absx: 3, absy: 3,
  ind: 3, indx: 2, indy: 2, izp: 2, iax: 3, rel: 2, zprel: 3,
  sr: 2, sry: 2, ildp: 2, ildpy: 2, long: 4, longx: 4, ialong: 3, rell: 3, blk: 3,
  izpz: 2, imm16: 3, rel16: 3, izl: 2, izlq: 2,
};

/** Human readable operand syntax per addressing mode. */
export const MODE_SYNTAX = {
  imp: '', imm: '#imm', zp: 'zp', zpx: 'zp,x', zpy: 'zp,y', abs: 'abs', absx: 'abs,x', absy: 'abs,y',
  ind: '(abs)', indx: '(zp,x)', indy: '(zp),y', izp: '(zp)', iax: '(abs,x)', rel: 'rel', zprel: 'zp,rel',
  sr: 'sr,s', sry: '(sr,s),y', ildp: '[dp]', ildpy: '[dp],y', long: 'long', longx: 'long,x', ialong: '[abs]', rell: 'rel16', blk: 'src,dst',
  izpz: '(zp),z', imm16: '#imm16', rel16: 'rel16', izl: '[zp],z', izlq: '[zp]',
};

// the opcode of a mode with its prefixes (the 45GS02: $42 $42 quad, $ea long): one number, the
// prefixes in its high bytes - 0x4242eab2 is $42 $42 $ea $b2
export const opBytes = op => {
  const out = [];
  for (; op > 0xff; op = Math.floor(op / 256)) out.unshift(op % 256);
  return [op, ...out];
};

function parseTable(src) {
  const t = {};
  for (const line of src.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (!parts[0]) continue;
    const modes = {};
    for (const p of parts.slice(1)) {
      const [m, h] = p.split('=');
      modes[m] = parseInt(h, 16);
    }
    t[parts[0]] = modes;
  }
  return t;
}

const BASE = parseTable(`
adc imm=69 zp=65 zpx=75 abs=6d absx=7d absy=79 indx=61 indy=71
and imm=29 zp=25 zpx=35 abs=2d absx=3d absy=39 indx=21 indy=31
asl imp=0a zp=06 zpx=16 abs=0e absx=1e
bcc rel=90
bcs rel=b0
beq rel=f0
bit zp=24 abs=2c
bmi rel=30
bne rel=d0
bpl rel=10
brk imp=00
bvc rel=50
bvs rel=70
clc imp=18
cld imp=d8
cli imp=58
clv imp=b8
cmp imm=c9 zp=c5 zpx=d5 abs=cd absx=dd absy=d9 indx=c1 indy=d1
cpx imm=e0 zp=e4 abs=ec
cpy imm=c0 zp=c4 abs=cc
dec zp=c6 zpx=d6 abs=ce absx=de
dex imp=ca
dey imp=88
eor imm=49 zp=45 zpx=55 abs=4d absx=5d absy=59 indx=41 indy=51
inc zp=e6 zpx=f6 abs=ee absx=fe
inx imp=e8
iny imp=c8
jmp abs=4c ind=6c
jsr abs=20
lda imm=a9 zp=a5 zpx=b5 abs=ad absx=bd absy=b9 indx=a1 indy=b1
ldx imm=a2 zp=a6 zpy=b6 abs=ae absy=be
ldy imm=a0 zp=a4 zpx=b4 abs=ac absx=bc
lsr imp=4a zp=46 zpx=56 abs=4e absx=5e
nop imp=ea
ora imm=09 zp=05 zpx=15 abs=0d absx=1d absy=19 indx=01 indy=11
pha imp=48
php imp=08
pla imp=68
plp imp=28
rol imp=2a zp=26 zpx=36 abs=2e absx=3e
ror imp=6a zp=66 zpx=76 abs=6e absx=7e
rti imp=40
rts imp=60
sbc imm=e9 zp=e5 zpx=f5 abs=ed absx=fd absy=f9 indx=e1 indy=f1
sec imp=38
sed imp=f8
sei imp=78
sta zp=85 zpx=95 abs=8d absx=9d absy=99 indx=81 indy=91
stx zp=86 zpy=96 abs=8e
sty zp=84 zpx=94 abs=8c
tax imp=aa
tay imp=a8
tsx imp=ba
txa imp=8a
txs imp=9a
tya imp=98
`);

// undocumented NMOS 6502 / 6510 opcodes, ACME mnemonics
const NMOS = parseTable(`
slo zp=07 zpx=17 abs=0f absx=1f absy=1b indx=03 indy=13
rla zp=27 zpx=37 abs=2f absx=3f absy=3b indx=23 indy=33
sre zp=47 zpx=57 abs=4f absx=5f absy=5b indx=43 indy=53
rra zp=67 zpx=77 abs=6f absx=7f absy=7b indx=63 indy=73
sax zp=87 zpy=97 abs=8f indx=83
lax imm=ab zp=a7 zpy=b7 abs=af absy=bf indx=a3 indy=b3
dcp zp=c7 zpx=d7 abs=cf absx=df absy=db indx=c3 indy=d3
isc zp=e7 zpx=f7 abs=ef absx=ff absy=fb indx=e3 indy=f3
anc imm=0b
asr imm=4b
arr imm=6b
sbx imm=cb
ane imm=8b
lxa imm=ab
sha absy=9f indy=93
shx absy=9e
shy absx=9c
tas absy=9b
las absy=bb
dop imm=80 zp=04 zpx=14
top abs=0c absx=1c
jam imp=02
`);
const NOPX = parseTable('nop imm=80 zp=04 zpx=14 abs=0c absx=1c');

const C02 = parseTable(`
adc izp=72
and izp=32
cmp izp=d2
eor izp=52
lda izp=b2
ora izp=12
sbc izp=f2
sta izp=92
bit imm=89 zpx=34 absx=3c
dec imp=3a
inc imp=1a
jmp iax=7c
bra rel=80
phx imp=da
phy imp=5a
plx imp=fa
ply imp=7a
stz zp=64 zpx=74 abs=9c absx=9e
trb zp=14 abs=1c
tsb zp=04 abs=0c
`);
let r02 = '';
for (let n = 0; n < 8; n++) {
  r02 += `rmb${n} zp=${n}7\nsmb${n} zp=${(n + 8).toString(16)}7\n`;
  r02 += `bbr${n} zprel=${n}f\nbbs${n} zprel=${(n + 8).toString(16)}f\n`;
}
const R02 = parseTable(r02);
const W02 = parseTable('wai imp=cb\nstp imp=db');

// the 65816: the 65C02 without the Rockwell bit opcodes, and its own modes and instructions
const W816 = parseTable(`
ora sr=03 ildp=07 long=0f sry=13 ildpy=17 longx=1f
and sr=23 ildp=27 long=2f sry=33 ildpy=37 longx=3f
eor sr=43 ildp=47 long=4f sry=53 ildpy=57 longx=5f
adc sr=63 ildp=67 long=6f sry=73 ildpy=77 longx=7f
sta sr=83 ildp=87 long=8f sry=93 ildpy=97 longx=9f
lda sr=a3 ildp=a7 long=af sry=b3 ildpy=b7 longx=bf
cmp sr=c3 ildp=c7 long=cf sry=d3 ildpy=d7 longx=df
sbc sr=e3 ildp=e7 long=ef sry=f3 ildpy=f7 longx=ff
cop imm=02
wdm imm=42
jsl long=22
jml long=5c ialong=dc
jmp long=5c ialong=dc
jsr iax=fc
brl rell=82
per rell=62
pea abs=f4
pei izp=d4
mvp blk=44
mvn blk=54
phb imp=8b
phd imp=0b
phk imp=4b
plb imp=ab
pld imp=2b
rep imm=c2
sep imm=e2
rtl imp=6b
tcd imp=5b
tcs imp=1b
tdc imp=7b
tsc imp=3b
txy imp=9b
tyx imp=bb
wai imp=cb
stp imp=db
xba imp=eb
xce imp=fb
`);
// the 65CE02: the R65C02 with a Z register, 16 bit branches (ACME: lbxx, bsr), (zp) is (zp),z
const CE02 = parseTable(`
ora izpz=12
and izpz=32
eor izpz=52
adc izpz=72
sta izpz=92 sry=82
lda izpz=b2 sry=e2
cmp izpz=d2
sbc izpz=f2
cle imp=02
see imp=03
tsy imp=0b
inz imp=1b
tys imp=2b
dez imp=3b
neg imp=42
asr imp=43 zp=44 zpx=54
taz imp=4b
tab imp=5b
tza imp=6b
tba imp=7b
phz imp=db
plz imp=fb
jsr ind=22 iax=23
rtn imm=62
bsr rel16=63
lbpl rel16=13
lbmi rel16=33
lbvc rel16=53
lbvs rel16=73
lbra rel16=83
lbcc rel16=93
lbcs rel16=b3
lbne rel16=d3
lbeq rel16=f3
sty absx=8b
stx absy=9b
ldz imm=a3 abs=ab absx=bb
cpz imm=c2 zp=d4 abs=dc
dew zp=c3
inw zp=e3
asw abs=cb
row abs=eb
phw imm16=f4 abs=fc
`);
const AUG = parseTable('aug imp=5c');
// the 4502 (the C65, the MEGA65): aug is map, nop is eom too
const MAP = parseTable('map imp=5c\neom imp=ea');
// the 45GS02 (the MEGA65, ACME's m65): [zp],z with 32 bit pointers ($ea), the quad instructions on Q
// = A X Y Z ($42 $42), both ($42 $42 $ea)
let m65 = '';
for (const [m, q, op] of [['ora', 'orq', 0x00], ['and', 'andq', 0x20], ['eor', 'eorq', 0x40], ['adc', 'adcq', 0x60], ['sta', 'stq', 0x80], ['lda', 'ldq', 0xa0], ['cmp', 'cpq', 0xc0], ['sbc', 'sbcq', 0xe0]]) {
  const x = n => (op + n).toString(16).padStart(2, '0');
  m65 += `${m} izl=ea${x(0x12)}\n${q} zp=4242${x(5)} abs=4242${x(0x0d)} izp=4242${x(0x12)} izlq=4242ea${x(0x12)}\n`;
}
for (const [q, op] of [['aslq', 0x00], ['rolq', 0x20], ['lsrq', 0x40], ['rorq', 0x60]]) {
  const x = n => (op + n).toString(16).padStart(2, '0');
  m65 += `${q} imp=4242${x(0x0a)} zp=4242${x(6)} zpx=4242${x(0x16)} abs=4242${x(0x0e)} absx=4242${x(0x1e)}\n`;
}
const M65 = parseTable(`${m65}
cmpq zp=4242c5 abs=4242cd izp=4242d2 izlq=4242ead2
inq imp=42421a zp=4242e6 zpx=4242f6 abs=4242ee absx=4242fe
deq imp=42423a zp=4242c6 zpx=4242d6 abs=4242ce absx=4242de
bitq zp=424224 abs=42422c
asrq imp=424243 zp=424244 zpx=424254
`);
// the 65C02 without (zp): the 65CE02 has (zp),z there
const C02_CE = Object.fromEntries(Object.entries(C02).map(([m, modes]) => [m, Object.fromEntries(Object.entries(modes).filter(([mode]) => mode !== 'izp'))])
  .filter(([, modes]) => Object.keys(modes).length));

// the immediates that are 16 bits with !al (the accumulator) or !rl (the index registers)
const IMM_A = new Set(['lda', 'adc', 'and', 'bit', 'cmp', 'eor', 'ora', 'sbc']);
const IMM_X = new Set(['ldx', 'ldy', 'cpx', 'cpy']);

function mergeTables(parts) {
  const out = {};
  for (const t of parts) for (const [m, modes] of Object.entries(t)) out[m] = { ...(out[m] || {}), ...modes };
  return out;
}

const CPU_PARTS = {
  '6502': [BASE],
  nmos6502: [BASE, NMOS, NOPX],
  '65c02': [BASE, C02],
  r65c02: [BASE, C02, R02],
  w65c02: [BASE, C02, R02, W02],
  '65816': [BASE, C02, W816],
  '65ce02': [BASE, C02_CE, R02, CE02, AUG],
  '4502': [BASE, C02_CE, R02, CE02, MAP],
  m65: [BASE, C02_CE, R02, CE02, MAP, M65],
};

/** Opcode tables per (canonical) CPU name: { mnemonic: { mode: opcode } }. */
export const CPU_TABLES = {};
const REVERSE = {};
// the opcodes with prefixes (the 45GS02): opcode number -> { m, mode }
const PREFIXED = {};
for (const [cpu, parts] of Object.entries(CPU_PARTS)) {
  CPU_TABLES[cpu] = mergeTables(parts);
  const rev = new Array(256).fill(null), pre = new Map();
  for (const t of parts) {
    for (const [m, modes] of Object.entries(t)) {
      for (const [mode, op] of Object.entries(modes)) {
        if (op > 0xff) { if (!pre.has(op)) pre.set(op, { m, mode }); } else if (!rev[op]) rev[op] = { m, mode };
      }
    }
  }
  REVERSE[cpu] = rev;
  PREFIXED[cpu] = pre;
}

/** Accepted !cpu names -> canonical table name. */
export const CPU_ALIASES = {
  '6502': '6502', nmos6502: 'nmos6502', '6510': 'nmos6502',
  '65c02': '65c02', r65c02: 'r65c02', w65c02: 'w65c02', '65816': '65816',
  '65ce02': '65ce02', '4502': '4502', m65: 'm65',
};
CPU_ALIASES.z80 = 'z80';
CPU_ALIASES['68000'] = CPU_ALIASES.m68k = CPU_ALIASES.mc68000 = 'm68k';
const UNSUPPORTED_CPUS = new Set(['c64dtv2']);
/** Output formats accepted by !to and opts.format (zx81: a .p file, trs80: a /CMD file, adf: an Amiga disk, the code in its boot block). */
export const OUTPUT_FORMATS = ['cbm', 'plain', 'apple', 'xex', 'amsdos', 'zx81', 'trs80', 'adf'];
const ALL_MNEMONICS = new Set();
for (const t of Object.values(CPU_TABLES)) for (const m of Object.keys(t)) ALL_MNEMONICS.add(m);

// ------------------------------------------------------------------ helpers

class AsmError extends Error {
  constructor(msg, loc) { super(msg); this.msg = msg; this.loc = loc; }
}
class StopPass extends Error {}
class EofSignal extends Error {}

const V = (v, f = false) => ({ t: 'n', v, f, u: false, e: false, a: 0, force: 0 });
const UNDEF = () => ({ t: 'n', v: 0, f: false, u: true, e: true, a: 0, force: 0 });
const STR = s => ({ t: 's', s });
const LIST = l => ({ t: 'l', l });
const BOOL = b => V(b ? 1 : 0);

function isIdStart(c) {
  if (!c) return false;
  const k = c.charCodeAt(0);
  return (k >= 65 && k <= 90) || (k >= 97 && k <= 122) || k === 95 || k >= 128;
}
function isIdChar(c) {
  if (!c) return false;
  const k = c.charCodeAt(0);
  return (k >= 65 && k <= 90) || (k >= 97 && k <= 122) || (k >= 48 && k <= 57) || k === 95 || k >= 128;
}
const isHex = c => /^[0-9a-fA-F]$/.test(c);
const hex2 = n => (n & 0xff).toString(16).padStart(2, '0');
const hex4 = n => (n >>> 0).toString(16).padStart(4, '0');

function bitop(a, b, op) {
  a = Math.trunc(a); b = Math.trunc(b);
  if (a >= -2147483648 && a <= 2147483647 && b >= -2147483648 && b <= 2147483647) {
    return op === '&' ? a & b : op === '|' ? a | b : a ^ b;
  }
  const A = BigInt(a), B = BigInt(b);
  return Number(op === '&' ? A & B : op === '|' ? A | B : A ^ B);
}

function valEqual(a, b) {
  if (!a || !b || a.t !== b.t) return false;
  if (a.t === 'n') return a.v === b.v && !!a.f === !!b.f && !!a.u === !!b.u;
  if (a.t === 's') return a.s === b.s;
  return a.l.length === b.l.length && a.l.every((x, i) => valEqual(x, b.l[i]));
}

function normPath(p) {
  const out = [];
  for (const part of String(p).replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { out.pop(); continue; }
    out.push(part);
  }
  return out.join('/');
}
const dirOf = p => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };

function bytesToText(u8) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(u8);
  } catch {
    let s = '';
    for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
    return s;
  }
}
function toBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  const s = String(v);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff;
  return u;
}

// character conversions (identical to ACME's)
export const convPet = c => (c >= 65 && c <= 90 ? c | 0x80 : c >= 97 && c <= 122 ? c - 32 : c);
export const convScr = c => (c >= 97 && c <= 122 ? c - 0x60 : c >= 91 && c <= 95 ? c - 0x40 : c === 96 ? 64 : c === 64 ? 0 : c);

const FUNCS = new Set(['sin', 'cos', 'tan', 'arcsin', 'arccos', 'arctan', 'int', 'float', 'addr', 'address',
  'is_number', 'is_list', 'is_string', 'len']);

const KEYWORD_OPS = {
  div: { id: 'DIV', prec: 9 }, mod: { id: '%', prec: 9 },
  asl: { id: '<<', prec: 7 }, lsl: { id: '<<', prec: 7 }, asr: { id: '>>', prec: 7 }, lsr: { id: '>>>', prec: 7 },
  and: { id: '&', prec: 3 }, xor: { id: 'XOR', prec: 2 }, eor: { id: 'XOR', prec: 2 }, or: { id: '|', prec: 1 },
};

const ILLEGAL_MODE = 'Illegal combination of command and addressing mode.';

// ------------------------------------------------------------------ source reader

class Reader {
  constructor(src, start, end, line, lineStart) {
    this.src = src; this.t = src.text; this.pos = start; this.end = end; this.line = line; this.lineStart = lineStart;
  }
  peek(o = 0) { const p = this.pos + o; return p < this.end ? this.t[p] : ''; }
  adv() {
    const c = this.t[this.pos++];
    if (c === '\n') { this.line++; this.lineStart = this.pos; }
    return c;
  }
  col() { return this.pos - this.lineStart + 1; }
  ws() {
    while (this.pos < this.end) {
      const c = this.t[this.pos];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === ' ') this.pos++;
      else break;
    }
  }
  eos() { this.ws(); const c = this.peek(); return c === '' || c === '\n' || c === ';' || c === ':'; }
  toEol() { while (this.pos < this.end && this.t[this.pos] !== '\n') this.pos++; }
  save() { return [this.pos, this.line, this.lineStart]; }
  restore(s) { [this.pos, this.line, this.lineStart] = s; }
  keyword(w) {
    const n = w.length;
    return this.t.substr(this.pos, n).toLowerCase() === w && this.pos + n <= this.end && !isIdChar(this.peek(n));
  }
}

// ------------------------------------------------------------------ assembler

class Asm {
  constructor(files, opts) {
    this.files = new Map();
    const entries = files instanceof Map ? files.entries() : Object.entries(files || {});
    for (const [k, v] of entries) this.files.set(normPath(k), v);
    this.lowerIndex = new Map();
    for (const k of this.files.keys()) if (!this.lowerIndex.has(k.toLowerCase())) this.lowerIndex.set(k.toLowerCase(), k);
    this.opts = opts || {};
    this.symbols = new Map();
    this.macros = new Map();
    this.texts = new Map();
    this.aliasKeys = new Set();
    this.r = null;
  }

  // ---------------------------------------------------------------- files
  findFile(p) {
    p = normPath(p);
    if (this.files.has(p)) return p;
    return this.lowerIndex.get(p.toLowerCase()) ?? null;
  }
  resolve(fromFile, name, lib) {
    if (lib) return this.findFile('lib/' + name);
    if (name.startsWith('/')) return this.findFile(name);
    const rel = fromFile && dirOf(fromFile) ? dirOf(fromFile) + '/' + name : name;
    return this.findFile(rel) ?? this.findFile(name);
  }
  sourceText(path) {
    let t = this.texts.get(path);
    if (t === undefined) {
      const v = this.files.get(path);
      t = typeof v === 'string' ? v : bytesToText(toBytes(v));
      t = t.replace(/\r\n?/g, '\n');
      this.texts.set(path, t);
    }
    return t;
  }

  // ---------------------------------------------------------------- diagnostics
  loc() {
    const r = this.r;
    return r ? { file: r.src.file, line: r.line, col: r.col() } : { file: this.main, line: 1, col: 1 };
  }
  err(msg) { throw new AsmError(msg, this.loc()); }
  error(msg, loc = this.loc()) {
    if (!this.final || this.dry) return;
    const k = `${loc.file}|${loc.line}|${loc.col}|${msg}`;
    if (this.diagSeen.has(k)) return;
    this.diagSeen.add(k);
    this.errors.push({ file: loc.file, line: loc.line, col: loc.col, msg });
    if (this.errors.length >= MAX_ERRORS) {
      this.errors.push({ file: loc.file, line: loc.line, col: loc.col, msg: 'Too many errors, stopping.' });
      throw new StopPass();
    }
  }
  warn(msg, loc = this.loc()) {
    if (!this.final || this.dry) return;
    const k = `W${loc.file}|${loc.line}|${loc.col}|${msg}`;
    if (this.diagSeen.has(k)) return;
    this.diagSeen.add(k);
    this.warnings.push({ file: loc.file, line: loc.line, col: loc.col, msg });
  }

  // ---------------------------------------------------------------- passes
  run(main) {
    this.main = normPath(main);
    const found = this.findFile(this.main);
    if (found) this.main = found;
    let prevUndef = Infinity;
    let pass = 0;
    for (;;) {
      pass++;
      this.runPass(pass, false);
      if (!this.changed && this.undefCount === 0) break;
      if (pass >= MAX_PASSES) break;
      if (!this.changed && this.undefCount >= prevUndef) break;
      prevUndef = this.undefCount;
    }
    this.runPass(pass + 1, true);
    return this.result();
  }

  runPass(pass, final) {
    this.pass = pass;
    this.final = final;
    this.errors = [];
    this.warnings = [];
    this.diagSeen = new Set();
    this.changed = false;
    this.undefCount = 0;
    this.dry = 0;
    this.top = 0xffff;                  // the highest address: 64K, 16 MB for the 68000 (setCpu)
    this.mem = new Uint8Array(0x10000);
    this.written = new Uint8Array(0x10000);
    this.minAddr = Infinity;
    this.maxAddr = -1;
    this.realpc = null;
    this.pcOffset = 0;
    this.segStart = 0;
    this.segments = [];
    this.convtab = 'raw';
    this.xorVal = 0;
    this.al = false;                    // the 65816: 16 bit accumulator / index registers (!al, !rl)
    this.rl = false;
    this.initmem = 0;
    this.zoneCounter = 0;
    this.cheapCounter = 0;
    this.zone = { id: 0, title: '' };
    this.cheap = { id: 0, title: '' };
    this.anon = new Map();
    this.depth = 0;
    this.macroDepth = 0;
    this.addrMode = 0;
    this.outName = null;
    this.outFormat = null;
    this.runAddr = this.opts.run ?? null;
    this.initAddr = this.opts.init ?? null;
    this.slName = null;
    this.svlName = null;
    this.lineRecs = [];
    this.emitCount = 0;
    this.sourceOrder = [];
    this.staleUses = [];
    this.r = null;
    for (const k of this.aliasKeys) this.symbols.delete(k);
    this.aliasKeys.clear();
    try {
      this.setCpu(String(this.opts.cpu || '6502').toLowerCase());
      for (const [name, val] of Object.entries(this.opts.defines || {})) {
        const v = typeof val === 'string' ? STR(val) : V(Number(val), !Number.isInteger(Number(val)));
        this.defineKey(this.symKey(name), name, v, 'set');
      }
      if (!this.files.has(this.main)) this.err(`Cannot open input file "${this.main}".`);
      this.includeFile(this.main);
    } catch (e) {
      if (e instanceof AsmError) {
        try { this.error(e.msg, e.loc); } catch (e2) { if (!(e2 instanceof StopPass)) throw e2; }
      } else if (!(e instanceof StopPass) && !(e instanceof EofSignal)) throw e;
    }
    this.closeSegment();
    if (final) {
      for (const u of this.staleUses) {
        if (u.s.defPass !== this.pass && this.errors.length < MAX_ERRORS) {
          try { this.error(`Symbol not defined (${u.name}).`, u.loc); } catch { /* too many */ }
        }
      }
    }
  }

  includeFile(path) {
    if (this.depth >= MAX_DEPTH) this.err('Too deeply nested. Recursive "!source"?');
    const text = this.sourceText(path);
    if (this.final && !this.sourceOrder.includes(path)) this.sourceOrder.push(path);
    const src = { file: path, text };
    this.depth++;
    try {
      this.parseStatements(new Reader(src, 0, text.length, 1, 0));
    } catch (e) {
      if (!(e instanceof EofSignal)) throw e;
    } finally {
      this.depth--;
    }
  }

  runBlock(blk) {
    this.parseStatements(new Reader(blk.src, blk.start, blk.end, blk.line, blk.lineStart));
  }

  // ---------------------------------------------------------------- statements
  parseStatements(r) {
    const saved = this.r;
    this.r = r;
    try {
      for (;;) {
        r.ws();
        if (r.pos >= r.end) break;
        const c = r.t[r.pos];
        if (c === '\n') { r.adv(); continue; }
        if (c === ';') { r.toEol(); continue; }
        if (c === ':') { r.pos++; continue; }
        const line = r.line;
        const col = r.col();
        const firstOnLine = r.t.slice(r.lineStart, r.pos).trim() === '';
        const cnt0 = this.emitCount;
        const real0 = this.realpc;
        const pc0 = real0 === null ? null : real0 + this.pcOffset;
        let isBlock = false;
        try {
          isBlock = this.statement(r, firstOnLine && col > 1, false);
          r.ws();
          const d = r.peek();
          if (d === ';') r.toEol();
          else if (d !== '' && d !== '\n' && d !== ':') this.err('Garbage data at end of statement.');
        } catch (e) {
          if (!(e instanceof AsmError)) throw e;
          this.error(e.msg, e.loc);
          this.skipStatement(r);
        }
        if (this.final && this.emitCount > cnt0 && !isBlock && pc0 !== null) {
          this.recordLine(r.src.file, line, pc0, real0, this.emitCount - cnt0);
        }
      }
    } finally {
      this.r = saved;
    }
  }

  recordLine(file, line, addr, real, size) {
    const macro = this.macroDepth > 0;
    const last = this.lineRecs[this.lineRecs.length - 1];
    if (last && last.file === file && last.line === line && last.macro === macro && last.real + last.size === real) {
      last.size += size;
      return;
    }
    this.lineRecs.push({ file, line, addr, real, size, macro });
  }

  skipStatement(r) {
    const t = r.t;
    while (r.pos < r.end) {
      const c = t[r.pos];
      if (c === '\n') return;
      if (c === ';') { r.toEol(); return; }
      if (c === '"' || c === "'") {
        r.pos++;
        while (r.pos < r.end && t[r.pos] !== c && t[r.pos] !== '\n') {
          if (t[r.pos] === '\\' && t[r.pos + 1] !== '\n') r.pos++;
          r.pos++;
        }
        if (t[r.pos] === c) r.pos++;
        continue;
      }
      if (c === '{') {
        try { this.scanBlock(r); } catch (e) { if (!(e instanceof AsmError)) throw e; r.pos = r.end; }
        continue;
      }
      r.pos++;
    }
  }

  scanBlock(r) {
    r.ws();
    if (r.peek() !== '{') this.err("Missing '{'.");
    const openLoc = this.loc();
    r.pos++;
    const start = r.pos, line = r.line, lineStart = r.lineStart;
    const t = r.t;
    let depth = 1;
    while (r.pos < r.end) {
      const c = t[r.pos];
      if (c === '\n') { r.adv(); continue; }
      if (c === '"' || c === "'") {
        r.pos++;
        while (r.pos < r.end && t[r.pos] !== c && t[r.pos] !== '\n') {
          if (t[r.pos] === '\\' && t[r.pos + 1] !== '\n') r.pos++;
          r.pos++;
        }
        if (t[r.pos] === c) r.pos++;
        continue;
      }
      if (c === ';') { r.toEol(); continue; }
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        const end = r.pos;
        r.pos++;
        return { src: r.src, start, end, line, lineStart };
      }
      r.pos++;
    }
    throw new AsmError("Found end-of-file instead of '}'.", openLoc);
  }

  readWord(r) {
    const s = r.pos;
    while (r.pos < r.end && isIdChar(r.t[r.pos])) r.pos++;
    return r.t.slice(s, r.pos);
  }
  readSymName(r) {
    r.ws();
    const s = r.pos;
    const c = r.peek();
    if (c === '.' || c === '@') r.pos++;
    else if (!isIdStart(c)) this.err('Missing symbol name.');
    while (r.pos < r.end && isIdChar(r.t[r.pos])) r.pos++;
    if (r.pos - s === 1 && (c === '.' || c === '@')) this.err('Missing symbol name.');
    return r.t.slice(s, r.pos);
  }
  readFileName(r) {
    r.ws();
    const c = r.peek();
    if (c === '"') { r.pos++; return { name: this.readQuoted(r, '"'), lib: false }; }
    if (c === '<') {
      r.pos++;
      const s = r.pos;
      while (r.pos < r.end && r.t[r.pos] !== '>' && r.t[r.pos] !== '\n') r.pos++;
      if (r.peek() !== '>') this.err('Quotes still open at end of line.');
      const name = r.t.slice(s, r.pos);
      r.pos++;
      return { name, lib: true };
    }
    this.err('File name quotes not found ("" or <>).');
  }
  readQuoted(r, q) {
    let s = '';
    for (;;) {
      if (r.pos >= r.end || r.t[r.pos] === '\n') this.err('Quotes still open at end of line.');
      const c = r.t[r.pos++];
      if (c === q) return s;
      if (c === '\\') {
        const e = r.pos < r.end ? r.t[r.pos++] : '';
        const m = { 0: '\0', t: '\t', n: '\n', r: '\r', '\\': '\\', '"': '"', "'": "'" }[e];
        if (m === undefined) this.err('Unsupported backslash sequence.');
        s += m;
      } else s += c;
    }
  }

  statement(r, indented, afterLabel) {
    const c = r.peek();
    if (c === '!') {
      r.pos++;
      const name = this.readWord(r).toLowerCase();
      if (!name) this.err('Missing pseudo opcode.');
      return this.pseudo(name, r);
    }
    if (c === '*') {
      r.pos++;
      r.ws();
      if (r.peek() !== '=') this.err("Expected '=' after '*'.");
      r.pos++;
      this.setPC(r);
      return false;
    }
    if (c === '+' && (isIdStart(r.peek(1)) || r.peek(1) === '.')) return this.macroCall(r);
    if (c === '+' || c === '-') {
      let n = 0;
      while (r.peek() === c) { r.pos++; n++; }
      const nx = r.peek();
      if (!(nx === '' || nx === ' ' || nx === '\t' || nx === '\n' || nx === ';' || nx === ':' || nx === '\r')) {
        this.err('Garbage data at end of statement.');
      }
      this.defineAnon(c.repeat(n));
      if (r.eos()) return false;
      return this.statement(r, false, true);
    }
    if (c === '.' || c === '@' || isIdStart(c)) {
      const name = this.readSymName(r);
      const lname = name.toLowerCase();
      const isMn = c !== '.' && c !== '@' && Object.prototype.hasOwnProperty.call(this.cpuTable, lname);
      let force = 0;
      if (isMn && this.cpuKey !== 'z80' && this.cpuKey !== 'm68k' && r.peek() === '+' &&/[123]/.test(r.peek(1)) && !isIdChar(r.peek(2))) {
        force = +r.peek(1);
        r.pos += 2;
      }
      r.ws();
      if (!force && r.peek() === '=' && r.peek(1) !== '=') {
        if (afterLabel) this.err('Garbage data at end of statement.');
        r.pos++;
        const v = this.expr(r);
        this.defineSym(name, v, 'equ');
        return false;
      }
      if (isMn) { this.instruction(lname, force, r); return false; }
      if (afterLabel) this.err('Garbage data at end of statement.');
      if (indented && r.peek() !== ':' && ALL_MNEMONICS.has(lname)) {
        this.err(`Mnemonic "${lname}" is not available for CPU "${this.cpuName}".`);
      }
      this.defineLabel(name);
      if (r.peek() === ':') return false;
      if (indented) this.warn('Implicit label definition not in leftmost column.');
      if (r.eos()) return false;
      return this.statement(r, false, true);
    }
    if (c === '}') this.err("Found '}' instead of end-of-file.");
    if (c === '{') this.err("Found '{' without a pseudo opcode that takes a block.");
    this.err('Syntax error.');
  }

  // ---------------------------------------------------------------- program counter / output
  pcVal() {
    if (this.realpc === null) this.err('Program counter undefined.');
    return this.realpc + this.pcOffset;
  }
  closeSegment() {
    if (this.realpc !== null && this.realpc > this.segStart) this.segments.push({ start: this.segStart, end: this.realpc });
  }
  setPC(r) {
    const v = this.expr(r);
    let n = this.toInt(v);
    let overlay = false;
    for (;;) {
      r.ws();
      if (r.peek() !== ',') break;
      r.pos++;
      r.ws();
      const k = this.readWord(r).toLowerCase();
      if (k === 'overlay') overlay = true;
      else if (k !== 'invisible') this.err('Unknown "*=" segment modifier.');
    }
    if (v.u) n = 0;
    if (n < 0 || n > this.top) this.err('Program counter out of range.');
    this.closeSegment();
    const real = n - this.pcOffset;
    if (this.final && !overlay) {
      for (const s of this.segments) {
        if (real >= s.start && real < s.end) { this.warn('Segment starts inside another one, overwriting it.'); break; }
      }
    }
    this.realpc = real;
    this.segStart = real;
  }
  emit(b) {
    if (this.realpc === null) this.err('Program counter undefined.');
    const a = this.realpc;
    if (a > this.top || a < 0) this.err('Produced too much code.');
    const x = (b ^ this.xorVal) & 0xff;
    this.mem[a] = x;
    this.written[a] = 1;
    if (a < this.minAddr) this.minAddr = a;
    if (a > this.maxAddr) this.maxAddr = a;
    this.realpc = a + 1;
    this.emitCount++;
  }
  emitVal(n, size, v, unsigned = false, be = false) {
    const max = 2 ** (8 * size);
    const min = unsigned ? 0 : -(max / 2);
    if (!v.u && (n < min || n >= max)) this.error('Number out of range.');
    let x = ((n % 4294967296) + 4294967296) % 4294967296;
    const out = [];
    for (let i = 0; i < size; i++) { out.push(x % 256); x = Math.floor(x / 256); }
    if (be) out.reverse();
    for (const b of out) this.emit(b);
  }

  // ---------------------------------------------------------------- symbols
  newZone(title, macro = false) { return { id: ++this.zoneCounter, title, macro }; }
  newCheap(title) { return { id: ++this.cheapCounter, title }; }
  symKey(name) {
    const c = name[0];
    if (c === '.') return 'L' + this.zone.id + ':' + name;
    if (c === '@') return 'C' + this.cheap.id + ':' + name;
    return 'G:' + name;
  }
  newSym(key, name) {
    return {
      key, name, value: undefined, defPass: 0, kind: null, file: null, line: 0, zone: '',
      used: false, everUndef: false, isSet: false, inMacro: false, anon: key[0] === 'A',
    };
  }
  isDefined(name) {
    const s = this.symbols.get(this.symKey(name));
    return !!s && s.value !== undefined && !(s.value.t === 'n' && s.value.u) && s.defPass === this.pass;
  }
  defineSym(name, value, kind) { return this.defineKey(this.symKey(name), name, value, kind); }
  defineKey(key, name, value, kind) {
    if (this.dry) return null;
    if (this.addrMode && value.t === 'n') value = { ...value, a: 1 };
    let s = this.symbols.get(key);
    if (!s) { s = this.newSym(key, name); this.symbols.set(key, s); }
    if (kind !== 'set' && s.defPass === this.pass && !s.isSet) {
      if (!valEqual(s.value, value)) this.error('Symbol already defined.');
      return s;
    }
    if (kind !== 'set' && s.defPass !== this.pass && s.value !== undefined && !valEqual(s.value, value)) {
      this.changed = true;
      if (this.final) this.error(`Symbol "${name}" changed value between passes (phase error).`);
    }
    s.value = value;
    s.defPass = this.pass;
    s.isSet = kind === 'set';
    s.kind = kind;
    if (this.r) { s.file = this.r.src.file; s.line = this.r.line; } else { s.file = null; s.line = 0; }
    s.zone = name[0] === '.' ? this.zone.title : name[0] === '@' ? this.cheap.title : '';
    s.inMacro = this.macroDepth > 0 && (name[0] === '.' || name[0] === '@');
    return s;
  }
  defineLabel(name) {
    const v = V(this.pcVal());
    v.a = 1;
    this.defineSym(name, v, 'label');
    if (name[0] !== '.' && name[0] !== '@') this.cheap = this.newCheap(name);
  }
  defineAnon(run) {
    const k = this.zone.id + ':' + run;
    let n = this.anon.get(k) || 0;
    let key;
    if (run[0] === '-') { n++; this.anon.set(k, n); key = `A${k}#${n}`; }
    else { key = `A${k}#${n}`; this.anon.set(k, n + 1); }
    const v = V(this.pcVal());
    v.a = 1;
    this.defineKey(key, run, v, 'label');
  }
  anonRef(run) {
    const k = this.zone.id + ':' + run;
    return this.readKey(`A${k}#${this.anon.get(k) || 0}`, run);
  }
  readKey(key, name) {
    let s = this.symbols.get(key);
    if (!s || s.value === undefined || (s.value.t === 'n' && s.value.u)) {
      if (!this.dry) {
        if (!s) { s = this.newSym(key, name); this.symbols.set(key, s); }
        s.everUndef = true;
        this.undefCount++;
        if (this.final) this.error(`Symbol not defined (${name}).`);
      }
      return UNDEF();
    }
    if (!this.dry) {
      s.used = true;
      if (this.final && s.defPass !== this.pass) this.staleUses.push({ s, name, loc: this.loc() });
    }
    const v = s.value;
    if (v.t !== 'n') return v;
    return { ...v, e: v.e || s.everUndef };
  }

  // ---------------------------------------------------------------- expressions
  expr(r) { return this.parseBin(r, 0); }

  parseBin(r, minPrec) {
    let left = this.parseUnary(r);
    for (;;) {
      r.ws();
      const op = this.peekOp(r);
      if (!op || op.prec < minPrec) return left;
      r.pos += op.len;
      const right = this.parseBin(r, op.prec === 11 ? 11 : op.prec + 1);
      left = this.binop(op.id, left, right);
    }
  }

  peekOp(r) {
    const c = r.peek(), c1 = r.peek(1), c2 = r.peek(2);
    switch (c) {
      case '*': return c1 === '*' ? { id: '^', prec: 11, len: 2 } : { id: '*', prec: 9, len: 1 };
      case '/': return { id: '/', prec: 9, len: 1 };
      case '%': return { id: '%', prec: 9, len: 1 };
      case '+': return { id: '+', prec: 8, len: 1 };
      case '-': return { id: '-', prec: 8, len: 1 };
      case '^': return { id: '^', prec: 11, len: 1 };
      case '<':
        if (c1 === '<') return { id: '<<', prec: 7, len: 2 };
        if (c1 === '=') return { id: '<=', prec: 5, len: 2 };
        if (c1 === '>') return { id: '!=', prec: 4, len: 2 };
        return { id: '<', prec: 5, len: 1 };
      case '>':
        if (c1 === '>') return c2 === '>' ? { id: '>>>', prec: 7, len: 3 } : { id: '>>', prec: 7, len: 2 };
        if (c1 === '=') return { id: '>=', prec: 5, len: 2 };
        if (c1 === '<') return { id: '!=', prec: 4, len: 2 };
        return { id: '>', prec: 5, len: 1 };
      case '!': return c1 === '=' ? { id: '!=', prec: 4, len: 2 } : null;
      case '=': return c1 === '=' ? { id: '=', prec: 4, len: 2 } : { id: '=', prec: 4, len: 1 };
      case '&': return { id: '&', prec: 3, len: 1 };
      case '|': return { id: '|', prec: 1, len: 1 };
    }
    if (isIdStart(c)) {
      let e = r.pos;
      while (e < r.end && isIdChar(r.t[e])) e++;
      const k = KEYWORD_OPS[r.t.slice(r.pos, e).toLowerCase()];
      if (k) return { ...k, len: e - r.pos };
    }
    return null;
  }

  parseUnary(r) {
    r.ws();
    const c = r.peek();
    if (c === '+' || c === '-') {
      let n = 0;
      while (r.peek(n) === c) n++;
      let p = r.pos + n;
      while (p < r.end && (r.t[p] === ' ' || r.t[p] === '\t')) p++;
      const nx = p < r.end ? r.t[p] : '';
      if (nx === '' || nx === '\n' || nx === ';' || nx === ':' || nx === ',' || nx === ')' || nx === ']' || nx === '}' || nx === '\r') {
        r.pos += n;
        return this.anonRef(c.repeat(n));
      }
      r.pos++;
      const v = this.numify(this.parseBin(r, 11));
      return c === '-' ? { ...v, v: -v.v, a: -v.a } : v;
    }
    if (c === '!') { r.pos++; return this.unop('not', this.parseBin(r, 13)); }
    if (c === '<' || c === '>' || c === '^') { r.pos++; return this.unop(c, this.parseBin(r, 7)); }
    if ((c === 'n' || c === 'N') && r.keyword('not')) { r.pos += 3; return this.unop('not', this.parseBin(r, 13)); }
    let v = this.parsePrimary(r);
    while (r.peek() === '[') {
      r.pos++;
      const i = this.expr(r);
      r.ws();
      if (r.peek() !== ']') this.err("Missing ']'.");
      r.pos++;
      v = this.index(v, i);
    }
    return v;
  }

  parsePrimary(r) {
    r.ws();
    const c = r.peek();
    if (c === '(') {
      r.pos++;
      const v = this.expr(r);
      r.ws();
      if (r.peek() !== ')') this.err("Missing ')'.");
      r.pos++;
      return v;
    }
    if (c === '[') {
      r.pos++;
      const l = [];
      r.ws();
      if (r.peek() === ']') { r.pos++; return LIST(l); }
      for (;;) {
        l.push(this.expr(r));
        r.ws();
        if (r.peek() === ',') { r.pos++; continue; }
        if (r.peek() === ']') { r.pos++; return LIST(l); }
        this.err("Missing ']'.");
      }
    }
    if (c === '"') { r.pos++; return STR(this.readQuoted(r, '"')); }
    if (c === "'") {
      r.pos++;
      const s = this.readQuoted(r, "'");
      if (s.length !== 1) this.err('Character constant must contain exactly one character.');
      return V(this.conv(s.charCodeAt(0)));
    }
    if (c === '$') { r.pos++; return this.parseDigits(r, 16); }
    if (c === '%') { r.pos++; return this.parseDigits(r, 2); }
    if (c === '&') { r.pos++; return this.parseDigits(r, 8); }
    if (c >= '0' && c <= '9') {
      const c1 = r.peek(1);
      if (c === '0' && (c1 === 'x' || c1 === 'X')) { r.pos += 2; return this.parseDigits(r, 16); }
      if (c === '0' && (c1 === 'b' || c1 === 'B') && /[01.#]/.test(r.peek(2))) { r.pos += 2; return this.parseDigits(r, 2); }
      const s = r.pos;
      while (/[0-9]/.test(r.peek())) r.pos++;
      if (r.peek() === '.' && /[0-9]/.test(r.peek(1))) {
        r.pos++;
        while (/[0-9]/.test(r.peek())) r.pos++;
        return V(parseFloat(r.t.slice(s, r.pos)), true);
      }
      if (isIdChar(r.peek())) this.err('Malformed number.');
      return V(parseInt(r.t.slice(s, r.pos), 10));
    }
    if (c === '*') { r.pos++; const v = V(this.pcVal()); v.a = 1; return v; }
    if (c === '.' || c === '@' || isIdStart(c)) {
      const name = this.readSymName(r);
      if (c !== '.' && c !== '@') {
        const ln = name.toLowerCase();
        if (FUNCS.has(ln)) {
          const s = r.save();
          r.ws();
          if (r.peek() === '(') {
            r.pos++;
            const a = this.expr(r);
            r.ws();
            if (r.peek() !== ')') this.err("Missing ')'.");
            r.pos++;
            return this.func(ln, a);
          }
          r.restore(s);
        }
      }
      return this.readKey(this.symKey(name), name);
    }
    if (c === '' || c === '\n' || c === ';' || c === ':') this.err('Value expected.');
    this.err(`Syntax error (unexpected "${c}").`);
  }

  parseDigits(r, base) {
    let digits = 0;
    let v = 0;
    for (;;) {
      const c = r.peek();
      let d;
      if (base === 16) { if (!isHex(c)) break; d = parseInt(c, 16); }
      else if (base === 2) { if (c === '0' || c === '.') d = 0; else if (c === '1' || c === '#') d = 1; else break; }
      else { if (!(c >= '0' && c <= '7')) break; d = +c; }
      v = v * base + d;
      digits++;
      r.pos++;
    }
    if (!digits) this.err('Malformed number.');
    if (base !== 2 && isIdChar(r.peek())) this.err('Malformed number.');
    const out = V(v);
    if ((base === 16 && digits > 2) || (base === 2 && digits > 8)) out.force = 2;
    if ((base === 16 && digits > 4) || (base === 2 && digits > 16)) out.force = 3;
    return out;
  }

  conv(code) {
    const t = this.convtab;
    if (t === 'raw') return code & 0xff;
    if (t === 'pet') return convPet(code) & 0xff;
    if (t === 'scr') return convScr(code) & 0xff;
    return t[code & 0xff];
  }

  numify(v) {
    if (v.t === 'n') return v;
    if (v.t === 's' && v.s.length === 1) return V(this.conv(v.s.charCodeAt(0)));
    this.err(v.t === 's' ? 'String used where a number is expected (only single characters allowed).' : 'List used where a number is expected.');
  }
  toNum(v) { return this.numify(v).v; }
  toInt(v) { return Math.trunc(this.toNum(v)); }
  truthy(v) {
    if (v.t === 'n') return v.v !== 0;
    if (v.t === 's') return v.s.length > 0;
    return v.l.length > 0;
  }

  index(v, i) {
    const n = this.toInt(i);
    if (v.t === 'l' || v.t === 's') {
      const len = v.t === 'l' ? v.l.length : v.s.length;
      const k = n < 0 ? len + n : n;
      if (k < 0 || k >= len) this.err('Index out of range.');
      return v.t === 'l' ? v.l[k] : STR(v.s[k]);
    }
    this.err('Indexing is only possible for lists and strings.');
  }

  func(name, a) {
    const num = () => this.numify(a);
    const fl = x => ({ ...V(x, true), u: a.u, e: a.e });
    switch (name) {
      case 'sin': return fl(Math.sin(num().v));
      case 'cos': return fl(Math.cos(num().v));
      case 'tan': return fl(Math.tan(num().v));
      case 'arcsin': { const x = num().v; if ((x < -1 || x > 1) && !a.u) this.err('Argument out of range.'); return fl(Math.asin(x)); }
      case 'arccos': { const x = num().v; if ((x < -1 || x > 1) && !a.u) this.err('Argument out of range.'); return fl(Math.acos(x)); }
      case 'arctan': return fl(Math.atan(num().v));
      case 'int': { const x = num(); return { ...x, v: Math.trunc(x.v), f: false }; }
      case 'float': { const x = num(); return { ...x, f: true }; }
      case 'addr': case 'address': { const x = num(); return { ...x, a: 1 }; }
      case 'is_number': return BOOL(a.t === 'n');
      case 'is_list': return BOOL(a.t === 'l');
      case 'is_string': return BOOL(a.t === 's');
      case 'len':
        if (a.t === 'l') return V(a.l.length);
        if (a.t === 's') return V(a.s.length);
        this.err('len() needs a list or string.');
    }
    this.err('Unknown function.');
  }

  unop(op, x) {
    x = this.numify(x);
    const n = Math.trunc(x.v);
    let v;
    switch (op) {
      case 'not': v = -n - 1; break;
      case '<': v = bitop(n, 255, '&'); break;
      case '>': v = bitop(Math.floor(n / 256), 255, '&'); break;
      case '^': v = bitop(Math.floor(n / 65536), 255, '&'); break;
    }
    return { t: 'n', v, f: false, u: x.u, e: x.e, a: 0, force: 0 };
  }

  binop(op, x, y) {
    if (x.t !== 'n' || y.t !== 'n') {
      if (x.t === 's' && y.t === 's') {
        switch (op) {
          case '+': return STR(x.s + y.s);
          case '=': return BOOL(x.s === y.s);
          case '!=': return BOOL(x.s !== y.s);
          case '<': return BOOL(x.s < y.s);
          case '<=': return BOOL(x.s <= y.s);
          case '>': return BOOL(x.s > y.s);
          case '>=': return BOOL(x.s >= y.s);
        }
      }
      if (x.t === 'l' || y.t === 'l') {
        if (x.t === 'l' && y.t === 'l') {
          if (op === '+') return LIST([...x.l, ...y.l]);
          if (op === '=') return BOOL(valEqual(x, y));
          if (op === '!=') return BOOL(!valEqual(x, y));
        }
        this.err('Operation not supported for lists.');
      }
      x = this.numify(x);
      y = this.numify(y);
    }
    const u = x.u || y.u, e = x.e || y.e, force = Math.max(x.force, y.force);
    const isF = x.f || y.f;
    const a = x.v, b = y.v;
    const I = Math.trunc;
    let v, f = false, addr = 0;
    const divZero = () => { if (!u) this.err('Division by zero.'); return 0; };
    switch (op) {
      case '^':
        if (!isF && b < 0) { if (!u) this.err('Exponent is negative.'); v = 0; }
        else { v = a ** b; f = isF; }
        break;
      case '*': v = a * b; f = isF; break;
      case '/':
        if (b === 0) v = divZero();
        else if (isF) { v = a / b; f = true; } else v = I(a / b);
        break;
      case 'DIV': v = b === 0 ? divZero() : I(a / b); break;
      case '%':
        if (b === 0) v = divZero();
        else { v = a % b; f = isF; }
        break;
      case '+': v = a + b; f = isF; addr = x.a + y.a; break;
      case '-': v = a - b; f = isF; addr = x.a - y.a; break;
      case '<<': v = I(a) * 2 ** I(b); break;
      case '>>': v = Math.floor(I(a) / 2 ** I(b)); break;
      case '>>>': {
        const ua = I(a) < 0 ? ((I(a) % 4294967296) + 4294967296) % 4294967296 : I(a);
        v = Math.floor(ua / 2 ** I(b));
        break;
      }
      case '<': v = +(a < b); break;
      case '<=': v = +(a <= b); break;
      case '>': v = +(a > b); break;
      case '>=': v = +(a >= b); break;
      case '=': v = +(a === b); break;
      case '!=': v = +(a !== b); break;
      case '&': v = bitop(a, b, '&'); break;
      case '|': v = bitop(a, b, '|'); break;
      case 'XOR': v = bitop(a, b, '^'); break;
      default: this.err('Unknown operator.');
    }
    if (!f && !Number.isFinite(v)) v = 0;
    return { t: 'n', v, f, u, e, a: addr, force };
  }

  // ---------------------------------------------------------------- instructions
  setCpu(name) {
    const k = CPU_ALIASES[name];
    if (!k) {
      if (UNSUPPORTED_CPUS.has(name)) this.err(`Unsupported CPU "${name}" (supported: 6502, nmos6502/6510, 65c02, r65c02, w65c02, 65816, 65ce02, 4502, m65, z80, 68000).`);
      this.err(`Unknown processor "${name}".`);
    }
    this.cpuName = name;
    this.cpuKey = k;
    this.cpuTable = k === 'z80' ? Z80_TABLE : k === 'm68k' ? M68K_TABLE : CPU_TABLES[k];
    if (k === 'm68k' && this.top < 0xffffff) {
      // the 68000 addresses 16 MB: the memory of the pass grows (what is written stays)
      this.top = 0xffffff;
      const mem = new Uint8Array(0x1000000), written = new Uint8Array(0x1000000);
      mem.set(this.mem);
      written.set(this.written);
      this.mem = mem;
      this.written = written;
    }
  }

  looksIndirect(r) {
    const t = r.t;
    let p = r.pos, depth = 0;
    while (p < r.end) {
      const c = t[p];
      if (c === '\n' || c === ';') return false;
      if (c === '"' || c === "'") {
        p++;
        while (p < r.end && t[p] !== c && t[p] !== '\n') { if (t[p] === '\\') p++; p++; }
      } else if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') {
        if (--depth === 0) {
          p++;
          while (p < r.end && (t[p] === ' ' || t[p] === '\t' || t[p] === '\r')) p++;
          const n = p < r.end ? t[p] : '';
          return n === '' || n === '\n' || n === ';' || n === ':' || n === ',';
        }
      }
      p++;
    }
    return false;
  }

  readIndex(r, want) {
    r.ws();
    const ix = this.readWord(r).toLowerCase();
    if (!want.includes(ix)) this.err(ILLEGAL_MODE);
    return ix;
  }

  instruction(mn, force, r) {
    if (this.cpuKey === 'z80') return this.z80Instruction(mn, r);
    if (this.cpuKey === 'm68k') return m68kInstruction(this, mn, r);
    const tab = this.cpuTable[mn];
    let mode, v, v2;
    if (r.eos()) mode = 'imp';
    else {
      const c = r.peek();
      const w816 = this.cpuKey === '65816';
      const ce02 = ['65ce02', '4502', 'm65'].includes(this.cpuKey);
      if (c === '#') { r.pos++; mode = 'imm'; v = this.expr(r); }
      else if (tab.blk !== undefined) {               // mvn / mvp: the source bank, the target bank
        v = this.expr(r);
        r.ws();
        if (r.peek() !== ',') this.err(ILLEGAL_MODE);
        r.pos++;
        v2 = this.expr(r);
        mode = 'blk';
      } else if (w816 && c === '[') {                 // [dp], [dp],y, [abs]
        r.pos++;
        v = this.expr(r);
        r.ws();
        if (r.peek() !== ']') this.err("Missing ']'.");
        r.pos++;
        r.ws();
        if (r.peek() === ',') { r.pos++; this.readIndex(r, ['y']); mode = 'ildpy'; } else mode = 'ildp';
      } else if (this.cpuKey === 'm65' && c === '[') {    // [zp],z and the quad's [zp]: 32 bit pointers
        r.pos++;
        v = this.expr(r);
        r.ws();
        if (r.peek() !== ']') this.err("Missing ']'.");
        r.pos++;
        r.ws();
        if (r.peek() === ',') { r.pos++; this.readIndex(r, ['z']); mode = 'izl'; } else mode = 'izlq';
      } else if (tab.zprel !== undefined) {
        v = this.expr(r);
        r.ws();
        if (r.peek() !== ',') this.err(ILLEGAL_MODE);
        r.pos++;
        v2 = this.expr(r);
        mode = 'zprel';
      } else if (c === '(' && this.looksIndirect(r)) {
        r.pos++;
        v = this.expr(r);
        r.ws();
        if (r.peek() === ',') {
          r.pos++;
          const ix = this.readIndex(r, w816 || ce02 ? ['x', 's'] : ['x']);
          r.ws();
          if (r.peek() !== ')') this.err("Missing ')'.");
          r.pos++;
          mode = 'indx';
          if (ix === 's') { r.ws(); if (r.peek() !== ',') this.err(ILLEGAL_MODE); r.pos++; this.readIndex(r, ['y']); mode = 'sry'; }
        } else {
          if (r.peek() !== ')') this.err("Missing ')'.");
          r.pos++;
          r.ws();
          if (r.peek() === ',') { r.pos++; mode = this.readIndex(r, ce02 ? ['y', 'z'] : ['y']) === 'z' ? 'izpz' : 'indy'; } else mode = 'ind';
        }
      } else {
        v = this.expr(r);
        r.ws();
        if (r.peek() === ',') { r.pos++; mode = this.readIndex(r, w816 ? ['x', 'y', 's'] : ['x', 'y']); if (mode === 's') mode = 'sr'; } else mode = 'plain';
      }
    }
    this.encode(mn, tab, mode, v, v2, force);
  }

  // an opcode with its prefixes (opBytes)
  emitOp(op) {
    for (const b of opBytes(op)) this.emit(b);
  }

  encode(mn, tab, mode, v, v2, force) {
    switch (mode) {
      case 'imp':
        if (tab.imp === undefined) this.err(ILLEGAL_MODE);
        this.emitOp(tab.imp);
        return;
      case 'izpz': case 'izl': case 'izlq': {         // (zp),z [zp],z [zp] - a quad takes [zp] and [zp],z
        const op = mode === 'izpz' ? tab.izpz : tab[mode] ?? (mode === 'izl' ? tab.izlq : undefined);
        if (op === undefined || force >= 2) this.err(ILLEGAL_MODE);
        this.emitOp(op);
        this.emitVal(this.toInt(v), 1, v, true);
        return;
      }
      case 'imm': {
        if (tab.imm16 !== undefined) {                 // phw #imm16
          this.emitOp(tab.imm16);
          this.emitVal(this.toInt(v), 2, v);
          return;
        }
        if (tab.imm === undefined || force >= 3) this.err(ILLEGAL_MODE);
        const n = this.toInt(v);
        const wide = this.cpuKey === '65816' && ((IMM_A.has(mn) && this.al) || (IMM_X.has(mn) && this.rl));
        if (force === 2 && !wide) this.err(ILLEGAL_MODE);
        this.emitOp(tab.imm);
        this.emitVal(n, wide ? 2 : 1, v);
        return;
      }
      case 'zprel': {
        const pc = this.pcVal();
        const zp = this.toInt(v);
        this.emitOp(tab.zprel);
        this.emitVal(zp, 1, v, true);
        this.branch(v2, pc + 3);
        return;
      }
      case 'plain':
        if (tab.rel !== undefined) {
          const pc = this.pcVal();
          this.emitOp(tab.rel);
          this.branch(v, pc + 2);
          return;
        }
        if (tab.rel16 !== undefined) {                  // the 65CE02's lbxx and bsr: from the third byte of the instruction
          const pc = this.pcVal(), off = this.toInt(v) - (pc + 2);
          if (!v.u && (off < -32768 || off > 32767)) this.error(`Target out of range (${off}).`);
          this.emitOp(tab.rel16);
          this.emitVal(((off % 65536) + 65536) % 65536, 2, v, true);
          return;
        }
        if (tab.rell !== undefined) {                   // brl, per: 16 bits relative
          const pc = this.pcVal(), off = this.toInt(v) - (pc + 3);
          if (!v.u && (off < -32768 || off > 32767)) this.error(`Target out of range (${off}).`);
          this.emitOp(tab.rell);
          this.emitVal(((off % 65536) + 65536) % 65536, 2, v, true);
          return;
        }
        return this.sized(tab.zp, tab.abs, v, force, tab.long);
      case 'x': return this.sized(tab.zpx, tab.absx, v, force, tab.longx);
      case 'sr': case 'sry': case 'ildpy':
        if (tab[mode] === undefined) this.err(ILLEGAL_MODE);
        this.emitOp(tab[mode]);
        this.emitVal(this.toInt(v), 1, v, true);
        return;
      case 'ildp':
        if (tab.ialong !== undefined) { this.emitOp(tab.ialong); this.emitVal(this.toInt(v), 2, v, true); return; }
        if (tab.ildp === undefined) this.err(ILLEGAL_MODE);
        this.emitOp(tab.ildp);
        this.emitVal(this.toInt(v), 1, v, true);
        return;
      case 'blk':
        this.emitOp(tab.blk);
        this.emitVal(this.toInt(v2), 1, v2, true);       // the target bank first, as the CPU wants it
        this.emitVal(this.toInt(v), 1, v, true);
        return;
      case 'y': return this.sized(tab.zpy, tab.absy, v, force);
      case 'ind':
        if (tab.ind !== undefined) {
          const n = this.toInt(v);
          if (mn === 'jmp' && !v.u && (n & 0xff) === 0xff && (this.cpuKey === '6502' || this.cpuKey === 'nmos6502')) {
            this.warn('Assembling buggy JMP($xxff) instruction');
          }
          return this.sized(undefined, tab.ind, v, force);
        }
        return this.sized(tab.izp, undefined, v, force);
      case 'indx': return this.sized(tab.indx, tab.iax, v, force);
      case 'indy': return this.sized(tab.indy, undefined, v, force);
    }
  }

  sized(zpOp, absOp, v, force, longOp) {
    const n = this.toInt(v);
    // 24 bits: asked for (+3, six hex digits), too big for 16 bits, or the only mode (jsl, jml)
    if (longOp !== undefined && (force === 3 || (!force && (v.force === 3 || (!v.u && n > 0xffff))) || (zpOp === undefined && absOp === undefined))) {
      this.emitOp(longOp);
      this.emitVal(n, 3, v, true);
      return;
    }
    if (zpOp === undefined && absOp === undefined) this.err(ILLEGAL_MODE);
    if (force === 3) this.err('24-bit addressing ("+3") is not supported by this CPU.');
    let zp;
    if (force === 1) zp = true;
    else if (force === 2) zp = false;
    else if (zpOp === undefined) zp = false;
    else if (absOp === undefined) zp = true;
    else zp = !(v.u || v.e || v.force >= 2) && n >= 0 && n <= 255;
    if (zp) {
      if (zpOp === undefined) this.err(ILLEGAL_MODE);
      this.emitOp(zpOp);
      this.emitVal(n, 1, v, true);
    } else {
      if (absOp === undefined) this.err(ILLEGAL_MODE);
      this.emitOp(absOp);
      this.emitVal(n, 2, v, true);
    }
  }

  branch(v, next) {
    const t = this.toInt(v);
    const off = t - next;
    if (!v.u && (off < -128 || off > 127)) {
      this.error(`Target out of range (${off}; ${off > 127 ? off - 127 : -128 - off} too far).`);
    }
    this.emit(off & 0xff);
  }

  // ---------------------------------------------------------------- pseudo opcodes
  pseudo(name, r) {
    switch (name) {
      case 'to': return this.poTo(r);
      case '8': case '08': case 'by': case 'byte': return this.poData(r, 1, false);
      case '16': case 'wo': case 'word': case 'le16': return this.poData(r, 2, false);
      case 'be16': return this.poData(r, 2, true);
      case '24': case 'le24': return this.poData(r, 3, false);
      case 'be24': return this.poData(r, 3, true);
      case '32': case 'le32': return this.poData(r, 4, false);
      case 'be32': return this.poData(r, 4, true);
      case 'h': case 'hex': return this.poHex(r);
      case 'fi': case 'fill': return this.poFill(r);
      case 'skip': return this.poSkip(r);
      case 'align': return this.poAlign(r);
      case 'tx': case 'text': return this.poText(r, null, 0);
      case 'pet': return this.poText(r, 'pet', 0);
      case 'raw': return this.poText(r, 'raw', 0);
      case 'scr': return this.poText(r, 'scr', 0);
      case 'scrxor': {
        const x = this.toInt(this.expr(r));
        r.ws();
        if (r.peek() !== ',') this.err('Missing comma.');
        r.pos++;
        return this.poText(r, 'scr', x);
      }
      case 'ct': case 'convtab': return this.poConvtab(r);
      case 'bi': case 'bin': case 'binary': return this.poBinary(r);
      case 'src': case 'source': return this.poSource(r);
      case 'macro': return this.poMacro(r);
      case 'if': return this.poIf(r);
      case 'ifdef': return this.poIfdef(r, true);
      case 'ifndef': return this.poIfdef(r, false);
      case 'for': return this.poFor(r);
      case 'do': return this.poDo(r);
      case 'while': return this.poWhile(r);
      case 'set': {
        const n = this.readSymName(r);
        r.ws();
        if (r.peek() !== '=') this.err("Missing '='.");
        r.pos++;
        this.defineSym(n, this.expr(r), 'set');
        return false;
      }
      case 'zn': case 'zone': return this.poZone(r);
      case 'sl': case 'symbollist': this.slName = this.readFileName(r).name; return false;
      case 'svl': this.svlName = this.readFileName(r).name; return false;
      case 'pseudopc': return this.poPseudopc(r);
      case 'realpc': this.pcOffset = 0; return false;
      case 'cpu': return this.poCpu(r);
      case 'al': case 'as': case 'rl': case 'rs': {
        if (this.cpuKey !== '65816') this.err(`"!${name}" is only available for the 65816 CPU.`);
        const key = name[0] === 'a' ? 'al' : 'rl', wide = name[1] === 'l';
        return this.withBlock(r, () => { const old = this[key]; this[key] = wide; return () => { this[key] = old; }; });
      }
      case 'initmem': {
        const v = this.expr(r);
        const n = this.toInt(v);
        if (!v.u && (n < -128 || n > 255)) this.error('Number out of range.');
        this.initmem = n & 0xff;
        return false;
      }
      case 'xor': return this.poXor(r);
      case 'warn': case 'error': case 'serious': return this.poMessage(r, name);
      case 'eof': case 'endoffile': throw new EofSignal();
      case 'run': case 'init': {
        // nerdsuite extension: entry point (xex RUNAD / amsdos exec) and xex INITAD
        const v = this.expr(r);
        const n = v.u ? 0 : this.toInt(v);
        if (n < 0 || n > this.top) this.err('Number out of range.');
        if (name === 'run') this.runAddr = n; else this.initAddr = n;
        return false;
      }
      case 'addr': case 'address': return this.poAddress(r);
      default: this.err('Unknown pseudo opcode.');
    }
  }

  poTo(r) {
    const fn = this.readFileName(r);
    let fmt = null;
    r.ws();
    if (r.peek() === ',') {
      r.pos++;
      r.ws();
      fmt = this.readWord(r).toLowerCase();
      if (!OUTPUT_FORMATS.includes(fmt)) this.err('Unknown output format.');
    } else this.warn('Used "!to" without file format indicator. Defaulting to "cbm".');
    if (this.outName !== null) this.warn('Output file already chosen, ignoring this "!to".');
    else { this.outName = fn.name; this.outFormat = fmt || 'cbm'; }
    return false;
  }

  argList(r, fn) {
    for (;;) {
      fn(this.expr(r));
      r.ws();
      if (r.peek() !== ',') return;
      r.pos++;
    }
  }

  poData(r, size, be) {
    this.argList(r, v => {
      if (v.t === 's' && size === 1) { for (const ch of v.s) this.emit(this.conv(ch.charCodeAt(0))); return; }
      if (v.t === 'l') {
        for (const x of v.l) { const n = this.numify(x); this.emitVal(Math.trunc(n.v), size, n, false, be); }
        return;
      }
      const n = this.numify(v);
      this.emitVal(Math.trunc(n.v), size, n, false, be);
    });
    return false;
  }

  poHex(r) {
    let any = false;
    while (!r.eos()) {
      let g = '';
      while (isHex(r.peek())) { g += r.peek(); r.pos++; }
      if (!g) this.err('Only hex digits and spaces are allowed in "!hex".');
      if (g.length % 2) this.err('Hex digits are not given in pairs.');
      for (let i = 0; i < g.length; i += 2) this.emit(parseInt(g.substr(i, 2), 16));
      any = true;
    }
    if (!any) this.err('Value expected.');
    return false;
  }

  poFill(r) {
    const cv = this.expr(r);
    const n = cv.u ? 0 : this.toInt(cv);
    let fill = 0;
    r.ws();
    if (r.peek() === ',') {
      r.pos++;
      const fv = this.expr(r);
      fill = this.toInt(fv);
      if (!fv.u && (fill < -128 || fill > 255)) this.error('Number out of range.');
    }
    if (n < 0) this.err('Negative size argument.');
    if (n > 0x10000 && n > this.top + 1) this.err('Produced too much code.');
    for (let i = 0; i < n; i++) this.emit(fill);
    return false;
  }

  poSkip(r) {
    const v = this.expr(r);
    const n = v.u ? 0 : this.toInt(v);
    if (n < 0) this.err('Negative size argument.');
    this.pcVal();
    this.realpc += n;
    return false;
  }

  poAlign(r) {
    const and = this.toInt(this.expr(r));
    r.ws();
    if (r.peek() !== ',') this.err('Missing comma.');
    r.pos++;
    const eq = this.toInt(this.expr(r));
    let fill = this.cpuKey === 'z80' || this.cpuKey === 'm68k' ? 0x00 : 0xea;
    r.ws();
    if (r.peek() === ',') { r.pos++; fill = this.toInt(this.expr(r)); }
    if ((eq & ~and) !== 0) this.err('"!align" can never be satisfied (equal value has bits outside the AND value).');
    let guard = 0;
    while (((this.pcVal() & and) !== eq) && guard++ < 0x10000) this.emit(fill);
    return false;
  }

  poText(r, mode, xor) {
    const cv = mode === 'pet' ? convPet : mode === 'scr' ? convScr : mode === 'raw' ? (c => c) : (c => this.conv(c));
    this.argList(r, v => {
      if (v.t === 's') { for (const ch of v.s) this.emit((cv(ch.charCodeAt(0)) & 0xff) ^ xor); return; }
      const n = this.numify(v);
      const x = Math.trunc(n.v);
      if (!n.u && (x < -128 || x > 255)) this.error('Number out of range.');
      this.emit(x ^ xor);
    });
    return false;
  }

  withBlock(r, apply) {
    r.ws();
    if (r.peek() === '{') {
      const blk = this.scanBlock(r);
      const undo = apply();
      try { this.runBlock(blk); } finally { undo(); }
      return true;
    }
    apply();
    return false;
  }

  poConvtab(r) {
    r.ws();
    let tab;
    if (r.peek() === '"' || r.peek() === '<') {
      const fn = this.readFileName(r);
      const path = this.resolve(r.src.file, fn.name, fn.lib);
      if (!path) this.err(`Cannot open input file "${fn.name}".`);
      const d = toBytes(this.files.get(path));
      if (d.length < 256) this.err('Conversion table file is shorter than 256 bytes.');
      tab = Array.from(d.subarray(0, 256));
    } else {
      tab = this.readWord(r).toLowerCase();
      if (!['pet', 'raw', 'scr'].includes(tab)) this.err('Unknown encoding.');
    }
    return this.withBlock(r, () => { const old = this.convtab; this.convtab = tab; return () => { this.convtab = old; }; });
  }

  poBinary(r) {
    const fn = this.readFileName(r);
    let size, skip = 0;
    r.ws();
    if (r.peek() === ',') {
      r.pos++;
      r.ws();
      if (r.peek() !== ',' && !r.eos()) { const v = this.expr(r); size = v.u ? 0 : this.toInt(v); }
      r.ws();
      if (r.peek() === ',') { r.pos++; const v = this.expr(r); skip = v.u ? 0 : this.toInt(v); }
    }
    if ((size !== undefined && size < 0) || skip < 0) this.err('Negative size argument.');
    const path = this.resolve(r.src.file, fn.name, fn.lib);
    if (!path) this.err(`Cannot open input file "${fn.name}".`);
    const data = toBytes(this.files.get(path));
    const avail = data.subarray(Math.min(skip, data.length));
    const n = size === undefined ? avail.length : size;
    if (n > 0x10000 && n > this.top + 1) this.err('Produced too much code.');
    for (let i = 0; i < n; i++) this.emit(i < avail.length ? avail[i] : 0);
    return false;
  }

  poSource(r) {
    const fn = this.readFileName(r);
    const path = this.resolve(r.src.file, fn.name, fn.lib);
    if (!path) this.err(`Cannot open input file "${fn.name}".`);
    if (r.eos()) { /* fine */ }
    this.includeFile(path);
    return true;
  }

  poMacro(r) {
    r.ws();
    const name = this.readSymName(r);
    const params = [];
    r.ws();
    while (r.peek() !== '{' && !r.eos()) {
      let ref = false;
      if (r.peek() === '~') { ref = true; r.pos++; r.ws(); }
      params.push({ ref, name: this.readSymName(r) });
      r.ws();
      if (r.peek() === ',') { r.pos++; r.ws(); } else break;
    }
    const line = r.line;
    const blk = this.scanBlock(r);
    const old = this.macros.get(name);
    if (old && old.pass === this.pass && !(old.blk.src.file === blk.src.file && old.blk.start === blk.start)) {
      this.err(`Macro already defined (${name}).`);
    }
    this.macros.set(name, { name, params, blk, pass: this.pass, file: r.src.file, line });
    return true;
  }

  macroCall(r) {
    r.pos++;
    const name = this.readSymName(r);
    const args = [];
    if (!r.eos()) {
      for (;;) {
        r.ws();
        if (r.peek() === '~') {
          r.pos++;
          const sn = this.readSymName(r);
          args.push({ ref: true, key: this.symKey(sn), name: sn });
        } else args.push({ ref: false, v: this.expr(r) });
        r.ws();
        if (r.peek() !== ',') break;
        r.pos++;
      }
    }
    const m = this.macros.get(name);
    if (!m) { this.undefCount++; this.err(`Macro not defined (${name}).`); }
    if (m.params.length !== args.length) {
      this.err(`Wrong number of macro arguments for "${name}" (expected ${m.params.length}, got ${args.length}).`);
    }
    if (this.depth >= MAX_DEPTH) this.err('Too deeply nested. Recursive macro calls?');
    const refSyms = args.map(a => {
      if (!a.ref) return null;
      let s = this.symbols.get(a.key);
      if (!s) { s = this.newSym(a.key, a.name); this.symbols.set(a.key, s); }
      return s;
    });
    const sz = this.zone, sc = this.cheap;
    this.zone = this.newZone(name, true);
    this.cheap = this.newCheap(name);
    this.depth++;
    this.macroDepth++;
    try {
      m.params.forEach((p, i) => {
        if (p.ref !== args[i].ref) {
          this.err(p.ref ? `Macro parameter ${i + 1} of "${name}" is call-by-reference, use "~".` : `Macro parameter ${i + 1} of "${name}" is call-by-value, remove "~".`);
        }
        if (p.ref) {
          const key = this.symKey(p.name);
          this.symbols.set(key, refSyms[i]);
          this.aliasKeys.add(key);
        } else this.defineSym(p.name, args[i].v, 'set');
      });
      this.runBlock(m.blk);
    } finally {
      this.depth--;
      this.macroDepth--;
      this.zone = sz;
      this.cheap = sc;
    }
    return false;
  }

  dryExpr(r) {
    this.dry++;
    try { return this.expr(r); } finally { this.dry--; }
  }

  elseChain(r, done) {
    for (;;) {
      const s = r.save();
      r.ws();
      if (!r.keyword('else')) { r.restore(s); return; }
      r.pos += 4;
      r.ws();
      let cond = true, hasCond = false;
      if (r.keyword('if')) {
        r.pos += 2;
        hasCond = true;
        if (done) this.dryExpr(r);
        else cond = this.truthy(this.expr(r));
      } else if (r.keyword('ifdef') || r.keyword('ifndef')) {
        const want = r.keyword('ifdef');
        r.pos += want ? 5 : 6;
        hasCond = true;
        const n = this.readSymName(r);
        cond = this.isDefined(n) === want;
      }
      const blk = this.scanBlock(r);
      if (!done && cond) { this.runBlock(blk); done = true; }
      if (!hasCond) return;
    }
  }

  poIf(r) {
    const cond = this.truthy(this.expr(r));
    const blk = this.scanBlock(r);
    if (cond) this.runBlock(blk);
    this.elseChain(r, cond);
    return true;
  }

  poIfdef(r, want) {
    const name = this.readSymName(r);
    const cond = this.isDefined(name) === want;
    r.ws();
    if (r.peek() === '{') {
      const blk = this.scanBlock(r);
      if (cond) this.runBlock(blk);
      this.elseChain(r, cond);
      return true;
    }
    if (cond) {
      if (r.eos()) return false;
      return this.statement(r, false, false);
    }
    this.skipStatement(r);
    return false;
  }

  poFor(r) {
    const name = this.readSymName(r);
    r.ws();
    let values = null, start = 0, end = 0;
    if (r.keyword('in')) {
      r.pos += 2;
      const l = this.expr(r);
      if (l.t === 'l') values = l.l;
      else if (l.t === 's') values = [...l.s].map(STR);
      else if (l.u) values = [];
      else this.err('"!for ... in" needs a list or a string.');
    } else {
      if (r.peek() !== ',') this.err('Missing comma.');
      r.pos++;
      const a = this.expr(r);
      r.ws();
      if (r.peek() === ',') {
        r.pos++;
        const b = this.expr(r);
        start = this.toInt(a);
        end = this.toInt(b);
      } else {
        this.warn('Found old "!for" syntax.');
        end = this.toInt(a);
        values = [];
        for (let i = 1; i <= end && i <= LOOP_LIMIT + 1; i++) values.push(V(i));
      }
    }
    const blk = this.scanBlock(r);
    let iter = 0;
    const guard = () => { if (++iter > LOOP_LIMIT) this.err('Too many loop iterations.'); };
    if (values) {
      for (const v of values) { guard(); this.defineSym(name, v, 'set'); this.runBlock(blk); }
    } else {
      const step = end >= start ? 1 : -1;
      for (let i = start; ; i += step) {
        guard();
        this.defineSym(name, V(i), 'set');
        this.runBlock(blk);
        if (i === end) break;
      }
    }
    return true;
  }

  loopCond(r, forced) {
    const s = r.save();
    r.ws();
    let kind = forced;
    if (!kind) {
      if (r.keyword('while')) kind = 'while';
      else if (r.keyword('until')) kind = 'until';
      if (!kind) { r.restore(s); return null; }
      r.pos += kind.length;
    }
    const state = { src: r.src, pos: r.pos, end: r.end, line: r.line, lineStart: r.lineStart };
    this.dryExpr(r);
    return { kind, state };
  }

  evalCond(c) {
    const rr = new Reader(c.state.src, c.state.pos, c.state.end, c.state.line, c.state.lineStart);
    const saved = this.r;
    this.r = rr;
    try {
      const t = this.truthy(this.expr(rr));
      return c.kind === 'while' ? t : !t;
    } finally { this.r = saved; }
  }

  runLoop(pre, blk, post) {
    let iter = 0;
    for (;;) {
      if (pre && !this.evalCond(pre)) break;
      if (++iter > LOOP_LIMIT) this.err('Too many loop iterations.');
      this.runBlock(blk);
      if (post && !this.evalCond(post)) break;
    }
  }

  poDo(r) {
    const pre = this.loopCond(r);
    const blk = this.scanBlock(r);
    const post = this.loopCond(r);
    this.runLoop(pre, blk, post);
    return true;
  }

  poWhile(r) {
    const pre = this.loopCond(r, 'while');
    const blk = this.scanBlock(r);
    this.runLoop(pre, blk, null);
    return true;
  }

  poZone(r) {
    r.ws();
    let title = '';
    if (isIdStart(r.peek())) title = this.readWord(r);
    else if (r.peek() === '"') { r.pos++; title = this.readQuoted(r, '"'); }
    return this.withBlock(r, () => { const old = this.zone; this.zone = this.newZone(title); return () => { this.zone = old; }; });
  }

  poPseudopc(r) {
    const v = this.expr(r);
    const n = v.u ? 0 : this.toInt(v);
    if (n < 0 || n > this.top) this.err('Program counter out of range.');
    return this.withBlock(r, () => {
      if (this.realpc === null) this.err('Program counter undefined.');
      const old = this.pcOffset;
      this.pcOffset = n - this.realpc;
      return () => { this.pcOffset = old; };
    });
  }

  poCpu(r) {
    r.ws();
    const name = this.readWord(r).toLowerCase();
    return this.withBlock(r, () => {
      const old = this.cpuName;
      this.setCpu(name);
      return () => this.setCpu(old);
    });
  }

  poXor(r) {
    const v = this.expr(r);
    const n = this.toInt(v);
    if (!v.u && (n < -128 || n > 255)) this.error('Number out of range.');
    return this.withBlock(r, () => {
      const old = this.xorVal;
      this.xorVal ^= n & 0xff;
      return () => { this.xorVal = old; };
    });
  }

  poMessage(r, kind) {
    let msg = '';
    if (!r.eos()) {
      this.argList(r, v => {
        if (v.t === 's') msg += v.s;
        else if (v.t === 'n') msg += v.u ? '<undefined>' : v.f ? String(v.v) : String(v.v);
        else msg += '[' + v.l.map(x => (x.t === 's' ? JSON.stringify(x.s) : String(x.v))).join(', ') + ']';
      });
    }
    if (kind === 'warn') this.warn(msg);
    else if (kind === 'error') this.error(msg);
    else if (this.final) { this.error(msg); throw new StopPass(); }
    return false;
  }

  poAddress(r) {
    r.ws();
    if (r.peek() === '{') {
      const blk = this.scanBlock(r);
      this.addrMode++;
      try { this.runBlock(blk); } finally { this.addrMode--; }
      return true;
    }
    this.addrMode++;
    try { return this.statement(r, false, false); } finally { this.addrMode--; }
  }

  // ---------------------------------------------------------------- results
  globalSymbols() {
    const seen = new Set();
    const out = [];
    for (const [key, s] of this.symbols) {
      if (!key.startsWith('G:') || seen.has(s)) continue;
      seen.add(s);
      if (s.defPass !== this.pass || !s.value || s.value.t !== 'n' || s.value.u) continue;
      out.push(s);
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  viceLabels() {
    const syms = this.globalSymbols().filter(s => !s.value.f);
    const line = s => `al C:${hex4(((s.value.v % 4294967296) + 4294967296) % 4294967296)} .${s.name}\n`;
    const isAddr = s => s.value.a === 1;
    let out = '';
    for (const s of syms) if (!isAddr(s) && !s.used) out += line(s);
    out += '\n';
    for (const s of syms) if (!isAddr(s) && s.used) out += line(s);
    out += '\n';
    for (const s of syms) if (isAddr(s)) out += line(s);
    return out;
  }

  symbolList() {
    let out = '';
    for (const s of this.globalSymbols()) {
      const v = s.value;
      const val = v.f ? String(v.v) : v.a === 1 ? '$' + hex4(v.v) : String(v.v);
      out += `${s.name}\t= ${val}${s.used ? '' : '\t; ?'}\n`;
    }
    return out;
  }

  listing() {
    const byFile = new Map();
    for (const l of this.lineRecs) {
      if (l.macro) continue;
      let m = byFile.get(l.file);
      if (!m) byFile.set(l.file, (m = new Map()));
      const e = m.get(l.line);
      if (!e) m.set(l.line, { addr: l.addr, real: l.real, size: l.size, total: l.size });
      else e.total += l.size;
    }
    let out = '';
    for (const f of this.sourceOrder) {
      out += `\n; ******** Source: ${f}\n`;
      const lines = this.texts.get(f).split('\n');
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
      const m = byFile.get(f) || new Map();
      lines.forEach((txt, i) => {
        const e = m.get(i + 1);
        let addr = '    ', hx = '';
        if (e) {
          addr = hex4(e.addr);
          const n = Math.min(e.size, 8);
          for (let k = 0; k < n; k++) hx += hex2(this.mem[(e.real + k) & this.top]);
          if (e.total > n) hx += '...';
        }
        out += `${String(i + 1).padStart(6)}  ${addr} ${hx.padEnd(19)} ${txt}\n`;
      });
    }
    return out;
  }

  /** Atari XEX: $ffff, one segment per contiguous written block, optional INITAD / RUNAD segments. */
  buildXex() {
    const out = [0xff, 0xff];
    let a = this.minAddr;
    while (a <= this.maxAddr) {
      if (!this.written[a]) { a++; continue; }
      let e = a;
      while (e + 1 <= this.maxAddr && this.written[e + 1]) e++;
      out.push(a & 255, a >> 8, e & 255, e >> 8);
      for (let i = a; i <= e; i++) out.push(this.mem[i]);
      a = e + 1;
    }
    if (this.initAddr != null) out.push(0xe2, 0x02, 0xe3, 0x02, this.initAddr & 255, (this.initAddr >> 8) & 255);
    if (this.runAddr != null) out.push(0xe0, 0x02, 0xe1, 0x02, this.runAddr & 255, (this.runAddr >> 8) & 255);
    return Uint8Array.from(out);
  }

  /** TRS-80 /CMD file: a load block ($01, length + 2, address) per 252 bytes of each written area, then the entry ($02 $02 address). */
  buildTrs80() {
    const out = [];
    let a = this.minAddr;
    while (a <= this.maxAddr) {
      if (!this.written[a]) { a++; continue; }
      let e = a;
      while (e + 1 <= this.maxAddr && this.written[e + 1] && e + 1 - a < 252) e++;
      out.push(0x01, e - a + 3, a & 255, a >> 8);
      for (let i = a; i <= e; i++) out.push(this.mem[i]);
      a = e + 1;
    }
    const exec = this.runAddr ?? this.minAddr;
    out.push(0x02, 0x02, exec & 255, (exec >> 8) & 255);
    return Uint8Array.from(out);
  }

  /** Amstrad CPC AMSDOS binary file: 128-byte header + data. */
  /**
   * An Amiga disk (ADF, 880K): the code in the boot block from its byte 12 ("DOS ", the checksum and the
   * root block before it) - Kickstart loads the boot block's 1024 bytes and calls the code with a6 = ExecBase.
   * Code past them lies in the following sectors. The root and bitmap blocks of an empty OFS disk follow.
   */
  buildAdf(data) {
    const BLOCK = 512, BLOCKS = 1760, ROOT = 880, img = new Uint8Array(BLOCKS * BLOCK), view = new DataView(img.buffer);
    if (data.length > img.length - 12 - 2 * BLOCK) { this.errors.push({ file: this.main, line: null, msg: 'The code does not fit the disk.' }); return null; }
    if (data.length > 1012) this.warnings.push({ file: this.main, line: null, msg: `Kickstart loads 1012 bytes of the boot block's code, the program has ${data.length}: it loads the rest itself.` });
    img.set([0x44, 0x4f, 0x53, 0x00], 0);
    view.setUint32(8, ROOT);
    img.set(data, 12);
    // the boot block's checksum: the sum of its longs with the carries added back in, inverted
    let sum = 0;
    for (let i = 0; i < 1024; i += 4) { sum += view.getUint32(i); if (sum > 0xffffffff) sum -= 0xffffffff; }
    view.setUint32(4, ~sum >>> 0);
    const blockSum = (at, field) => {
      let s = 0;
      for (let i = 0; i < BLOCK; i += 4) s = (s + view.getUint32(at + i)) >>> 0;
      view.setUint32(at + field, (0x100000000 - s) >>> 0);
    };
    const root = ROOT * BLOCK;
    view.setUint32(root, 2);                          // T_HEADER
    view.setUint32(root + 12, 72);                    // the size of the hash table
    view.setUint32(root + 312, 0xffffffff);           // the bitmap is valid
    view.setUint32(root + 316, ROOT + 1);             // the bitmap block
    const name = (this.outName ?? 'nerdsuite').replace(/^.*\//, '').replace(/\.adf$/i, '').slice(0, 30) || 'nerdsuite';
    img[root + 432] = name.length;
    for (let i = 0; i < name.length; i++) img[root + 433 + i] = name.charCodeAt(i) & 0xff;
    view.setUint32(root + 508, 1);                    // ST_ROOT
    blockSum(root, 20);
    // the bitmap: a set bit is a free block (from block 2); the boot code, the root and the bitmap are used
    const bm = (ROOT + 1) * BLOCK, used = new Set([ROOT, ROOT + 1]);
    for (let b = 2; b * BLOCK < 12 + data.length; b++) used.add(b);
    for (let b = 2; b < BLOCKS; b++) if (!used.has(b)) img[bm + 4 + ((b - 2) >> 5) * 4 + 3 - (((b - 2) & 31) >> 3)] |= 1 << ((b - 2) & 7);
    blockSum(bm, 0);
    return img;
  }

  buildAmsdos(data, start) {
    const h = new Uint8Array(128);
    const base = (this.outName || this.main || 'NONAME').split('/').pop().toUpperCase();
    const dot = base.lastIndexOf('.');
    const name = (dot > 0 ? base.slice(0, dot) : base).slice(0, 8).padEnd(8, ' ');
    const ext = (dot > 0 ? base.slice(dot + 1) : 'BIN').slice(0, 3).padEnd(3, ' ');
    for (let i = 0; i < 8; i++) h[1 + i] = name.charCodeAt(i) & 0x7f;
    for (let i = 0; i < 3; i++) h[9 + i] = ext.charCodeAt(i) & 0x7f;
    const len = data.length;
    const exec = this.runAddr ?? start;
    h[0x12] = 2;
    h[0x13] = len & 255; h[0x14] = (len >> 8) & 255;
    h[0x15] = start & 255; h[0x16] = (start >> 8) & 255;
    h[0x18] = len & 255; h[0x19] = (len >> 8) & 255;
    h[0x1a] = exec & 255; h[0x1b] = (exec >> 8) & 255;
    h[0x40] = len & 255; h[0x41] = (len >> 8) & 255; h[0x42] = (len >> 16) & 255;
    let sum = 0;
    for (let i = 0; i <= 66; i++) sum += h[i];
    h[0x43] = sum & 255; h[0x44] = (sum >> 8) & 255;
    const out = new Uint8Array(128 + len);
    out.set(h, 0);
    out.set(data, 128);
    return out;
  }

  result() {
    const errors = this.errors, warnings = this.warnings;
    const ok = errors.length === 0;
    const format = this.opts.format || this.outFormat || 'cbm';
    let output = null, start = 0, end = 0;
    if (this.maxAddr >= this.minAddr) {
      start = this.minAddr;
      end = this.maxAddr + 1;
      if (ok) {
        const len = end - start;
        const data = new Uint8Array(len);
        for (let i = 0; i < len; i++) data[i] = this.written[start + i] ? this.mem[start + i] : this.initmem;
        if (format === 'xex') output = this.buildXex();
        else if (format === 'amsdos') output = this.buildAmsdos(data, start);
        else if (format === 'trs80') output = this.buildTrs80();
        else if (format === 'adf') output = this.buildAdf(data);
        else if (format === 'zx81') {
          // the code in the REM line of a .p file: *= $4082 (zx81.js)
          try { output = codeP(data, start, this.runAddr ?? start); } catch (e) { errors.push({ file: this.main, line: null, msg: e.message }); }
        }
        else {
          const hdr = format === 'cbm' ? [start & 255, start >> 8] : format === 'apple' ? [start & 255, start >> 8, len & 255, len >> 8] : [];
          output = new Uint8Array(hdr.length + len);
          output.set(hdr, 0);
          output.set(data, hdr.length);
        }
      }
    }
    const exec = this.runAddr ?? (end > start ? start : null);
    const seen = new Set();
    const symbols = [];
    for (const s of this.symbols.values()) {
      if (seen.has(s)) continue;
      seen.add(s);
      if (s.anon || s.inMacro || s.defPass !== this.pass || !s.value || s.value.t !== 'n' || s.value.u) continue;
      const o = { name: s.name, value: s.value.v, file: s.file, line: s.line, kind: s.kind === 'label' ? 'label' : 'set' };
      if (s.name[0] === '.' || s.name[0] === '@') o.zone = s.zone;
      symbols.push(o);
    }
    symbols.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : (a.zone || '') < (b.zone || '') ? -1 : 1));
    const lines = this.lineRecs.map(l => (l.macro ? { file: l.file, line: l.line, addr: l.addr, size: l.size, macro: true } : { file: l.file, line: l.line, addr: l.addr, size: l.size }));
    return {
      ok, errors, warnings, output,
      outputName: this.outName,
      format,
      start, end,
      symbols,
      lines,
      viceLabels: this.viceLabels(),
      listing: this.listing(),
      symbolList: this.symbolList(),
      symbolListName: this.slName,
      viceLabelsName: this.svlName,
      exec,
      cpu: this.cpuName,
      passes: this.pass,
    };
  }
}

// ------------------------------------------------------------------ public API

/**
 * Assemble a project.
 * @param {string} main path of the main source file
 * @param {Map<string,string|Uint8Array>|Object} files all project files
 * @param {{defines?:Object, cpu?:string, format?:'cbm'|'plain'|'apple'}} opts
 */
export function assemble(main, files, opts = {}) {
  const asm = new Asm(files, opts);
  try {
    return asm.run(main);
  } catch (e) {
    return {
      ok: false,
      errors: [{ file: String(main), line: 0, col: 0, msg: 'Internal assembler error: ' + (e && e.message) }],
      warnings: [], output: null, outputName: null, format: opts.format || 'cbm', start: 0, end: 0,
      symbols: [], lines: [], viceLabels: '', listing: '', symbolList: '', symbolListName: null, viceLabelsName: null,
    };
  }
}

/**
 * Disassemble bytes starting at addr. The 65816: flags { m8, x8 } (8 bit accumulator, index
 * registers) - followed through rep and sep; every instruction has the flags it was read with.
 * @returns {{addr:number, bytes:number[], text:string, flags?:{m8:boolean,x8:boolean}}[]}
 */
export function disassemble(bytes, addr = 0, cpu = '6502', flags = { m8: true, x8: true }) {
  const key = CPU_ALIASES[String(cpu).toLowerCase()] || '6502';
  if (key === 'z80') return disassembleZ80(bytes, addr);
  if (key === 'm68k') return disassembleM68k(bytes, addr);
  const rev = REVERSE[key], pre = PREFIXED[key];
  const out = [];
  const h2 = n => '$' + hex2(n);
  const h4 = n => '$' + hex4(n & 0xffff);
  let i = 0;
  while (i < bytes.length) {
    const a = (addr + i) & 0xffff;
    const op = bytes[i];
    let e = rev[op], np = 0;
    // the 45GS02: $42 $42 ($ea) and $ea before an opcode - the longest prefix that makes an instruction
    for (const n of pre.size ? [3, 2, 1] : []) {
      if (i + n >= bytes.length) continue;
      let code = 0;
      for (let k = 0; k <= n; k++) code = code * 256 + bytes[i + k];
      if (pre.has(code)) { e = pre.get(code); np = n; break; }
    }
    let len = e ? MODE_LEN[e.mode] + np : 1;
    const wide = key === '65816' && e?.mode === 'imm' && ((IMM_A.has(e.m) && !flags.m8) || (IMM_X.has(e.m) && !flags.x8));
    if (wide) len = 3;
    if (!e || i + len > bytes.length) {
      out.push({ addr: a, bytes: [op], text: `!byte ${h2(op)}` });
      i++;
      continue;
    }
    const all = Array.from(bytes.slice(i, i + len));
    const b = all.slice(np);
    const w = b[1] | (b[2] << 8);
    const h6 = n => '$' + n.toString(16).padStart(6, '0');
    const rel = (o, base) => h4(base + (o < 128 ? o : o - 256));
    let operand;
    switch (e.mode) {
      case 'imp': operand = ''; break;
      case 'imm': operand = wide ? '#' + h4(w) : '#' + h2(b[1]); break;
      case 'zp': operand = h2(b[1]); break;
      case 'zpx': operand = h2(b[1]) + ',x'; break;
      case 'zpy': operand = h2(b[1]) + ',y'; break;
      case 'abs': operand = h4(w); break;
      case 'absx': operand = h4(w) + ',x'; break;
      case 'absy': operand = h4(w) + ',y'; break;
      case 'ind': operand = '(' + h4(w) + ')'; break;
      case 'indx': operand = '(' + h2(b[1]) + ',x)'; break;
      case 'indy': operand = '(' + h2(b[1]) + '),y'; break;
      case 'izp': operand = '(' + h2(b[1]) + ')'; break;
      case 'iax': operand = '(' + h4(w) + ',x)'; break;
      case 'rel': operand = rel(b[1], a + 2); break;
      case 'zprel': operand = h2(b[1]) + ',' + rel(b[2], a + 3); break;
      case 'sr': operand = h2(b[1]) + ',s'; break;
      case 'sry': operand = '(' + h2(b[1]) + ',s),y'; break;
      case 'ildp': operand = '[' + h2(b[1]) + ']'; break;
      case 'ildpy': operand = '[' + h2(b[1]) + '],y'; break;
      case 'long': operand = h6(w | b[3] << 16); break;
      case 'longx': operand = h6(w | b[3] << 16) + ',x'; break;
      case 'ialong': operand = '[' + h4(w) + ']'; break;
      case 'rell': operand = h4(a + 3 + (w < 32768 ? w : w - 65536)); break;
      case 'blk': operand = h2(b[2]) + ',' + h2(b[1]); break;
      case 'izpz': operand = '(' + h2(b[1]) + '),z'; break;
      case 'imm16': operand = '#' + h4(w); break;
      case 'rel16': operand = h4(a + 2 + (w < 32768 ? w : w - 65536)); break;
      case 'izl': operand = '[' + h2(b[1]) + '],z'; break;
      case 'izlq': operand = '[' + h2(b[1]) + ']'; break;
    }
    const item = { addr: a, bytes: all, text: operand ? `${e.m} ${operand}` : e.m };
    if (key === '65816') {
      item.flags = { ...flags };
      if (e.m === 'rep') { if (b[1] & 0x20) flags.m8 = false; if (b[1] & 0x10) flags.x8 = false; }
      if (e.m === 'sep') { if (b[1] & 0x20) flags.m8 = true; if (b[1] & 0x10) flags.x8 = true; }
    }
    out.push(item);
    i += len;
  }
  return out;
}

// ------------------------------------------------------------------ Z80 (Zilog syntax)

const Z80_SIMPLE = {
  nop: [0x00], halt: [0x76], di: [0xf3], ei: [0xfb], exx: [0xd9], daa: [0x27], cpl: [0x2f], scf: [0x37], ccf: [0x3f],
  rla: [0x17], rra: [0x1f], rlca: [0x07], rrca: [0x0f],
  neg: [0xed, 0x44], reti: [0xed, 0x4d], retn: [0xed, 0x45], rld: [0xed, 0x6f], rrd: [0xed, 0x67],
  ldi: [0xed, 0xa0], ldir: [0xed, 0xb0], ldd: [0xed, 0xa8], lddr: [0xed, 0xb8],
  cpi: [0xed, 0xa1], cpir: [0xed, 0xb1], cpd: [0xed, 0xa9], cpdr: [0xed, 0xb9],
  ini: [0xed, 0xa2], inir: [0xed, 0xb2], ind: [0xed, 0xaa], indr: [0xed, 0xba],
  outi: [0xed, 0xa3], otir: [0xed, 0xb3], outd: [0xed, 0xab], otdr: [0xed, 0xbb],
};
const Z80_ALU = { add: 0, adc: 1, sub: 2, sbc: 3, and: 4, xor: 5, or: 6, cp: 7 };
const Z80_ROT = { rlc: 0, rrc: 1, rl: 2, rr: 3, sla: 4, sra: 5, sll: 6, sl1: 6, srl: 7 };
const Z80_BIT = { bit: 0x40, res: 0x80, set: 0xc0 };
const Z80_CC = ['nz', 'z', 'nc', 'c', 'po', 'pe', 'p', 'm'];
const Z80_R8 = ['b', 'c', 'd', 'e', 'h', 'l', null, 'a'];
const Z80_HALF = { ixh: [0xdd, 4], ixl: [0xdd, 5], iyh: [0xfd, 4], iyl: [0xfd, 5] };
const Z80_REGS = new Set(['a', 'b', 'c', 'd', 'e', 'h', 'l', 'i', 'r', 'f', 'af', 'bc', 'de', 'hl', 'sp', 'ix', 'iy',
  'ixh', 'ixl', 'iyh', 'iyl', 'nz', 'z', 'nc', 'po', 'pe', 'p', 'm']);
/** Z80 mnemonics – used for statement parsing and docs. */
export const Z80_MNEMONICS = [...Object.keys(Z80_SIMPLE), ...Object.keys(Z80_ALU), ...Object.keys(Z80_ROT), ...Object.keys(Z80_BIT),
  'ld', 'push', 'pop', 'ex', 'inc', 'dec', 'jp', 'jr', 'djnz', 'call', 'ret', 'rst', 'im', 'in', 'out'];
const Z80_TABLE = Object.fromEntries(Z80_MNEMONICS.map(m => [m, {}]));

Object.assign(Asm.prototype, {
  z80Operand(r) {
    r.ws();
    const s = r.save();
    if (r.peek() === '(' && this.looksIndirect(r)) {
      r.pos++;
      r.ws();
      const s2 = r.save();
      if (isIdStart(r.peek())) {
        const w = this.readWord(r).toLowerCase();
        r.ws();
        if (['bc', 'de', 'hl', 'sp', 'c'].includes(w) && r.peek() === ')') { r.pos++; return { k: 'ind', name: w }; }
        if (w === 'ix' || w === 'iy') {
          const p = w === 'ix' ? 0xdd : 0xfd;
          if (r.peek() === ')') { r.pos++; return { k: 'idx', p, d: V(0), plain: true }; }
          if (r.peek() === '+' || r.peek() === '-') {
            const d = this.expr(r);
            r.ws();
            if (r.peek() !== ')') this.err("Missing ')'.");
            r.pos++;
            return { k: 'idx', p, d };
          }
        }
        r.restore(s2);
      }
      const v = this.expr(r);
      r.ws();
      if (r.peek() !== ')') this.err("Missing ')'.");
      r.pos++;
      return { k: 'mem', v };
    }
    if (isIdStart(r.peek())) {
      const w = this.readWord(r).toLowerCase();
      if (Z80_REGS.has(w)) {
        if (w === 'af' && r.peek() === "'") { r.pos++; return { k: 'reg', name: "af'" }; }
        return { k: 'reg', name: w };
      }
      r.restore(s);
    }
    return { k: 'imm', v: this.expr(r) };
  },

  z80Instruction(mn, r) {
    const ops = [];
    if (!r.eos()) {
      for (;;) {
        ops.push(this.z80Operand(r));
        r.ws();
        if (r.peek() !== ',') break;
        r.pos++;
      }
    }
    this.z80Encode(mn, ops);
  },

  // emit a list: numbers = raw bytes, {n}, {nn}, {d}, {rel}
  z80Emit(items) {
    const pc = this.pcVal();
    let len = 0;
    for (const it of items) len += typeof it === 'number' ? 1 : it.nn ? 2 : 1;
    for (const it of items) {
      if (typeof it === 'number') this.emit(it);
      else if (it.n) this.emitVal(this.toInt(it.n), 1, it.n);
      else if (it.nn) this.emitVal(this.toInt(it.nn), 2, it.nn);
      else if (it.d) {
        const d = this.toInt(it.d);
        if (!it.d.u && (d < -128 || d > 127)) this.error('Index displacement out of range.');
        this.emit(d & 0xff);
      } else if (it.rel) this.branch(it.rel, pc + len);
    }
  },

  z80R8(o) {
    if (!o) return null;
    if (o.k === 'reg') {
      const i = Z80_R8.indexOf(o.name);
      if (i >= 0) return { c: i };
      const x = Z80_HALF[o.name];
      if (x) return { c: x[1], p: x[0], half: true };
      return null;
    }
    if (o.k === 'ind' && o.name === 'hl') return { c: 6, mem: true };
    if (o.k === 'idx') return { c: 6, p: o.p, d: o.d, mem: true };
    return null;
  },

  // 16-bit register pair index (bc=0 de=1 hl/ix/iy=2 sp|af=3)
  z80RP(o, af = false) {
    if (!o || o.k !== 'reg') return null;
    const n = o.name;
    if (n === 'bc') return { i: 0 };
    if (n === 'de') return { i: 1 };
    if (n === 'hl') return { i: 2 };
    if (n === 'ix') return { i: 2, p: 0xdd };
    if (n === 'iy') return { i: 2, p: 0xfd };
    if (n === (af ? 'af' : 'sp')) return { i: 3 };
    return null;
  },

  z80Encode(mn, ops) {
    const ILL = () => this.err(ILLEGAL_MODE);
    const E = items => this.z80Emit(items.filter(x => x !== undefined));
    const [a, b] = ops;
    const isReg = (o, n) => !!o && o.k === 'reg' && o.name === n;
    const cc = o => (o && o.k === 'reg' ? Z80_CC.indexOf(o.name) : -1);
    const disp = x => (x.mem && x.p ? { d: x.d } : undefined);
    const nOps = k => { if (ops.length !== k) ILL(); };

    if (Z80_SIMPLE[mn]) { nOps(0); return E(Z80_SIMPLE[mn]); }

    if (mn in Z80_ALU) {
      const alu = Z80_ALU[mn];
      if (ops.length === 2 && (isReg(a, 'hl') || isReg(a, 'ix') || isReg(a, 'iy'))) {
        const dst = this.z80RP(a), src = this.z80RP(b);
        if (!src || (src.i === 2 && src.p !== dst.p)) ILL();
        if (mn === 'add') return E([dst.p, 0x09 | (src.i << 4)]);
        if (dst.p) ILL();
        if (mn === 'adc') return E([0xed, 0x4a | (src.i << 4)]);
        if (mn === 'sbc') return E([0xed, 0x42 | (src.i << 4)]);
        ILL();
      }
      let src;
      if (ops.length === 2) { if (!isReg(a, 'a')) ILL(); src = b; } else { nOps(1); src = a; }
      const x = this.z80R8(src);
      if (x) return E([x.p, 0x80 | (alu << 3) | x.c, disp(x)]);
      if (src.k === 'imm') return E([0xc6 | (alu << 3), { n: src.v }]);
      ILL();
    }

    if (mn in Z80_ROT) {
      nOps(1);
      const x = this.z80R8(a);
      if (!x || x.half) ILL();
      const op = (Z80_ROT[mn] << 3) | x.c;
      return x.p ? E([x.p, 0xcb, { d: x.d }, op]) : E([0xcb, op]);
    }

    if (mn in Z80_BIT) {
      nOps(2);
      if (a.k !== 'imm') ILL();
      const bit = this.toInt(a.v);
      if (bit < 0 || bit > 7) this.err('Bit number out of range (0..7).');
      const x = this.z80R8(b);
      if (!x || x.half) ILL();
      const op = Z80_BIT[mn] | (bit << 3) | x.c;
      return x.p ? E([x.p, 0xcb, { d: x.d }, op]) : E([0xcb, op]);
    }

    switch (mn) {
      case 'ld': {
        nOps(2);
        const x = this.z80R8(a), y = this.z80R8(b);
        if (x && y) {
          if (x.mem && y.mem) ILL();
          const hl = z => !z.p && (z.c === 4 || z.c === 5);
          if (x.p && y.p && (x.p !== y.p || x.mem || y.mem)) ILL();
          if ((x.half && hl(y)) || (y.half && hl(x))) ILL();
          const m = x.mem ? x : y.mem ? y : null;
          if (m && (x.half || y.half)) ILL();
          return E([x.p || y.p, 0x40 | (x.c << 3) | y.c, m ? disp(m) : undefined]);
        }
        if (x && b.k === 'imm') return E([x.p, 0x06 | (x.c << 3), disp(x), { n: b.v }]);
        if (isReg(a, 'a')) {
          if (b.k === 'ind' && b.name === 'bc') return E([0x0a]);
          if (b.k === 'ind' && b.name === 'de') return E([0x1a]);
          if (b.k === 'mem') return E([0x3a, { nn: b.v }]);
          if (isReg(b, 'i')) return E([0xed, 0x57]);
          if (isReg(b, 'r')) return E([0xed, 0x5f]);
        }
        if (isReg(b, 'a')) {
          if (a.k === 'ind' && a.name === 'bc') return E([0x02]);
          if (a.k === 'ind' && a.name === 'de') return E([0x12]);
          if (a.k === 'mem') return E([0x32, { nn: a.v }]);
          if (isReg(a, 'i')) return E([0xed, 0x47]);
          if (isReg(a, 'r')) return E([0xed, 0x4f]);
        }
        const rpA = this.z80RP(a);
        if (rpA) {
          if (b.k === 'imm') return E([rpA.p, 0x01 | (rpA.i << 4), { nn: b.v }]);
          if (b.k === 'mem') return rpA.i === 2 ? E([rpA.p, 0x2a, { nn: b.v }]) : E([0xed, 0x4b | (rpA.i << 4), { nn: b.v }]);
          if (rpA.i === 3) { const s = this.z80RP(b); if (s && s.i === 2) return E([s.p, 0xf9]); }
        }
        const rpB = this.z80RP(b);
        if (a.k === 'mem' && rpB) return rpB.i === 2 ? E([rpB.p, 0x22, { nn: a.v }]) : E([0xed, 0x43 | (rpB.i << 4), { nn: a.v }]);
        ILL();
        break;
      }
      case 'push': case 'pop': {
        nOps(1);
        const x = this.z80RP(a, true);
        if (!x) ILL();
        return E([x.p, (mn === 'push' ? 0xc5 : 0xc1) | (x.i << 4)]);
      }
      case 'ex':
        nOps(2);
        if (isReg(a, 'de') && isReg(b, 'hl')) return E([0xeb]);
        if (isReg(a, 'af') && isReg(b, "af'")) return E([0x08]);
        if (a.k === 'ind' && a.name === 'sp') { const x = this.z80RP(b); if (x && x.i === 2) return E([x.p, 0xe3]); }
        ILL();
        break;
      case 'inc': case 'dec': {
        nOps(1);
        const x = this.z80R8(a);
        if (x) return E([x.p, (mn === 'inc' ? 0x04 : 0x05) | (x.c << 3), disp(x)]);
        const y = this.z80RP(a);
        if (y) return E([y.p, (mn === 'inc' ? 0x03 : 0x0b) | (y.i << 4)]);
        ILL();
        break;
      }
      case 'jp':
        if (ops.length === 1) {
          if (a.k === 'ind' && a.name === 'hl') return E([0xe9]);
          if (a.k === 'idx' && a.plain) return E([a.p, 0xe9]);
          if (a.k === 'imm') return E([0xc3, { nn: a.v }]);
          ILL();
        }
        nOps(2);
        if (cc(a) < 0 || b.k !== 'imm') ILL();
        return E([0xc2 | (cc(a) << 3), { nn: b.v }]);
      case 'call':
        if (ops.length === 1) { if (a.k !== 'imm') ILL(); return E([0xcd, { nn: a.v }]); }
        nOps(2);
        if (cc(a) < 0 || b.k !== 'imm') ILL();
        return E([0xc4 | (cc(a) << 3), { nn: b.v }]);
      case 'jr':
        if (ops.length === 1) { if (a.k !== 'imm') ILL(); return E([0x18, { rel: a.v }]); }
        nOps(2);
        if (cc(a) < 0 || cc(a) > 3 || b.k !== 'imm') ILL();
        return E([0x20 | (cc(a) << 3), { rel: b.v }]);
      case 'djnz':
        nOps(1);
        if (a.k !== 'imm') ILL();
        return E([0x10, { rel: a.v }]);
      case 'ret':
        if (ops.length === 0) return E([0xc9]);
        nOps(1);
        if (cc(a) < 0) ILL();
        return E([0xc0 | (cc(a) << 3)]);
      case 'rst': {
        nOps(1);
        if (a.k !== 'imm') ILL();
        const v = this.toInt(a.v);
        if (!a.v.u && (v & ~0x38) !== 0) this.err('Illegal RST address (must be $00, $08, ... $38).');
        return E([0xc7 | (v & 0x38)]);
      }
      case 'im': {
        nOps(1);
        if (a.k !== 'imm') ILL();
        const op = [0x46, 0x56, 0x5e][this.toInt(a.v)];
        if (op === undefined) this.err('Illegal interrupt mode (0, 1 or 2).');
        return E([0xed, op]);
      }
      case 'in':
        if (ops.length === 1 && a.k === 'ind' && a.name === 'c') return E([0xed, 0x70]);
        nOps(2);
        if (isReg(a, 'a') && b.k === 'mem') return E([0xdb, { n: b.v }]);
        if (b.k === 'ind' && b.name === 'c') {
          if (isReg(a, 'f')) return E([0xed, 0x70]);
          const x = this.z80R8(a);
          if (x && !x.p && !x.mem) return E([0xed, 0x40 | (x.c << 3)]);
        }
        ILL();
        break;
      case 'out':
        nOps(2);
        if (a.k === 'mem' && isReg(b, 'a')) return E([0xd3, { n: a.v }]);
        if (a.k === 'ind' && a.name === 'c') {
          if (b.k === 'imm' && this.toInt(b.v) === 0) return E([0xed, 0x71]);
          const x = this.z80R8(b);
          if (x && !x.p && !x.mem) return E([0xed, 0x41 | (x.c << 3)]);
        }
        ILL();
        break;
    }
    ILL();
  },
});

// Z80 disassembler (output re-assembles with the assembler above)
const ZR = ['b', 'c', 'd', 'e', 'h', 'l', '(hl)', 'a'];
const ZRP = ['bc', 'de', 'hl', 'sp'];
const ZRP2 = ['bc', 'de', 'hl', 'af'];
const ZALU = ['add a,', 'adc a,', 'sub ', 'sbc a,', 'and ', 'xor ', 'or ', 'cp '];
const ZROT = ['rlc', 'rrc', 'rl', 'rr', 'sla', 'sra', 'sll', 'srl'];
const ZBLOCK = [['ldi', 'cpi', 'ini', 'outi'], ['ldd', 'cpd', 'ind', 'outd'], ['ldir', 'cpir', 'inir', 'otir'], ['lddr', 'cpdr', 'indr', 'otdr']];
const TRUNC = {};

function decodeZ80(get, a) {
  const op0 = get(0);
  const h2 = v => '$' + hex2(v);
  const h4 = v => '$' + hex4(v & 0xffff);
  const sd = d => (d < 128 ? d : d - 256);
  if (op0 === 0xcb) {
    const op = get(1);
    if (op === undefined) throw TRUNC;
    const x = op >> 6, y = (op >> 3) & 7, z = op & 7;
    return { len: 2, text: x === 0 ? `${ZROT[y]} ${ZR[z]}` : `${['', 'bit', 'res', 'set'][x]} ${y},${ZR[z]}` };
  }
  if (op0 === 0xed) {
    const op = get(1);
    if (op === undefined) throw TRUNC;
    const x = op >> 6, y = (op >> 3) & 7, z = op & 7, q = y & 1, p = y >> 1;
    const nn = () => { const lo = get(2), hi = get(3); if (hi === undefined) throw TRUNC; return h4(lo | (hi << 8)); };
    if (x === 1) {
      switch (z) {
        case 0: return { len: 2, text: y === 6 ? 'in (c)' : `in ${ZR[y]},(c)` };
        case 1: return { len: 2, text: y === 6 ? 'out (c),0' : `out (c),${ZR[y]}` };
        case 2: return { len: 2, text: `${q ? 'adc' : 'sbc'} hl,${ZRP[p]}` };
        case 3: if (p === 2) return null; return { len: 4, text: q ? `ld ${ZRP[p]},(${nn()})` : `ld (${nn()}),${ZRP[p]}` };
        case 4: return y === 0 ? { len: 2, text: 'neg' } : null;
        case 5: return y === 0 ? { len: 2, text: 'retn' } : y === 1 ? { len: 2, text: 'reti' } : null;
        case 6: { const m = { 0: 0, 2: 1, 3: 2 }[y]; return m === undefined ? null : { len: 2, text: `im ${m}` }; }
        case 7: { const t = ['ld i,a', 'ld r,a', 'ld a,i', 'ld a,r', 'rrd', 'rld'][y]; return t ? { len: 2, text: t } : null; }
      }
    }
    if (x === 2 && z <= 3 && y >= 4) return { len: 2, text: ZBLOCK[y - 4][z] };
    return null;
  }
  let ix = null, p0 = 0;
  if (op0 === 0xdd || op0 === 0xfd) {
    ix = op0 === 0xdd ? 'ix' : 'iy';
    p0 = 1;
    if (get(1) === 0xcb) {
      const d = get(2), op = get(3);
      if (op === undefined) throw TRUNC;
      const x = op >> 6, y = (op >> 3) & 7, z = op & 7;
      if (z !== 6) return null;
      const m = `(${ix}${sd(d) < 0 ? '-' : '+'}${h2(Math.abs(sd(d)))})`;
      return { len: 4, text: x === 0 ? `${ZROT[y]} ${m}` : `${['', 'bit', 'res', 'set'][x]} ${y},${m}` };
    }
  }
  let pos = p0;
  const op = get(pos);
  if (op === undefined) throw TRUNC;
  pos++;
  if (ix && (op === 0xdd || op === 0xfd || op === 0xed || op === 0xcb)) return null;
  let used = false, disp = null;
  const D = () => {
    if (disp === null) { const d = get(pos); if (d === undefined) throw TRUNC; pos++; disp = sd(d); }
    return `(${ix}${disp < 0 ? '-' : '+'}${h2(Math.abs(disp))})`;
  };
  const R = (k, plain) => {
    if (ix && k === 6) { used = true; return D(); }
    if (ix && !plain && (k === 4 || k === 5)) { used = true; return ix + (k === 4 ? 'h' : 'l'); }
    return ZR[k];
  };
  const HL = () => { if (ix) { used = true; return ix; } return 'hl'; };
  const RP = k => (k === 2 ? HL() : ZRP[k]);
  const RP2 = k => (k === 2 ? HL() : ZRP2[k]);
  const n = () => { const v = get(pos); if (v === undefined) throw TRUNC; pos++; return h2(v); };
  const nn = () => { const lo = get(pos), hi = get(pos + 1); if (hi === undefined) throw TRUNC; pos += 2; return h4(lo | (hi << 8)); };
  const rel = () => { const d = get(pos); if (d === undefined) throw TRUNC; pos++; return h4(a + pos + sd(d)); };
  const x = op >> 6, y = (op >> 3) & 7, z = op & 7, q = y & 1, p = y >> 1;
  let t;
  if (x === 0) {
    switch (z) {
      case 0: t = y === 0 ? 'nop' : y === 1 ? "ex af,af'" : y === 2 ? `djnz ${rel()}` : y === 3 ? `jr ${rel()}` : `jr ${Z80_CC[y - 4]},${rel()}`; break;
      case 1: t = q ? `add ${HL()},${RP(p)}` : `ld ${RP(p)},${nn()}`; break;
      case 2:
        if (q === 0) t = p === 0 ? 'ld (bc),a' : p === 1 ? 'ld (de),a' : p === 2 ? `ld (${nn()}),${HL()}` : `ld (${nn()}),a`;
        else t = p === 0 ? 'ld a,(bc)' : p === 1 ? 'ld a,(de)' : p === 2 ? `ld ${HL()},(${nn()})` : `ld a,(${nn()})`;
        break;
      case 3: t = `${q ? 'dec' : 'inc'} ${RP(p)}`; break;
      case 4: t = `inc ${R(y)}`; break;
      case 5: t = `dec ${R(y)}`; break;
      case 6: { const r = R(y); t = `ld ${r},${n()}`; break; }
      case 7: t = ['rlca', 'rrca', 'rla', 'rra', 'daa', 'cpl', 'scf', 'ccf'][y]; break;
    }
  } else if (x === 1) {
    if (y === 6 && z === 6) t = 'halt';
    else { const d = R(y, z === 6); t = `ld ${d},${R(z, y === 6)}`; }
  } else if (x === 2) t = ZALU[y] + R(z);
  else {
    switch (z) {
      case 0: t = `ret ${Z80_CC[y]}`; break;
      case 1: t = q === 0 ? `pop ${RP2(p)}` : p === 0 ? 'ret' : p === 1 ? 'exx' : p === 2 ? `jp (${HL()})` : `ld sp,${HL()}`; break;
      case 2: t = `jp ${Z80_CC[y]},${nn()}`; break;
      case 3: t = y === 0 ? `jp ${nn()}` : y === 2 ? `out (${n()}),a` : y === 3 ? `in a,(${n()})` : y === 4 ? `ex (sp),${HL()}` : y === 5 ? 'ex de,hl' : y === 6 ? 'di' : 'ei'; break;
      case 4: t = `call ${Z80_CC[y]},${nn()}`; break;
      case 5: t = q === 0 ? `push ${RP2(p)}` : `call ${nn()}`; break;
      case 6: t = ZALU[y] + n(); break;
      case 7: t = `rst ${h2(y * 8)}`; break;
    }
  }
  if (ix && !used) return null;
  return { len: pos, text: t };
}

function disassembleZ80(bytes, addr) {
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    const a = (addr + i) & 0xffff;
    let res = null;
    try { res = decodeZ80(k => (i + k < bytes.length ? bytes[i + k] : undefined), a); } catch (e) { if (e !== TRUNC) throw e; }
    if (!res) { out.push({ addr: a, bytes: [bytes[i]], text: `!byte $${hex2(bytes[i])}` }); i++; continue; }
    out.push({ addr: a, bytes: Array.from(bytes.slice(i, i + res.len)), text: res.text });
    i += res.len;
  }
  return out;
}
