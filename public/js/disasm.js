// disasm.js - the analysis of the Disassembler view: which bytes of a binary are code and which are
// data, the lines of the disassembly with labels, and the disassembly as ACME source that assembles
// to the same bytes again.
//
// The user marks ranges (regions: { start, end, type }, offsets into the bytes, end included) as code
// or as data of a type. In auto mode the rest is found by tracing the code from its entry points (the
// SYS of a BASIC line, the load address or the vectors of a cartridge, the entries the user adds, the
// starts of the code regions): what the trace reaches is code, the runs of printable bytes are text,
// the rest bytes. Without auto mode every byte that is not marked is code, disassembled from the start.
//
// The addresses of the machine (memmap.js) name the operands - sta VIC_BORDER - and a value stored to
// a register is told in words: lda #$1b / sta VIC_CTRL1 ; y scroll 3 · rows 25 · screen on. The 65816
// is followed through rep and sep: the size of its immediates. A cartridge has a header before the
// code (head) and data after it that the CPU does not see at these addresses (from split on: the CHR
// ROM of the NES, the banks of the SNES after the first).

import { disassemble, convPet, convScr } from './acme/acme.js';
import { symbolsFor, decodeBits } from './memmap.js';
import { detokenize } from './basic/basic.js';
import { platformOf } from './platforms.js';

export const hex2 = n => n.toString(16).padStart(2, '0');
export const hex4 = n => n.toString(16).padStart(4, '0');

// the types of the data, and what a line of each holds
export const DATA_TYPES = {
  bytes: { name: 'Bytes', per: 8 },
  words: { name: 'Words', per: 8 },
  text: { name: 'Text (ASCII)', per: 32 },
  petscii: { name: 'Text (PETSCII)', per: 32 },
  screen: { name: 'Screen codes', per: 32 },
  chars: { name: 'Chars', per: 1 },
  sprites: { name: 'Sprites', per: 3 },
  bitmap: { name: 'Bitmap', per: 8 },
  tiles: { name: 'Tiles (NES, SNES)', per: 8 },
  basic: { name: 'BASIC', per: 8 },
};
export const TYPES = ['code', ...Object.keys(DATA_TYPES)];
export const typeName = t => (t === 'code' ? 'Code' : DATA_TYPES[t]?.name ?? t);

const z80 = cpu => String(cpu).toLowerCase() === 'z80';
const w816 = cpu => String(cpu) === '65816';
const FLAGS = { m8: true, x8: true };                    // the 65816 after a reset: 8 bit registers

// --- regions ------------------------------------------------------------------------------------

// the regions with [a, b] marked as type ('none': unmarked): what overlaps is cut away, neighbours
// of the same type are joined
export function markRange(regions, a, b, type) {
  if (a > b) [a, b] = [b, a];
  const out = [];
  for (const r of regions) {
    if (r.end < a || r.start > b) { out.push({ ...r }); continue; }
    if (r.start < a) out.push({ ...r, end: a - 1 });
    if (r.end > b) out.push({ ...r, start: b + 1 });
  }
  if (type && type !== 'none') out.push({ start: a, end: b, type });
  out.sort((x, y) => x.start - y.start);
  const joined = [];
  for (const r of out) {
    const last = joined[joined.length - 1];
    if (last && last.type === r.type && last.end + 1 === r.start) last.end = r.end;
    else joined.push(r);
  }
  return joined;
}

// --- entry points ---------------------------------------------------------------------------------

// the BASIC starts of the Commodores (the C128 with a graphics area at $4001)
const BASIC_STARTS = [0x0401, 0x0801, 0x1001, 0x1201, 0x1c01, 0x4001];

// a BASIC program at the start of data: the chain of its lines - each linked to the next, its number
// higher than the one before, ended by a 0 just before the next line - up to the link of 0. Looked for
// at the BASIC starts, and at any address on a Commodore (any). { end, lines: [{ off, len, number,
// text, sys }], sys: [the addresses of its SYS] } or null
export function detectBasic(data, base, { dialect = 'v2', any = false } = {}) {
  if (!any && !BASIC_STARTS.includes(base)) return null;
  const lines = [], sys = [];
  let at = 0, last = -1;
  for (let guard = 0; guard < 4000; guard++) {
    if (at + 2 > data.length) return null;
    const link = data[at] | data[at + 1] << 8;
    if (!link) return lines.length ? { end: at + 2, lines, sys } : null;
    const next = link - base, number = data[at + 2] | data[at + 3] << 8;
    if (next <= at + 4 || next > data.length || data[next - 1] !== 0 || number <= last || number > 63999) return null;
    const own = [];
    for (let k = at + 4; k < next - 1; k++) {
      if (!data[k]) return null;                                      // no 0 inside a line
      if (data[k] !== 0x9e) continue;                                 // SYS 2061, SYS(2061)
      let d = k + 1, s = '';
      while (data[d] === 0x20 || data[d] === 0x28) d++;
      while (data[d] >= 0x30 && data[d] <= 0x39) s += String.fromCharCode(data[d++]);
      if (s && Number(s) < 0x10000) own.push(Number(s));
    }
    const text = detokenize(Uint8Array.from([base & 0xff, base >> 8, ...data.subarray(at, next), 0, 0]), { dialect }).trim();
    lines.push({ off: at, len: next - at, number, text, sys: own });
    sys.push(...own);
    last = number;
    at = next;
  }
  return null;
}

// the address of the first SYS of a BASIC program at base, or null
export const basicSys = (data, base, opts) => detectBasic(data, base, opts)?.sys[0] ?? null;

// a .prg is a program of a Commodore: the machine by the start of its BASIC
const PRG_MACHINES = { 0x0801: 'c64', 0x1c01: 'c128', 0x1001: 'vic20', 0x1201: 'vic20', 0x0401: 'pet' };

// the layout of a file by its name: { head, base, split, entries, cpu?, note } - head: the bytes before the
// code (a load address, a cartridge header), base: the address of the first byte after them, split:
// where what the CPU sees ends, entries: from the vectors of a cartridge
export function fileLayout(name, bytes) {
  const n = bytes.length, word = o => bytes[o] | bytes[o + 1] << 8;
  if (/\.prg$/i.test(name) && n > 2) return { head: 2, base: word(0), split: n - 2, entries: [], source: 'prg', machine: PRG_MACHINES[word(0)] ?? 'c64' };
  const cart = cartLayout(name, bytes);
  return cart && { ...cart, machine: /\.nes$/i.test(name) ? 'nes' : /\.a26$/i.test(name) ? 'vcs' : 'snes' };
}
function cartLayout(name, bytes) {
  const n = bytes.length, word = o => bytes[o] | bytes[o + 1] << 8;
  if (/\.nes$/i.test(name) && n > 16 && bytes[0] === 0x4e && bytes[1] === 0x45 && bytes[2] === 0x53 && bytes[3] === 0x1a) {
    const trainer = bytes[6] & 4 ? 512 : 0, prg = bytes[4] * 0x4000, head = 16 + trainer;
    const size = Math.min(prg, 0x8000, n - head), base = 0x10000 - size;
    const v = head + Math.min(prg, n - head) - 6;              // the vectors at the end of the last bank
    const entries = [word(v), word(v + 2), word(v + 4)].filter(a => a >= base);
    return { head, base, split: size, entries: [...new Set(entries)], cpu: '6502', note: `iNES: ${bytes[4]} × 16K PRG, ${bytes[5]} × 8K CHR, mapper ${(bytes[6] >> 4) | (bytes[7] & 0xf0)}` };
  }
  if (/\.(sfc|smc)$/i.test(name) && n >= 0x8000) {
    const head = n % 1024 === 512 ? 512 : 0;                  // a copier header
    const v = head + 0x7fe0, size = Math.min(0x8000, n - head);
    const entries = [word(v + 0x1c), word(v + 0x0a), word(v + 0x0e)].filter(a => a >= 0x8000);   // reset, native NMI, native IRQ
    return { head, base: 0x8000, split: size, entries: [...new Set(entries)], cpu: '65816', note: `LoROM, ${(n - head) >> 10}K - the first bank at $8000` };
  }
  if (/\.a26$/i.test(name) && n >= 2048 && n <= 4096) {
    const base = 0x10000 - n;
    return { head: 0, base, split: n, entries: [base + (word(n - 4) & (n - 1))], cpu: '6502' };
  }
  return null;
}

// --- one instruction ------------------------------------------------------------------------------

// the instruction at offset off: { len, text, mn, addrs, jumps, flow: 'next'|'stop', flags (after) }, or null
function decode(data, off, base, cpu, flags = FLAGS) {
  const f = { ...flags };
  const ins = disassemble(data.subarray(off, off + 5), (base + off) & 0xffff, cpu, f)[0];
  if (!ins || ins.text.startsWith('!byte')) return null;
  const text = ins.text, mn = text.split(' ')[0].toLowerCase(), arg = text.slice(mn.length).trim();
  // the addresses of the operand: 16 bits, or 24 bits in bank $00 / $80
  const addrs = [...text.matchAll(/(#?)\$([0-9a-f]+)/gi)].filter(m => !m[1] && m[2].length >= 4)
    .map(m => { const v = parseInt(m[2], 16); return m[2].length === 6 ? ((v >> 16) & 0x7f ? null : v & 0xffff) : v; }).filter(a => a != null);
  const target = addrs[addrs.length - 1];
  let flow = 'next', jumps = [];
  if (z80(cpu)) {
    const cond = arg.includes(',');
    if (mn === 'jp') { if (arg.includes('(')) flow = 'stop'; else { jumps = [target]; if (!cond) flow = 'stop'; } }
    else if (mn === 'jr' || mn === 'djnz' || mn === 'call') { jumps = [target]; if (mn === 'jr' && !cond) flow = 'stop'; }
    else if (mn === 'ret') { if (!arg) flow = 'stop'; }
    else if (mn === 'reti' || mn === 'retn') flow = 'stop';
  } else if (/^(bcc|bcs|beq|bmi|bne|bpl|bvc|bvs|bbr\d|bbs\d|jsr|jsl|bsr|lb(cc|cs|eq|mi|ne|pl|vc|vs))$/.test(mn)) jumps = [target];
  else if (mn === 'jmp' || mn === 'jml') { if (!/^[([]/.test(arg)) jumps = [target]; flow = 'stop'; }
  else if (mn === 'bra' || mn === 'brl' || mn === 'lbra') { jumps = [target]; flow = 'stop'; }
  else if (/^(rts|rti|rtl|rtn|brk|stp)$/.test(mn)) flow = 'stop';
  return { len: ins.bytes.length, text, mn, arg, addrs, jumps: jumps.filter(x => x != null), flow, flags: f, before: { ...flags } };
}

// --- the classification ---------------------------------------------------------------------------

const printable = b => b >= 0x20 && b < 0x7f;

// the type of every byte: 'code' or a type of DATA_TYPES; marked: the bytes the user marked;
// starts: the offsets where the trace found instructions (with the 65816 flags there); entries: the
// addresses it started from
export function classify(data, { base = 0, cpu = '6502', regions = [], entries = [], auto = true, split = data.length, noBase = false, machine = null } = {}) {
  const n = data.length;
  const types = new Array(n).fill(null), marked = new Uint8Array(n);
  for (const r of regions) for (let i = Math.max(0, r.start); i <= Math.min(n - 1, r.end); i++) { types[i] = r.type; marked[i] = 1; }
  for (let i = split; i < n; i++) if (types[i] === 'code' || types[i] == null) types[i] = types[i] === 'code' || !auto ? 'bytes' : null;
  const starts = new Map();
  // a BASIC program at the start (a Commodore's): its lines, its SYS the entries; no code at the load address
  const p = machine ? platformOf(machine) : null, commodore = p?.family === 'commodore';
  const basic = cpu !== 'z80' && cpu !== '65816' ? detectBasic(data, base, { dialect: commodore ? p.basic[0] ?? 'v2' : 'v2', any: commodore }) : null;
  if (basic) for (let i = 0; i < basic.end; i++) types[i] ??= 'basic';
  const sys = (basic?.sys ?? []).filter(a => a >= base + (basic?.end ?? 0) && a < base + split);
  const found = [...new Set([...entries, ...sys, ...(!basic && !noBase ? [base] : [])])];
  if (!auto) {
    for (let i = 0; i < n; i++) types[i] ??= 'code';
    return { types, marked, starts, entries: found, basic };
  }
  const seen = new Uint8Array(n);
  const queue = [...found.map(a => ({ off: a - base, flags: FLAGS })), ...regions.filter(r => r.type === 'code').map(r => ({ off: r.start, flags: FLAGS }))];
  while (queue.length) {
    let { off, flags } = queue.pop();
    while (off >= 0 && off < split && !starts.has(off)) {
      const ins = decode(data, off, base, cpu, flags);
      if (!ins || off + ins.len > split) break;
      let blocked = false;
      for (let k = 0; k < ins.len; k++) if (marked[off + k] && types[off + k] !== 'code') blocked = true;
      if (blocked) break;
      starts.set(off, ins.before);
      for (let k = 0; k < ins.len; k++) seen[off + k] = 1;
      for (const t of ins.jumps) queue.push({ off: t - base, flags: ins.flags });
      if (ins.flow === 'stop') break;
      flags = ins.flags;
      off += ins.len;
    }
  }
  for (let i = 0; i < n; i++) if (!marked[i] && seen[i] && types[i] !== 'basic') types[i] = 'code';
  // the rest: runs of 6 printable bytes and more are text, else bytes
  const end = basic?.end ?? 0;
  for (let i = 0; i < n;) {
    if (types[i] != null) { i++; continue; }
    let k = i;
    while (k < n && types[k] == null && printable(data[k]) && (k !== split || k === i)) k++;
    const run = k - i >= 6 && i >= end && i < split;
    for (let j = i; j < Math.max(k, i + 1); j++) types[j] = run ? 'text' : 'bytes';
    i = Math.max(k, i + 1);
  }
  return { types, marked, starts, entries: found, basic };
}

// --- the lines ------------------------------------------------------------------------------------

const PET = invert(convPet), SCR = invert(convScr);
function invert(conv) {
  const map = new Map();
  for (let c = 0x20; c < 0x7f; c++) if (c !== 0x22 && c !== 0x5c && !map.has(conv(c) & 0xff)) map.set(conv(c) & 0xff, String.fromCharCode(c));
  return map;
}
const ASCII = new Map([...Array(0x5f)].map((_, k) => k + 0x20).filter(c => c !== 0x22 && c !== 0x5c && c !== 0x7f).map(c => [c, String.fromCharCode(c)]));

// bytes as an argument list of ACME: "the text", $0d, "more"
function textArgs(bytes, map) {
  const parts = [];
  let s = '';
  for (const b of bytes) {
    const c = map.get(b);
    if (c != null) { s += c; continue; }
    if (s) { parts.push(`"${s}"`); s = ''; }
    parts.push('$' + hex2(b));
  }
  if (s) parts.push(`"${s}"`);
  return parts.join(', ');
}

const bin = b => '%' + b.toString(2).padStart(8, '0');
const WRITES = new Set(['sta', 'stx', 'sty', 'stz', 'inc', 'dec', 'asl', 'lsr', 'rol', 'ror', 'trb', 'tsb']);
const NO_SYMBOLS = new Set(['mvn', 'mvp', 'rep', 'sep', 'cop', 'wdm', 'brk', 'pea', 'pei', 'per']);

// the values the registers hold, as far as the straight code shows them
function track(regs, mn, arg, width) {
  const imm = /^#\$([0-9a-f]+)$/i.exec(arg)?.[1];
  const v = imm != null ? parseInt(imm, 16) : null;
  const known = x => x != null;
  switch (mn) {
    case 'lda': regs.a = v; return;
    case 'ldx': regs.x = v; return;
    case 'ldy': regs.y = v; return;
    case 'tax': regs.x = regs.a; return;
    case 'tay': regs.y = regs.a; return;
    case 'txa': regs.a = regs.x; return;
    case 'tya': regs.a = regs.y; return;
    case 'txy': regs.y = regs.x; return;
    case 'tyx': regs.x = regs.y; return;
    case 'inx': case 'dex': if (known(regs.x)) regs.x = (regs.x + (mn === 'inx' ? 1 : -1)) & width; return;
    case 'iny': case 'dey': if (known(regs.y)) regs.y = (regs.y + (mn === 'iny' ? 1 : -1)) & width; return;
    case 'ora': regs.a = known(regs.a) && known(v) ? regs.a | v : null; return;
    case 'and': regs.a = known(regs.a) && known(v) ? regs.a & v : null; return;
    case 'eor': regs.a = known(regs.a) && known(v) ? regs.a ^ v : null; return;
    case 'jsr': case 'jsl': case 'brk': case 'cop': regs.a = regs.x = regs.y = null; return;
    case 'asl': case 'lsr': case 'rol': case 'ror': case 'inc': case 'dec': if (!arg) regs.a = null; return;
    case 'adc': case 'sbc': case 'pla': case 'xba': case 'tdc': case 'tsc': regs.a = null; return;
    case 'tsx': case 'plx': regs.x = null; return;
    case 'ply': regs.y = null; return;
  }
}

// the disassembly: { lines, labels: Map(address -> name), symbols: Map(name -> { addr, desc }), types,
// marked, starts, entries, split }; a line is { off, len, addr, type, label, text, comment, ref, sym,
// value, flags } - ref: the offset an operand points to, sym: the register of the machine it names,
// value: what is stored there, flags: the 65816 flags it was read with
export function disassembleAll(data, opts = {}) {
  const { base = 0, cpu = '6502', machine = null, split = data.length } = opts;
  const n = data.length;
  const cls = classify(data, { ...opts, split });
  const { types } = cls;
  const syms = machine ? symbolsFor(machine) : null;
  const inside = a => a >= Math.max(base, 0x100) && a < base + split;

  // the code: the instructions of the runs of code, and the addresses they point to
  const code = [], refs = new Set(cls.entries.filter(inside));
  let flags = FLAGS;
  for (let i = 0; i < n;) {
    if (types[i] !== 'code') { i++; flags = FLAGS; continue; }
    flags = cls.starts.get(i) ?? flags;
    const ins = decode(data, i, base, cpu, flags);
    let len = ins?.len ?? 1;
    if (ins) for (let k = 1; k < len; k++) if (types[i + k] !== 'code' || i + k >= split) { len = 0; break; }
    if (!ins || !len) { code.push({ off: i, len: 1, ins: null }); i++; continue; }
    code.push({ off: i, len, ins });
    for (const a of ins.addrs) if (inside(a)) refs.add(a);
    flags = ins.flags;
    i += len;
  }
  // the words that point into the bytes
  for (let i = 0; i + 1 < split; i++) if (types[i] === 'words' && types[i + 1] === 'words') {
    const w = data[i] | data[i + 1] << 8;
    if (inside(w)) refs.add(w);
    i++;
  }
  // a name the user gave an address: a label there, whether something points to it or not
  for (const a of Object.keys(opts.names ?? {}).map(k => parseInt(k, 16))) if (a >= base && a < base + split) refs.add(a);
  const refOffs = new Set([...refs].map(a => a - base));

  // the lines: the code as decoded, the data in lines of its type, broken where a label is; BASIC by its lines
  const lines = [];
  const basicAt = new Map((cls.basic?.lines ?? []).map(b => [b.off, b]));
  let c = 0;
  for (let i = 0; i < n;) {
    const t = types[i];
    if (t === 'code') {
      const x = code[c++];
      lines.push({ off: x.off, len: x.len, type: 'code', ins: x.ins });
      i += x.len;
      continue;
    }
    const per = DATA_TYPES[t]?.per ?? 8;
    const bl = t === 'basic' ? basicAt.get(i) : null;
    if (bl && bl.len <= n - i) { lines.push({ off: i, len: bl.len, type: t, basic: bl }); i += bl.len; continue; }
    let k = i + 1;
    while (k < n && types[k] === t && k - i < per && !refOffs.has(k) && k !== split) k++;
    if (t === 'words' && (k - i) % 2 && k - i > 1) k--;                 // whole words, the odd byte by itself
    lines.push({ off: i, len: k - i, type: t });
    i = k;
  }

  // the labels: at the start of a line, else the label of its line and the distance
  const labels = new Map(), symbols = new Map();
  const starts = lines.map(l => l.off);
  const lineOf = off => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= off) lo = m; else hi = m - 1; } return lines[lo]; };
  // the user's names (opts.names: { 'c000': 'main' }), else l_c000 for code and d_c000 for data
  const nameOf = off => opts.names?.[hex4((base + off) & 0xffff)] ?? `${types[off] === 'code' ? 'l' : 'd'}_${hex4((base + off) & 0xffff)}`;
  const expr = a => {
    const l = lineOf(a - base);
    if (!l.label) { l.label = nameOf(l.off); labels.set((base + l.off) & 0xffff, l.label); }
    return l.off === a - base ? l.label : `${l.label}+${a - base - l.off}`;
  };
  for (const off of refOffs) expr(base + off);
  // a register or area of the machine: its name, and the name kept for the equates of the source
  const symbol = (a, read, small) => {
    const s = syms?.at(a, read);
    if (!s || (small && s.sym.size > 16)) return null;               // the zero page: registers and small areas only
    symbols.set(s.name, { addr: s.sym.addr, desc: s.desc });
    return { text: s.offset ? `${s.name}+${s.offset}` : s.name, name: s.name, desc: s.desc, addr: a, offset: s.offset };
  };

  let regs = { a: null, x: null, y: null };
  for (const l of lines) {
    l.addr = (base + l.off) & 0xffff;
    const bytes = data.subarray(l.off, l.off + l.len);
    if (l.type === 'code') {
      if (l.label) regs = { a: null, x: null, y: null };              // something jumps here: nothing known
      const ins = l.ins;
      delete l.ins;
      if (!ins) { l.text = `!byte $${hex2(bytes[0])}`; l.comment = 'not an instruction'; regs = { a: null, x: null, y: null }; continue; }
      l.flags = ins.before;
      const write = WRITES.has(ins.mn) && !!ins.arg;
      let sym = null;
      l.text = ins.text.replace(/(#?)\$([0-9a-f]+)/gi, (m, hash, h) => {
        if (hash || z80(cpu) && h.length < 4 || NO_SYMBOLS.has(ins.mn) || /,s/.test(ins.arg)) return m;
        const v = parseInt(h, 16);
        if (h.length === 6) return (ins.mn === 'jsl' || ins.mn === 'jml') && !(v >> 16) && inside(v) ? expr(v) : m;
        if (h.length === 4) {
          if (inside(v)) return expr(v);
          if (v < 0x100) return m;                          // an absolute address in the zero page: as it is
          sym ??= symbol(v, !write, false);
          return sym && sym.addr === v ? sym.text : m;
        }
        sym ??= symbol(v, !write, true);                     // the zero page
        return sym && sym.addr === v ? sym.text : m;
      });
      const to = ins.addrs.find(inside);
      if (to != null) l.ref = to - base;
      const notes = [];
      if (cls.entries.includes(l.addr)) notes.push('entry');
      if (sym) {
        l.sym = sym;
        const store = { sta: regs.a, stx: regs.x, sty: regs.y, stz: 0 }[ins.mn];
        if (store != null && !sym.offset) {
          l.value = store;
          const words = machine && decodeBits(machine, sym.name, store);
          notes.push(words ? `$${hex2(store & 0xff)}: ${words}` : sym.desc);
        } else notes.push(sym.desc);
      }
      if (notes.length) l.comment = notes.join(' · ');
      if (!z80(cpu)) track(regs, ins.mn, ins.arg, w816(cpu) ? 0xffff : 0xff);
      if (ins.flow === 'stop') regs = { a: null, x: null, y: null };
      continue;
    }
    switch (l.type) {
      case 'words': {
        const ws = [];
        for (let k = 0; k + 1 < bytes.length; k += 2) {
          const w = bytes[k] | bytes[k + 1] << 8;
          const s = !inside(w) && l.off < split && w >= 0x100 ? symbol(w, true, false) : null;
          ws.push(inside(w) && l.off < split ? expr(w) : s && !s.offset ? s.text : '$' + hex4(w));
        }
        l.text = ws.length ? `!word ${ws.join(', ')}` : `!byte $${hex2(bytes[0])}`;
        const w0 = bytes[0] | bytes[1] << 8;
        if (bytes.length > 1 && inside(w0)) l.ref = w0 - base;
        break;
      }
      case 'basic': {
        l.text = `!byte ${[...bytes].map(b => '$' + hex2(b)).join(', ')}`;
        if (l.basic) {
          const sys = l.basic.sys;
          l.view = l.basic.text.toUpperCase();
          // a SYS in hex too, and the line leads to the code there
          l.note = sys.length ? `SYS ${sys.map(a => '$' + hex4(a)).join(', ')}` : null;
          l.comment = l.note ? `${l.basic.text} · ${l.note}` : l.basic.text;
          const to = sys.find(inside);
          if (to != null) l.ref = to - base;
          delete l.basic;
        }
        else if (cls.basic && l.off === cls.basic.end - 2) l.comment = 'the end of the BASIC program';
        break;
      }
      case 'text': l.text = `!text ${textArgs(bytes, ASCII)}`; break;
      case 'petscii': l.text = `!pet ${textArgs(bytes, PET)}`; break;
      case 'screen': l.text = `!scr ${textArgs(bytes, SCR)}`; break;
      case 'chars': case 'sprites': {
        l.text = `!byte ${[...bytes].map(bin).join(', ')}`;
        const size = l.type === 'chars' ? 8 : 64, at = l.off - regionStart(types, l.off);
        if (at % size === 0) l.comment = `${l.type === 'chars' ? 'char' : 'sprite'} ${at / size}`;
        break;
      }
      default: {
        l.text = `!byte ${[...bytes].map(b => '$' + hex2(b)).join(', ')}`;
        const at = l.off - regionStart(types, l.off);
        if (l.type === 'bitmap' && at % 320 === 0) l.comment = `row ${at / 320}`;
        if (l.type === 'tiles' && at % 16 === 0) l.comment = `tile ${at / 16}`;
      }
    }
  }
  return { lines, labels, symbols, split, ...cls };
}
function regionStart(types, off) {
  const t = types[off];
  while (off > 0 && types[off - 1] === t) off--;
  return off;
}

// the disassembly as ACME source: the names of the machine it uses, the header of a cartridge as
// bytes, what the CPU sees at its addresses (in !pseudopc when there is more), the rest after it
export function toSource(result, { base = 0, cpu = '6502', name = '', machine = null, head = null, format = null } = {}) {
  const out = [`; ${name ? name + ' - ' : ''}disassembled by NerdSuite`, ''];
  const syms = [...result.symbols].sort((a, b) => a[1].addr - b[1].addr);
  if (syms.length) {
    out.push(`; the addresses of the ${machine ?? 'machine'} it uses (all of them: hardware.inc)`);
    for (const [n, s] of syms) out.push(`${n.padEnd(20)}= $${s.addr < 0x100 ? hex2(s.addr) : hex4(s.addr)}    ; ${s.desc}`);
    out.push('');
  }
  out.push(`        !cpu ${z80(cpu) ? 'z80' : cpu}`);
  if (format) out.push(`        !to "${name.replace(/\.[^.]*$/, '')}.${format.ext}", ${format.kind}`);
  const wrapped = !!head?.length || result.split < result.types.length;
  if (wrapped) {
    out.push('        * = $0000', '');
    if (head?.length) {
      out.push('; the header');
      for (let k = 0; k < head.length; k += 16) out.push(`        !byte ${[...head.subarray(k, k + 16)].map(b => '$' + hex2(b)).join(', ')}`);
      out.push('');
    }
    out.push(`        !pseudopc $${hex4(base)} {`);
  } else out.push(`        * = $${hex4(base)}`);
  out.push('');
  let last = null, al = false, rl = false, closed = false;
  for (const l of result.lines) {
    if (wrapped && !closed && l.off >= result.split) {
      out.push('        }', '', '; after what the CPU sees at these addresses');
      closed = true;
    }
    if (last && last !== 'code' && l.type === 'code') out.push('');
    if (l.label) out.push(l.label);
    if (w816(cpu) && l.flags) {
      if (!l.flags.m8 !== al) { al = !l.flags.m8; out.push(`        !a${al ? 'l' : 's'}`); }
      if (!l.flags.x8 !== rl) { rl = !l.flags.x8; out.push(`        !r${rl ? 'l' : 's'}`); }
    }
    out.push(`        ${l.text}${l.comment ? `    ; ${l.comment}` : ''}`);
    last = l.type;
  }
  if (wrapped && !closed) out.push('        }');
  return out.join('\n') + '\n';
}
