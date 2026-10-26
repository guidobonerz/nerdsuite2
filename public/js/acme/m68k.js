// m68k.js - the Motorola 68000 of the ACME compatible assembler (acme.js: !cpu 68000) and its disassembler.
//
// Motorola syntax: move.l d0,(a0)+ · lea label(pc),a0 · move.w (4).w,d0 · movem.l d0-d7/a0-a6,-(sp)
//   sizes     .b .w .l (.s: the short branch); without one .w - moveq, lea, pea and exg are .l, the bit
//             operations .l on a data register and .b in memory
//   branches  Bcc, bra, bsr and DBcc take a word displacement, Bcc.s a byte
//   addresses an absolute address is .w when its value is known and fits a sign extended word, else .l;
//             (addr).w and (addr).l choose; label(pc) and (label,pc) name the target, not the distance
//   data      dc.b/dc.w/dc.l (big endian), ds.b/ds.w/ds.l (zeros), even (to an even address)
//   immediate add, sub, and, or, eor and cmp with #value write addi, subi ... (adda/suba/cmpa to An)

const SIZE_CODE = { b: 0, w: 1, l: 2 };
const SIZE_BYTES = { b: 1, w: 2, l: 4 };
const MOVE_SIZE = { b: 1, w: 3, l: 2 };
const CC = { t: 0, f: 1, hi: 2, ls: 3, cc: 4, hs: 4, cs: 5, lo: 5, ne: 6, eq: 7, vc: 8, vs: 9, pl: 10, mi: 11, ge: 12, lt: 13, gt: 14, le: 15 };
const CC_NAMES = ['t', 'f', 'hi', 'ls', 'cc', 'cs', 'ne', 'eq', 'vc', 'vs', 'pl', 'mi', 'ge', 'lt', 'gt', 'le'];
const ALU = { or: 0x8000, sub: 0x9000, cmp: 0xb000, and: 0xc000, add: 0xd000, eor: 0xb000 };
const IMM = { ori: 0x0000, andi: 0x0200, subi: 0x0400, addi: 0x0600, eori: 0x0a00, cmpi: 0x0c00 };
const MULDIV = { divu: 0x80c0, divs: 0x81c0, mulu: 0xc0c0, muls: 0xc1c0 };
const SINGLE = { negx: 0x4000, clr: 0x4200, neg: 0x4400, not: 0x4600, tst: 0x4a00 };
const SHIFT = { as: 0, ls: 1, rox: 2, ro: 3 };
const BIT = { btst: 0, bchg: 1, bclr: 2, bset: 3 };
const PLAIN = { nop: 0x4e71, rts: 0x4e75, rte: 0x4e73, rtr: 0x4e77, reset: 0x4e70, trapv: 0x4e76, illegal: 0x4afc };
const ILLEGAL_MODE = 'Illegal combination of command and addressing mode.';

const isIdStart = c => !!c && /[A-Za-z_\u0080-￿]/.test(c);
const isIdChar = c => !!c && /[A-Za-z0-9_\u0080-￿]/.test(c);

/** 68000 mnemonics - for the statement parser, the editor and the docs. */
export const M68K_MNEMONICS = [
  'abcd', 'add', 'adda', 'addi', 'addq', 'addx', 'and', 'andi', 'asl', 'asr', 'bchg', 'bclr', 'bset', 'btst', 'chk', 'clr',
  'cmp', 'cmpa', 'cmpi', 'cmpm', 'divs', 'divu', 'eor', 'eori', 'exg', 'ext', 'illegal', 'jmp', 'jsr', 'lea', 'link', 'lsl', 'lsr',
  'move', 'movea', 'movem', 'movep', 'moveq', 'muls', 'mulu', 'nbcd', 'neg', 'negx', 'nop', 'not', 'or', 'ori', 'pea', 'reset',
  'rol', 'ror', 'roxl', 'roxr', 'rte', 'rtr', 'rts', 'sbcd', 'stop', 'sub', 'suba', 'subi', 'subq', 'subx', 'swap', 'tas', 'trap',
  'trapv', 'tst', 'unlk',
  'bra', 'bsr', ...CC_NAMES.slice(2).map(c => 'b' + c), 'bhs', 'blo',
  ...CC_NAMES.map(c => 'db' + c), 'dbra', 'dbhs', 'dblo',
  ...CC_NAMES.map(c => 's' + c), 'shs', 'slo',
  'dc', 'ds', 'even',
];
export const M68K_TABLE = Object.fromEntries(M68K_MNEMONICS.map(m => [m, {}]));
// the pseudo instructions among them (no alignment check, not code)
const DATA = new Set(['dc', 'ds', 'even']);

function regOf(w) {
  w = w.toLowerCase();
  if (/^d[0-7]$/.test(w)) return { k: 'd', n: +w[1] };
  if (/^a[0-7]$/.test(w)) return { k: 'a', n: +w[1] };
  if (w === 'sp') return { k: 'a', n: 7 };
  if (w === 'pc' || w === 'sr' || w === 'ccr' || w === 'usp') return { k: w, n: 0 };
  return null;
}

// a size suffix .w / .l (.b, .s) at the reader, consumed when there
function readSuffix(r, allowed) {
  const ch = r.peek(1).toLowerCase();
  if (r.peek() === '.' && allowed.includes(ch) && ch && !isIdChar(r.peek(2))) { r.pos += 2; return ch; }
  return null;
}

// ------------------------------------------------------------------ operands

function readReg(asm, r) {
  const s = r.save();
  if (!isIdStart(r.peek())) return null;
  const g = regOf(asm.readWord(r));
  if (!g) r.restore(s);
  return g;
}

// the rest of "(...)" after "(" - the operand, or null when it is an expression in parentheses
function inner(asm, r, disp) {
  let base = null, x = null, first = true;
  for (;;) {
    r.ws();
    const g = readReg(asm, r);
    if (g) {
      const sz = readSuffix(r, 'wl');
      if (!base && !x && !sz && (g.k === 'a' || g.k === 'pc')) base = g;
      else if (base && !x && (g.k === 'a' || g.k === 'd')) x = { k: g.k, n: g.n, l: sz === 'l' };
      else asm.err(ILLEGAL_MODE);
    } else {
      if (!first || disp !== null) return null;
      disp = asm.expr(r);
    }
    first = false;
    r.ws();
    if (r.peek() === ',') { r.pos++; continue; }
    if (r.peek() === ')') { r.pos++; break; }
    return null;
  }
  if (!base) {
    if (x || disp === null) asm.err(ILLEGAL_MODE);
    const sz = readSuffix(r, 'wl');
    return sz ? { m: sz === 'w' ? 'absw' : 'absl', v: disp } : null;
  }
  if (base.k === 'pc') return x ? { m: 'pcx', d: disp, x } : { m: 'pcd', d: disp };
  if (x) return { m: 'idx', n: base.n, d: disp, x };
  if (disp !== null) return { m: 'disp', n: base.n, d: disp };
  if (r.peek() === '+') { r.pos++; return { m: 'post', n: base.n }; }
  return { m: 'ind', n: base.n };
}

// a register list d0-d7/a0-a6 after its first register: the mask, bit 0 = d0 ... bit 15 = a7
function regList(asm, r, g) {
  const idx = x => (x.k === 'd' ? x.n : x.k === 'a' ? 8 + x.n : asm.err('Data or address register expected.'));
  let mask = 0, cur = g;
  for (;;) {
    let lo = idx(cur), hi = lo;
    if (r.peek() === '-') {
      r.pos++;
      const e = readReg(asm, r);
      if (!e) asm.err('Register expected.');
      hi = idx(e);
      if (hi < lo) [lo, hi] = [hi, lo];
    }
    for (let i = lo; i <= hi; i++) mask |= 1 << i;
    if (r.peek() !== '/') return { m: 'list', mask };
    r.pos++;
    cur = readReg(asm, r);
    if (!cur) asm.err('Register expected.');
  }
}

function operand(asm, r) {
  r.ws();
  const c = r.peek();
  if (c === '#') { r.pos++; return { m: 'imm', v: asm.expr(r) }; }
  if (c === '-' && r.peek(1) === '(') {
    const s = r.save();
    r.pos += 2;
    r.ws();
    const g = readReg(asm, r);
    r.ws();
    if (g && g.k === 'a' && r.peek() === ')') { r.pos++; return { m: 'pre', n: g.n }; }
    r.restore(s);
  }
  if (c === '(') {
    const s = r.save();
    r.pos++;
    const o = inner(asm, r, null);
    if (o) return o;
    r.restore(s);
  }
  const g = readReg(asm, r);
  if (g) {
    if ((g.k === 'd' || g.k === 'a') && (r.peek() === '-' || r.peek() === '/')) return regList(asm, r, g);
    return g.k === 'd' ? { m: 'dn', n: g.n } : g.k === 'a' ? { m: 'an', n: g.n } : g.k === 'pc' ? asm.err(ILLEGAL_MODE) : { m: g.k };
  }
  const v = asm.expr(r);
  r.ws();
  if (r.peek() === '(') {
    r.pos++;
    const o = inner(asm, r, v);
    if (!o) asm.err(ILLEGAL_MODE);
    return o;
  }
  const sz = readSuffix(r, 'wl');
  return { m: sz === 'w' ? 'absw' : sz === 'l' ? 'absl' : 'abs', v };
}

// ------------------------------------------------------------------ the addressing categories

const isEA = o => !['sr', 'ccr', 'usp', 'list'].includes(o.m);
const isData = o => isEA(o) && o.m !== 'an';
const isMem = o => isData(o) && o.m !== 'dn';
const isAlt = o => isEA(o) && !['imm', 'pcd', 'pcx'].includes(o.m);
const isDataAlt = o => isData(o) && isAlt(o);
const isMemAlt = o => isMem(o) && isAlt(o);
const isCtl = o => ['ind', 'disp', 'idx', 'absw', 'absl', 'abs', 'pcd', 'pcx'].includes(o.m);

const fitsWord = n => (n >= -0x8000 && n <= 0x7fff) || (n >= 0xffff8000 && n <= 0xffffffff);

// mode and register of an operand (an absolute address gets its size here)
function eaBits(asm, o) {
  if (o.m === 'abs') o.m = !o.v.u && fitsWord(asm.toInt(o.v)) ? 'absw' : 'absl';
  switch (o.m) {
    case 'dn': return o.n;
    case 'an': return 8 | o.n;
    case 'ind': return 16 | o.n;
    case 'post': return 24 | o.n;
    case 'pre': return 32 | o.n;
    case 'disp': return 40 | o.n;
    case 'idx': return 48 | o.n;
    case 'absw': return 56;
    case 'absl': return 57;
    case 'pcd': return 58;
    case 'pcx': return 59;
    case 'imm': return 60;
  }
  return asm.err(ILLEGAL_MODE);
}

// ------------------------------------------------------------------ output

function word(asm, n) { asm.emit((n >> 8) & 0xff); asm.emit(n & 0xff); }

function signed(asm, v, bits, what) {
  const n = v === null ? 0 : asm.toInt(v);
  const lim = 2 ** (bits - 1);
  if (v && !v.u && (n < -lim || n >= lim)) asm.error(`${what} out of range (${n}).`);
  return n;
}

function brief(asm, x, d) {
  const n = signed(asm, d, 8, 'Displacement');
  word(asm, (x.k === 'a' ? 0x8000 : 0) | (x.n << 12) | (x.l ? 0x800 : 0) | (n & 0xff));
}

// the extension words of an operand
function ext(asm, o, size) {
  switch (o.m) {
    case 'disp': word(asm, signed(asm, o.d, 16, 'Displacement') & 0xffff); break;
    case 'idx': brief(asm, o.x, o.d); break;
    case 'absw': {
      const n = asm.toInt(o.v);
      if (!o.v.u && !fitsWord(n)) asm.error(`Address out of range for .w (${n}).`);
      word(asm, n & 0xffff);
      break;
    }
    case 'absl': asm.emitVal(asm.toInt(o.v), 4, o.v, false, true); break;
    case 'pcd': case 'pcx': {
      // the target, relative to the extension word
      const at = asm.pcVal();
      const d = o.d === null ? { u: false } : o.d;
      const rel = o.d === null ? 0 : asm.toInt(o.d) - at;
      if (o.m === 'pcx') brief(asm, o.x, { ...d, v: rel, t: 'n' });
      else {
        if (!d.u && (rel < -0x8000 || rel > 0x7fff)) asm.error(`Target out of range (${rel}).`);
        word(asm, rel & 0xffff);
      }
      break;
    }
    case 'imm':
      if (size === 'b') { asm.emit(0); asm.emitVal(asm.toInt(o.v), 1, o.v, false, true); }
      else asm.emitVal(asm.toInt(o.v), SIZE_BYTES[size], o.v, false, true);
      break;
  }
}

// ------------------------------------------------------------------ instructions

/** Assemble one 68000 instruction (the mnemonic is read, the reader is after it). */
export function m68kInstruction(asm, mn, r) {
  const size = r.peek() === '.' ? readSuffix(r, 'bwls') ?? asm.err('Unknown size (.b, .w, .l or .s).') : null;
  if (mn === 'dc') {
    if (size === 's') asm.err('Unknown size (.b, .w or .l).');
    return asm.poData(r, SIZE_BYTES[size ?? 'w'], true);
  }
  if (mn === 'ds') {
    if (size === 's') asm.err('Unknown size (.b, .w or .l).');
    const v = asm.expr(r);
    const n = v.u ? 0 : asm.toInt(v) * SIZE_BYTES[size ?? 'w'];
    if (n < 0) asm.err('Negative size argument.');
    for (let i = 0; i < n; i++) asm.emit(0);
    return;
  }
  if (mn === 'even') { if (asm.pcVal() & 1) asm.emit(0); return; }
  const ops = [];
  if (!r.eos()) {
    for (;;) {
      ops.push(operand(asm, r));
      r.ws();
      if (r.peek() !== ',') break;
      r.pos++;
    }
  }
  if (asm.pcVal() & 1) asm.error('Instruction at an odd address ("even" aligns).');
  encode(asm, mn, size, ops);
}

function encode(asm, mn, size, ops) {
  const ILL = () => asm.err(ILLEGAL_MODE);
  const need = (ok, ...o) => { if (!ok(...o)) ILL(); };
  const nOps = n => { if (ops.length !== n) asm.err(n ? `${n} operand${n > 1 ? 's' : ''} expected.` : 'No operands expected.'); };
  const sized = (allowed, def) => {
    const s = size ?? def;
    if (!allowed.includes(s)) asm.err(`Size .${s} is not available for "${mn}".`);
    return s;
  };
  const noByteAn = (s, ...o) => { if (s === 'b' && o.some(x => x.m === 'an')) asm.err('An address register takes words and longs only.'); };
  const [a, b] = ops;
  // the opcode word, then the extensions of the operands in order
  const out = (op, ...exts) => {
    word(asm, op);
    for (const [o, s] of exts) ext(asm, o, s);
  };

  if (mn in PLAIN) { nOps(0); return word(asm, PLAIN[mn]); }

  // add, sub, and, or, eor, cmp and their a/i/q/x forms
  const base = mn.replace(/[aiqx]$/, '');
  if (mn in ALU || ((mn.endsWith('a') || mn.endsWith('i')) && base in ALU)) {
    nOps(2);
    let form = mn.endsWith('a') ? 'a' : mn.endsWith('i') ? 'i' : '';
    if (!form && b.m === 'an') form = 'a';
    if (!form && a.m === 'imm' && b.m !== 'dn') form = 'i';
    if (!form && a.m === 'imm' && (base === 'eor' || base === 'cmp')) form = 'i';
    if (form === 'a') {
      if (!['add', 'sub', 'cmp'].includes(base) || b.m !== 'an') ILL();
      const s = sized('wl', 'w');
      need(isEA, a);
      const ea = eaBits(asm, a);
      return out(ALU[base] | (b.n << 9) | ((s === 'l' ? 7 : 3) << 6) | ea, [a, s]);
    }
    if (form === 'i') {
      if (base === 'add' || base === 'sub' || base === 'cmp' || base === 'and' || base === 'or' || base === 'eor') {
        if (a.m !== 'imm') ILL();
        const op = IMM[base + 'i'];
        if (b.m === 'ccr' || b.m === 'sr') {
          if (!['and', 'or', 'eor'].includes(base)) ILL();
          if (b.m === 'ccr') { sized('b', 'b'); return out(op | 0x3c, [a, 'b']); }
          sized('w', 'w');
          return out(op | 0x7c, [a, 'w']);
        }
        const s = sized('bwl', 'w');
        need(isDataAlt, b);
        const ea = eaBits(asm, b);
        return out(op | (SIZE_CODE[s] << 6) | ea, [a, s], [b, s]);
      }
      ILL();
    }
    const s = sized('bwl', 'w');
    if (base === 'eor') {
      if (a.m !== 'dn') ILL();
      need(isDataAlt, b);
      const ea = eaBits(asm, b);
      return out(0xb100 | (a.n << 9) | (SIZE_CODE[s] << 6) | ea, [b, s]);
    }
    if (b.m === 'dn') {
      need(base === 'and' || base === 'or' ? isData : isEA, a);
      noByteAn(s, a);
      const ea = eaBits(asm, a);
      return out(ALU[base] | (b.n << 9) | (SIZE_CODE[s] << 6) | ea, [a, s]);
    }
    if (a.m !== 'dn' || base === 'cmp') ILL();
    need(isMemAlt, b);
    const ea = eaBits(asm, b);
    return out(ALU[base] | (a.n << 9) | ((4 + SIZE_CODE[s]) << 6) | ea, [b, s]);
  }

  if (mn === 'addq' || mn === 'subq') {
    nOps(2);
    const s = sized('bwl', 'w');
    if (a.m !== 'imm') ILL();
    const n = asm.toInt(a.v);
    if (!a.v.u && (n < 1 || n > 8)) asm.error('addq/subq take 1 to 8.');
    need(isAlt, b);
    noByteAn(s, b);
    const ea = eaBits(asm, b);
    return out(0x5000 | (mn === 'subq' ? 0x100 : 0) | ((n & 7) << 9) | (SIZE_CODE[s] << 6) | ea, [b, s]);
  }

  if (mn === 'addx' || mn === 'subx' || mn === 'abcd' || mn === 'sbcd') {
    nOps(2);
    const bcd = mn === 'abcd' || mn === 'sbcd';
    const s = bcd ? sized('b', 'b') : sized('bwl', 'w');
    const op = { addx: 0xd100, subx: 0x9100, abcd: 0xc100, sbcd: 0x8100 }[mn] | (bcd ? 0 : SIZE_CODE[s] << 6);
    if (a.m === 'dn' && b.m === 'dn') return word(asm, op | (b.n << 9) | a.n);
    if (a.m === 'pre' && b.m === 'pre') return word(asm, op | 8 | (b.n << 9) | a.n);
    ILL();
  }

  if (mn === 'cmpm') {
    nOps(2);
    const s = sized('bwl', 'w');
    if (a.m !== 'post' || b.m !== 'post') ILL();
    return word(asm, 0xb108 | (b.n << 9) | (SIZE_CODE[s] << 6) | a.n);
  }

  if (mn in MULDIV || mn === 'chk') {
    nOps(2);
    sized('w', 'w');
    need(isData, a);
    if (b.m !== 'dn') ILL();
    const ea = eaBits(asm, a);
    return out((mn === 'chk' ? 0x4180 : MULDIV[mn]) | (b.n << 9) | ea, [a, 'w']);
  }

  if (mn === 'move' || mn === 'movea') {
    nOps(2);
    if (b.m === 'ccr' || b.m === 'sr') {
      sized('w', 'w');
      need(isData, a);
      const ea = eaBits(asm, a);
      return out((b.m === 'ccr' ? 0x44c0 : 0x46c0) | ea, [a, 'w']);
    }
    if (a.m === 'sr') {
      sized('w', 'w');
      need(isDataAlt, b);
      const ea = eaBits(asm, b);
      return out(0x40c0 | ea, [b, 'w']);
    }
    if (a.m === 'usp' || b.m === 'usp') {
      sized('l', 'l');
      if (a.m === 'usp' && b.m === 'an') return word(asm, 0x4e68 | b.n);
      if (b.m === 'usp' && a.m === 'an') return word(asm, 0x4e60 | a.n);
      ILL();
    }
    need(isEA, a);
    if (b.m === 'an' || mn === 'movea') {
      if (b.m !== 'an') ILL();
      const s = sized('wl', 'w');
      const ea = eaBits(asm, a);
      return out((s === 'l' ? 0x2000 : 0x3000) | (b.n << 9) | (1 << 6) | ea, [a, s]);
    }
    const s = sized('bwl', 'w');
    noByteAn(s, a);
    need(isDataAlt, b);
    const src = eaBits(asm, a), dst = eaBits(asm, b);
    return out((MOVE_SIZE[s] << 12) | ((dst & 7) << 9) | ((dst >> 3) << 6) | src, [a, s], [b, s]);
  }

  if (mn === 'moveq') {
    nOps(2);
    sized('l', 'l');
    if (a.m !== 'imm' || b.m !== 'dn') ILL();
    const n = asm.toInt(a.v);
    if (!a.v.u && (n < -128 || n > 255)) asm.error(`moveq takes -128 to 127 (${n}).`);
    return word(asm, 0x7000 | (b.n << 9) | (n & 0xff));
  }

  if (mn === 'movem') {
    nOps(2);
    const s = sized('wl', 'w');
    const maskOf = o => (o.m === 'list' ? o.mask : o.m === 'dn' ? 1 << o.n : o.m === 'an' ? 1 << (8 + o.n) : null);
    // registers to memory, else memory to registers
    const dir = maskOf(a) !== null && isMem(b) ? 0 : maskOf(b) !== null && isMem(a) ? 1 : ILL();
    let mask = dir ? maskOf(b) : maskOf(a);
    const o = dir ? a : b;
    if (dir ? !(isCtl(o) || o.m === 'post') : !((isCtl(o) && isAlt(o)) || o.m === 'pre')) ILL();
    if (o.m === 'pre') {
      let rev = 0;
      for (let i = 0; i < 16; i++) if (mask & (1 << i)) rev |= 1 << (15 - i);
      mask = rev;
    }
    const ea = eaBits(asm, o);
    word(asm, 0x4880 | (dir << 10) | (s === 'l' ? 0x40 : 0) | ea);
    word(asm, mask);
    return ext(asm, o, s);
  }

  if (mn === 'movep') {
    nOps(2);
    const s = sized('wl', 'w');
    const mem = o => o.m === 'disp' || o.m === 'ind';
    const toMem = a.m === 'dn' && mem(b);
    if (!toMem && !(mem(a) && b.m === 'dn')) ILL();
    const [d, m] = toMem ? [a, b] : [b, a];
    word(asm, 0x0108 | (d.n << 9) | (toMem ? 0x80 : 0) | (s === 'l' ? 0x40 : 0) | m.n);
    return word(asm, signed(asm, m.m === 'disp' ? m.d : null, 16, 'Displacement') & 0xffff);
  }

  if (mn === 'lea') {
    nOps(2);
    sized('l', 'l');
    need(isCtl, a);
    if (b.m !== 'an') ILL();
    const ea = eaBits(asm, a);
    return out(0x41c0 | (b.n << 9) | ea, [a, 'l']);
  }
  if (mn === 'pea' || mn === 'jmp' || mn === 'jsr') {
    nOps(1);
    if (mn === 'pea') sized('l', 'l');
    need(isCtl, a);
    const ea = eaBits(asm, a);
    return out({ pea: 0x4840, jmp: 0x4ec0, jsr: 0x4e80 }[mn] | ea, [a, 'l']);
  }

  if (mn in SINGLE || mn === 'nbcd' || mn === 'tas') {
    nOps(1);
    const s = mn in SINGLE ? sized('bwl', 'w') : sized('b', 'b');
    need(isDataAlt, a);
    const ea = eaBits(asm, a);
    const op = mn === 'nbcd' ? 0x4800 : mn === 'tas' ? 0x4ac0 : SINGLE[mn] | (SIZE_CODE[s] << 6);
    return out(op | ea, [a, s]);
  }

  if (mn === 'ext' || mn === 'swap') {
    nOps(1);
    const s = mn === 'swap' ? sized('w', 'w') : sized('wl', 'w');
    if (a.m !== 'dn') ILL();
    return word(asm, (mn === 'swap' ? 0x4840 : s === 'l' ? 0x48c0 : 0x4880) | a.n);
  }

  if (mn === 'exg') {
    nOps(2);
    sized('l', 'l');
    if (a.m === 'dn' && b.m === 'dn') return word(asm, 0xc140 | (a.n << 9) | b.n);
    if (a.m === 'an' && b.m === 'an') return word(asm, 0xc148 | (a.n << 9) | b.n);
    if (a.m === 'dn' && b.m === 'an') return word(asm, 0xc188 | (a.n << 9) | b.n);
    if (a.m === 'an' && b.m === 'dn') return word(asm, 0xc188 | (b.n << 9) | a.n);
    ILL();
  }

  if (mn === 'trap') {
    nOps(1);
    if (a.m !== 'imm') ILL();
    const n = asm.toInt(a.v);
    if (!a.v.u && (n < 0 || n > 15)) asm.error('trap takes 0 to 15.');
    return word(asm, 0x4e40 | (n & 15));
  }
  if (mn === 'link') {
    nOps(2);
    if (a.m !== 'an' || b.m !== 'imm') ILL();
    word(asm, 0x4e50 | a.n);
    return word(asm, signed(asm, b.v, 16, 'Displacement') & 0xffff);
  }
  if (mn === 'unlk') { nOps(1); if (a.m !== 'an') ILL(); return word(asm, 0x4e58 | a.n); }
  if (mn === 'stop') { nOps(1); if (a.m !== 'imm') ILL(); return out(0x4e72, [a, 'w']); }

  const shift = /^(as|ls|rox|ro)([lr])$/.exec(mn);
  if (shift) {
    const tt = SHIFT[shift[1]], dir = shift[2] === 'l' ? 0x100 : 0;
    if (ops.length === 1 && a.m !== 'dn') {
      sized('w', 'w');
      need(isMemAlt, a);
      const ea = eaBits(asm, a);
      return out(0xe0c0 | (tt << 9) | dir | ea, [a, 'w']);
    }
    const s = sized('bwl', 'w');
    if (ops.length === 1) return word(asm, 0xe000 | (1 << 9) | dir | (SIZE_CODE[s] << 6) | (tt << 3) | a.n);
    nOps(2);
    if (b.m !== 'dn') ILL();
    if (a.m === 'dn') return word(asm, 0xe020 | (a.n << 9) | dir | (SIZE_CODE[s] << 6) | (tt << 3) | b.n);
    if (a.m !== 'imm') ILL();
    const n = asm.toInt(a.v);
    if (!a.v.u && (n < 1 || n > 8)) asm.error('A shift count is 1 to 8.');
    return word(asm, 0xe000 | ((n & 7) << 9) | dir | (SIZE_CODE[s] << 6) | (tt << 3) | b.n);
  }

  if (mn in BIT) {
    nOps(2);
    const t = BIT[mn] << 6;
    sized(b.m === 'dn' ? 'l' : 'b', b.m === 'dn' ? 'l' : 'b');
    if (a.m === 'dn') {
      need(mn === 'btst' ? isData : isDataAlt, b);
      const ea = eaBits(asm, b);
      return out(0x0100 | (a.n << 9) | t | ea, [b, 'b']);
    }
    if (a.m !== 'imm') ILL();
    need(mn === 'btst' ? (o => isData(o) && o.m !== 'imm') : isDataAlt, b);
    const ea = eaBits(asm, b);
    return out(0x0800 | t | ea, [a, 'b'], [b, 'b']);
  }

  // Bcc, bra, bsr, DBcc, Scc
  const cond = name => (name === 'ra' ? 0 : name === 'sr' ? 1 : CC[name]);
  if (mn[0] === 'd' && mn[1] === 'b' && (mn === 'dbra' || mn.slice(2) in CC)) {
    nOps(2);
    sized('w', 'w');
    if (a.m !== 'dn' || !['abs', 'absw', 'absl'].includes(b.m)) ILL();
    const pc = asm.pcVal();
    word(asm, 0x50c8 | ((mn === 'dbra' ? 1 : CC[mn.slice(2)]) << 8) | a.n);
    return word(asm, signed(asm, { ...b.v, v: asm.toInt(b.v) - (pc + 2) }, 16, 'Target') & 0xffff);
  }
  if (mn[0] === 'b' && (mn === 'bra' || mn === 'bsr' || (mn.slice(1) in CC && mn !== 'bt' && mn !== 'bf'))) {
    nOps(1);
    const s = sized('bswl', 'w');
    if (!['abs', 'absw', 'absl'].includes(a.m)) ILL();
    const pc = asm.pcVal();
    const d = asm.toInt(a.v) - (pc + 2);
    const op = 0x6000 | (cond(mn.slice(1)) << 8);
    if (s === 'b' || s === 's') {
      if (!a.v.u && (d < -128 || d > 127 || d === 0)) asm.error(`Target out of range for a short branch (${d}).`);
      return word(asm, op | (d & 0xff));
    }
    if (s === 'l') asm.err('The 68000 branches .s or .w.');
    word(asm, op);
    return word(asm, signed(asm, { ...a.v, v: d }, 16, 'Target') & 0xffff);
  }
  if (mn[0] === 's' && mn.slice(1) in CC) {
    nOps(1);
    sized('b', 'b');
    need(isDataAlt, a);
    const ea = eaBits(asm, a);
    return out(0x50c0 | (CC[mn.slice(1)] << 8) | ea, [a, 'b']);
  }
  asm.err(`Unknown 68000 instruction "${mn}".`);
}

// ------------------------------------------------------------------ disassembler

const TRUNC = Symbol('trunc');
const hx = (n, d) => '$' + (n >>> 0).toString(16).padStart(d, '0');
const sx16 = n => (n & 0x8000 ? n - 0x10000 : n);
const sx8 = n => (n & 0x80 ? n - 0x100 : n);
const sdisp = n => (n < 0 ? '-' + hx(-n, 0) : hx(n, 0));

function decode(get, addr) {
  let pos = 0;
  const w16 = () => {
    const h = get(pos), l = get(pos + 1);
    if (h === undefined || l === undefined) throw TRUNC;
    pos += 2;
    return (h << 8) | l;
  };
  const w32 = () => (w16() * 0x10000 + w16()) >>> 0;
  const op = w16();
  const SZ = ['b', 'w', 'l'];
  const xreg = e => `${e & 0x8000 ? 'a' : 'd'}${(e >> 12) & 7}${e & 0x800 ? '.l' : '.w'}`;
  const ea = (mode, reg, size) => {
    switch (mode) {
      case 0: return `d${reg}`;
      case 1: return `a${reg}`;
      case 2: return `(a${reg})`;
      case 3: return `(a${reg})+`;
      case 4: return `-(a${reg})`;
      case 5: return `${sdisp(sx16(w16()))}(a${reg})`;
      case 6: { const e = w16(); return `${sdisp(sx8(e & 0xff))}(a${reg},${xreg(e)})`; }
    }
    switch (reg) {
      case 0: { const n = sx16(w16()); return `(${hx(n >>> 0, n < 0 ? 8 : 4)}).w`; }
      case 1: { const n = w32(); return fitsWord(n) ? `(${hx(n, 8)}).l` : hx(n, 6); }
      case 2: { const at = addr + pos; return `${hx((at + sx16(w16())) & 0xffffff, 6)}(pc)`; }
      case 3: { const at = addr + pos, e = w16(); return `${hx((at + sx8(e & 0xff)) & 0xffffff, 6)}(pc,${xreg(e)})`; }
      case 4: return '#' + (size === 'l' ? hx(w32(), 0) : size === 'w' ? hx(w16(), 0) : hx(w16() & 0xff, 0));
    }
    return null;
  };
  const eaOf = (w, size) => ea((w >> 3) & 7, w & 7, size);
  const dn = (op >> 9) & 7;
  const t = (m, s, args) => `${m}${s ? '.' + s : ''}${args ? ' ' + args : ''}`;
  const list = (mask, pre) => {
    const regs = [];
    for (let i = 0; i < 16; i++) if (mask & (1 << (pre ? 15 - i : i))) regs.push(i);
    const parts = [];
    for (let i = 0; i < regs.length;) {
      let j = i;
      while (j + 1 < regs.length && regs[j + 1] === regs[j] + 1 && (regs[j + 1] < 8) === (regs[i] < 8)) j++;
      const n = k => (regs[k] < 8 ? `d${regs[k]}` : `a${regs[k] - 8}`);
      parts.push(j > i ? `${n(i)}-${n(j)}` : n(i));
      i = j + 1;
    }
    return parts.join('/');
  };
  const line = op >> 12;
  const sz = (op >> 6) & 3;
  switch (line) {
    case 0: {
      if (op & 0x100) {
        if ((op & 0x38) === 0x08) {
          const d = sx16(w16()), s = op & 0x40 ? 'l' : 'w', m = `${sdisp(d)}(a${op & 7})`;
          return op & 0x80 ? t('movep', s, `d${dn},${m}`) : t('movep', s, `${m},d${dn}`);
        }
        return t(Object.keys(BIT)[sz], '', `d${dn},${eaOf(op, 'b')}`);
      }
      const k = (op >> 9) & 7;
      if (k === 4) { const n = w16() & 0xff; return t(Object.keys(BIT)[sz], '', `#${n},${eaOf(op, 'b')}`); }
      const name = { 0: 'ori', 1: 'andi', 2: 'subi', 3: 'addi', 5: 'eori', 6: 'cmpi' }[k];
      if (!name || sz === 3) return null;
      if ((op & 0x3f) === 0x3c && [0, 1, 5].includes(k) && sz < 2) {
        const n = w16();
        return sz === 0 ? t(name, '', `#${hx(n & 0xff, 0)},ccr`) : t(name, '', `#${hx(n, 0)},sr`);
      }
      const im = ea(7, 4, SZ[sz]);
      return t(name, SZ[sz], `${im},${eaOf(op, SZ[sz])}`);
    }
    case 1: case 2: case 3: {
      const s = { 1: 'b', 3: 'w', 2: 'l' }[line];
      const src = eaOf(op, s);
      const dm = (op >> 6) & 7;
      if (dm === 1) return s === 'b' ? null : t('movea', s, `${src},a${dn}`);
      const dst = ea(dm, dn, s);
      return dst && src ? t('move', s, `${src},${dst}`) : null;
    }
    case 4: {
      const plain = Object.entries(PLAIN).find(([, v]) => v === op);
      if (plain) return plain[0];
      if (op === 0x4e72) return t('stop', '', '#' + hx(w16(), 0));
      if ((op & 0xfff0) === 0x4e40) return t('trap', '', '#' + (op & 15));
      if ((op & 0xfff8) === 0x4e50) return t('link', '', `a${op & 7},#${sdisp(sx16(w16()))}`);
      if ((op & 0xfff8) === 0x4e58) return t('unlk', '', `a${op & 7}`);
      if ((op & 0xfff8) === 0x4e60) return t('move', 'l', `a${op & 7},usp`);
      if ((op & 0xfff8) === 0x4e68) return t('move', 'l', `usp,a${op & 7}`);
      if ((op & 0xffc0) === 0x4e80) return t('jsr', '', eaOf(op, 'l'));
      if ((op & 0xffc0) === 0x4ec0) return t('jmp', '', eaOf(op, 'l'));
      if ((op & 0xffc0) === 0x40c0) return t('move', 'w', `sr,${eaOf(op, 'w')}`);
      if ((op & 0xffc0) === 0x44c0) return t('move', 'w', `${eaOf(op, 'w')},ccr`);
      if ((op & 0xffc0) === 0x46c0) return t('move', 'w', `${eaOf(op, 'w')},sr`);
      if ((op & 0xffc0) === 0x4ac0) return t('tas', '', eaOf(op, 'b'));
      if ((op & 0xf900) === 0x4000 && sz < 3) return t(['negx', 'clr', 'neg', 'not'][(op >> 9) & 3], SZ[sz], eaOf(op, SZ[sz]));
      if ((op & 0xff00) === 0x4a00 && sz < 3) return t('tst', SZ[sz], eaOf(op, SZ[sz]));
      if ((op & 0xfff8) === 0x4840) return t('swap', '', `d${op & 7}`);
      if ((op & 0xfff8) === 0x4880) return t('ext', 'w', `d${op & 7}`);
      if ((op & 0xfff8) === 0x48c0) return t('ext', 'l', `d${op & 7}`);
      if ((op & 0xffc0) === 0x4800) return t('nbcd', '', eaOf(op, 'b'));
      if ((op & 0xffc0) === 0x4840) return t('pea', '', eaOf(op, 'l'));
      if ((op & 0xfb80) === 0x4880) {
        const s = op & 0x40 ? 'l' : 'w', mask = w16(), pre = (op & 0x38) === 0x20, m = eaOf(op, s);
        return op & 0x400 ? t('movem', s, `${m},${list(mask, false)}`) : t('movem', s, `${list(mask, pre)},${m}`);
      }
      if ((op & 0xf1c0) === 0x41c0) return t('lea', '', `${eaOf(op, 'l')},a${dn}`);
      if ((op & 0xf1c0) === 0x4180) return t('chk', '', `${eaOf(op, 'w')},d${dn}`);
      return null;
    }
    case 5: {
      if (sz === 3) {
        const cc = (op >> 8) & 15;
        if ((op & 0x38) === 0x08) {
          const at = addr + 2;
          return t(cc === 1 ? 'dbra' : 'db' + CC_NAMES[cc], '', `d${op & 7},${hx((at + sx16(w16())) & 0xffffff, 6)}`);
        }
        return t('s' + CC_NAMES[cc], '', eaOf(op, 'b'));
      }
      return t(op & 0x100 ? 'subq' : 'addq', SZ[sz], `#${dn || 8},${eaOf(op, SZ[sz])}`);
    }
    case 6: {
      const cc = (op >> 8) & 15, name = cc === 0 ? 'bra' : cc === 1 ? 'bsr' : 'b' + CC_NAMES[cc];
      const d8 = op & 0xff;
      if (d8) return t(name, 's', hx((addr + 2 + sx8(d8)) & 0xffffff, 6));
      return t(name, '', hx((addr + 2 + sx16(w16())) & 0xffffff, 6));
    }
    case 7: return op & 0x100 ? null : t('moveq', '', `#${sdisp(sx8(op & 0xff))},d${dn}`);
    case 8: case 9: case 11: case 12: case 13: {
      const om = (op >> 6) & 7;
      const name = { 8: 'or', 9: 'sub', 11: 'cmp', 12: 'and', 13: 'add' }[line];
      if (om === 3 || om === 7) {
        if (line === 8) return t(om === 3 ? 'divu' : 'divs', '', `${eaOf(op, 'w')},d${dn}`);
        if (line === 12) return t(om === 3 ? 'mulu' : 'muls', '', `${eaOf(op, 'w')},d${dn}`);
        const s = om === 3 ? 'w' : 'l';
        return t(name + 'a', s, `${eaOf(op, s)},a${dn}`);
      }
      const s = SZ[om & 3];
      if (om >= 4) {
        const rm = op & 8, ry = op & 7;
        if ((line === 8 || line === 12) && om === 4 && (op & 0x30) === 0) {
          const n = line === 8 ? 'sbcd' : 'abcd';
          return rm ? t(n, '', `-(a${ry}),-(a${dn})`) : t(n, '', `d${ry},d${dn}`);
        }
        if (line === 12 && (op & 0x1f8) === 0x140) return t('exg', '', `d${dn},d${ry}`);
        if (line === 12 && (op & 0x1f8) === 0x148) return t('exg', '', `a${dn},a${ry}`);
        if (line === 12 && (op & 0x1f8) === 0x188) return t('exg', '', `d${dn},a${ry}`);
        if ((line === 9 || line === 13) && (op & 0x30) === 0) {
          const n = line === 9 ? 'subx' : 'addx';
          return rm ? t(n, s, `-(a${ry}),-(a${dn})`) : t(n, s, `d${ry},d${dn}`);
        }
        if (line === 11) {
          if ((op & 0x38) === 0x08) return t('cmpm', s, `(a${ry})+,(a${dn})+`);
          return t('eor', s, `d${dn},${eaOf(op, s)}`);
        }
        return t(name, s, `d${dn},${eaOf(op, s)}`);
      }
      return t(name, s, `${eaOf(op, s)},d${dn}`);
    }
    case 14: {
      const kinds = ['as', 'ls', 'rox', 'ro'];
      const dir = op & 0x100 ? 'l' : 'r';
      if (sz === 3) return t(kinds[(op >> 9) & 3] + dir, '', eaOf(op, 'w'));
      const cnt = op & 0x20 ? `d${dn}` : `#${dn || 8}`;
      return t(kinds[(op >> 3) & 3] + dir, SZ[sz], `${cnt},d${op & 7}`);
    }
  }
  return null;
}

/** Disassemble 68000 code: [{ addr, bytes, text }] - an unknown word is dc.w. */
export function disassembleM68k(bytes, addr = 0) {
  const out = [];
  let i = 0;
  while (i + 1 < bytes.length) {
    const a = (addr + i) & 0xffffff;
    let text = null, len = 2;
    try {
      let n = 0;
      const get = k => { n = Math.max(n, k + 1); return i + k < bytes.length ? bytes[i + k] : undefined; };
      text = decode(get, a);
      len = n;
    } catch (e) { if (e !== TRUNC) throw e; text = null; }
    if (text === null) { text = `dc.w ${hx((bytes[i] << 8) | bytes[i + 1], 4)}`; len = 2; }
    out.push({ addr: a, bytes: [...bytes.slice(i, i + len)], text });
    i += len;
  }
  return out;
}
