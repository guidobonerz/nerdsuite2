// cpudocs.js - the details the autocompletion of the code editor shows (codeeditor.js: an item's doc):
//   the 6502 family   the addressing modes of an instruction with its opcode, bytes and cycles, and the
//                     flags of the status register it changes (N V - B D I Z C)
//   the Z80           the operands of an instruction and the flags it changes (S Z H P/V N C)
//   BASIC             the parameters of a keyword, from its syntax (basic/dialects.js)
//   the machines      the bits of a register of a chip, by its address (memmap.js)
//
// A doc: { title, syntax?, desc?, params?: [{ name, desc }], active?, modes?: [{ syntax, op, bytes, cycles }],
//          flags?: { names, effects: [{ name, effect }] }, bits?: [{ where, what }], notes?: [text] }

import { CPU_TABLES, CPU_ALIASES, MODE_SYNTAX } from './acme/acme.js';
import { MNEMONICS } from './acme/docs.js';
import { symbolsFor, describeBits } from './memmap.js';

// --- the 6502 family ---------------------------------------------------------------------------------------

// the flags N V B D I Z C: * changed, 0 cleared, 1 set, m bit 7 / bit 6 of the operand, - kept
const F6502 = {
  adc: '**---**', sbc: '**---**', and: '*----*-', ora: '*----*-', eor: '*----*-',
  asl: '*----**', rol: '*----**', ror: '*----**', lsr: '0----**',
  bit: 'mm---*-', cmp: '*----**', cpx: '*----**', cpy: '*----**',
  inc: '*----*-', dec: '*----*-', inx: '*----*-', iny: '*----*-', dex: '*----*-', dey: '*----*-',
  lda: '*----*-', ldx: '*----*-', ldy: '*----*-', pla: '*----*-',
  tax: '*----*-', tay: '*----*-', txa: '*----*-', tya: '*----*-', tsx: '*----*-',
  clc: '------0', sec: '------1', cld: '---0---', sed: '---1---', cli: '----0--', sei: '----1--', clv: '-0-----',
  brk: '--1-1--', plp: '*******', rti: '*******',
  // 65c02
  plx: '*----*-', ply: '*----*-', trb: '-----*-', tsb: '-----*-',
  // 65816
  rep: '*******', sep: '*******', xba: '*----*-', tdc: '*----*-', tsc: '*----*-', tcd: '*----*-', tyx: '*----*-', txy: '*----*-',
  pld: '*----*-', plb: '*----*-', xce: '------*',
  // undocumented (NMOS)
  lax: '*----*-', dcp: '*----**', isc: '**---**', slo: '*----**', rla: '*----**', sre: '*----**', rra: '**---**',
  anc: '*----**', asr: '*----**', alr: '*----**', arr: '**---**', sbx: '*----**', axs: '*----**', las: '*----*-', lxa: '*----*-', ane: '*----*-',
};
const NAMES_6502 = ['N', 'V', 'B', 'D', 'I', 'Z', 'C'];
const FLAG_6502 = { N: 'negative', V: 'overflow', B: 'break', D: 'decimal', I: 'interrupt disable', Z: 'zero', C: 'carry' };
const EFFECT = { '*': 'changed', 0: 'cleared', 1: 'set', m: 'from the operand' };

function flags6502(name) {
  let code = F6502[name];
  if (!code) return { names: NAMES_6502, effects: [] };
  // BIT: N from bit 7, V from bit 6 of the operand; BIT #imm (65c02) changes Z only
  return {
    names: NAMES_6502,
    effects: [...code].map((c, k) => (c === '-' ? null : { name: NAMES_6502[k], flag: FLAG_6502[NAMES_6502[k]], effect: name === 'bit' && c === 'm' ? `bit ${k === 0 ? 7 : 6} of the operand` : EFFECT[c] })).filter(Boolean),
    all: code === '*******',
  };
}

const RMW = new Set(['asl', 'lsr', 'rol', 'ror', 'inc', 'dec', 'slo', 'rla', 'sre', 'rra', 'dcp', 'isc', 'trb', 'tsb']);
const STORE = new Set(['sta', 'stx', 'sty', 'stz', 'sax', 'sha', 'shx', 'shy', 'tas']);
const BYTES = { imp: 1, imm: 2, zp: 2, zpx: 2, zpy: 2, abs: 3, absx: 3, absy: 3, ind: 3, indx: 2, indy: 2, izp: 2, iax: 3, rel: 2, zprel: 3,
  sr: 2, sry: 2, ildp: 2, ildpy: 2, long: 4, longx: 4, ialong: 3, rell: 3, blk: 3 };

// the cycles of the NMOS 6502 ('4+': one more when a page is crossed) - the 65c02 and 65816 differ a little
function cycles6502(name, mode) {
  const rmw = RMW.has(name), store = STORE.has(name);
  switch (mode) {
    case 'imp': return { brk: 7, rti: 6, rts: 6, pha: 3, php: 3, phx: 3, phy: 3, pla: 4, plp: 4, plx: 4, ply: 4 }[name] ?? 2;
    case 'imm': return 2;
    case 'zp': return rmw ? 5 : 3;
    case 'zpx': case 'zpy': return rmw ? 6 : 4;
    case 'abs': return name === 'jmp' ? 3 : name === 'jsr' ? 6 : rmw ? 6 : 4;
    case 'absx': case 'absy': return rmw ? 7 : store ? 5 : '4+';
    case 'ind': return 5;
    case 'indx': return rmw ? 8 : 6;
    case 'indy': return rmw ? 8 : store ? 6 : '5+';
    case 'izp': return 5;
    case 'iax': return 6;
    case 'rel': return '2+';
    case 'zprel': return '5+';
    default: return null;
  }
}

const tableOf = cpu => CPU_TABLES[CPU_ALIASES[String(cpu).toLowerCase()] ?? cpu] ?? CPU_TABLES['6502'];

// the doc of an instruction of the 6502 family: its modes and the flags it changes
export function mnemonicDoc(cpu, name, desc) {
  name = name.toLowerCase();
  if (String(cpu).toLowerCase() === 'z80') return z80Doc(name, desc);
  const modes = tableOf(cpu)?.[name];
  if (!modes) return null;
  const c816 = /65816/.test(cpu);
  const accu = ['asl', 'lsr', 'rol', 'ror', 'inc', 'dec'].includes(name);
  const order = Object.keys(BYTES);
  const rows = Object.entries(modes).sort(([a], [b]) => order.indexOf(a) - order.indexOf(b)).map(([mode, op]) => ({
    syntax: mode === 'imp' ? (accu ? `${name} a` : name) : `${name} ${MODE_SYNTAX[mode] ?? mode}`,
    op: `$${op.toString(16).padStart(2, '0')}`,
    bytes: c816 && mode === 'imm' && !['rep', 'sep', 'cop', 'brk', 'wdm'].includes(name) ? '2/3' : BYTES[mode] ?? '',
    cycles: c816 ? '' : cycles6502(name, mode) ?? '',
  }));
  const notes = [];
  if (rows.some(r => String(r.cycles).endsWith('+'))) notes.push(modes.rel != null || modes.zprel != null ? '+1 cycle when the branch is taken, +2 when it goes to another page' : '+1 cycle when a page is crossed');
  if (c816) notes.push('65816: #imm is 2 or 3 bytes, as the m and x flags set the width');
  if (name === 'bit' && modes.imm != null) notes.push('BIT #imm changes Z only');
  if (name === 'jmp' && modes.ind != null && !/c02|816/.test(cpu)) notes.push('NMOS: jmp ($xxff) reads the high byte from $xx00');
  return { title: name, desc: desc ?? MNEMONICS[cpu]?.find(m => m.name === name)?.desc, modes: rows, flags: flags6502(name), notes };
}

// --- the Z80 ------------------------------------------------------------------------------------------------

// the flags S Z H P/V N C: * changed, 0 cleared, 1 set, p parity, v overflow, - kept
const FZ80 = {
  add: '***v0*', adc: '***v0*', sub: '***v1*', sbc: '***v1*', cp: '***v1*', neg: '***v1*',
  and: '**1p00', or: '**0p00', xor: '**0p00',
  inc: '***v0-', dec: '***v1-',
  rlca: '--0-0*', rrca: '--0-0*', rla: '--0-0*', rra: '--0-0*',
  rlc: '**0p0*', rrc: '**0p0*', rl: '**0p0*', rr: '**0p0*', sla: '**0p0*', sra: '**0p0*', srl: '**0p0*', sll: '**0p0*', sl1: '**0p0*',
  rld: '**0p0-', rrd: '**0p0-', bit: '-*1-0-', daa: '***p-*', cpl: '--1-1-', scf: '--0-01', ccf: '--*-0*',
  ldi: '--0*0-', ldd: '--0*0-', ldir: '--000-', lddr: '--000-',
  cpi: '****1-', cpd: '****1-', cpir: '****1-', cpdr: '****1-',
  in: '**0p0-', ini: '-*--1-', ind: '-*--1-', inir: '-1--1-', indr: '-1--1-', outi: '-*--1-', outd: '-*--1-', otir: '-1--1-', otdr: '-1--1-',
};
const NAMES_Z80 = ['S', 'Z', 'H', 'P/V', 'N', 'C'];
const FLAG_Z80 = { S: 'sign', Z: 'zero', H: 'half carry', 'P/V': 'parity / overflow', N: 'subtract', C: 'carry' };
const EFFECT_Z80 = { '*': 'changed', 0: 'cleared', 1: 'set', p: 'parity', v: 'overflow' };
const Z80_NOTES = {
  add: 'add a,x: S Z H V C changed, N cleared - add hl/ix/iy,rr: only H and C, N cleared',
  inc: 'inc rr and dec rr change no flag',
  dec: 'inc rr and dec rr change no flag',
  ld: 'ld a,i and ld a,r: S Z changed, H N cleared, P/V the interrupt flip-flop IFF2',
  bit: 'S and P/V are undefined',
  ldi: 'P/V: set while bc is not 0',
  ldd: 'P/V: set while bc is not 0',
  cpi: 'P/V: set while bc is not 0; Z: set when a = (hl)',
};

function z80Doc(name, desc) {
  const m = MNEMONICS.z80?.find(x => x.name === name);
  if (!m) return null;
  const code = FZ80[name];
  return {
    title: name, desc: desc ?? m.desc,
    modes: (m.modes ?? []).map(op => ({ syntax: op === 'implied' ? name : `${name} ${op}` })),
    flags: { names: NAMES_Z80, effects: code ? [...code].map((c, k) => (c === '-' ? null : { name: NAMES_Z80[k], flag: FLAG_Z80[NAMES_Z80[k]], effect: EFFECT_Z80[c] })).filter(Boolean) : [] },
    notes: [Z80_NOTES[name], 'r = b c d e h l a · rr = bc de hl sp · n a byte · nn a word · d an offset · cc a condition'].filter(Boolean),
  };
}

// --- the registers of the machines ------------------------------------------------------------------------

// the register at an address (exact, no area): its doc with the bits, or null
export function registerDoc(machine, addr, { decimal = false } = {}) {
  if (addr == null || !machine) return null;
  const s = symbolsFor(machine).at(addr);
  if (!s || s.offset) return null;
  const at = decimal ? String(addr) : `$${addr.toString(16).padStart(4, '0')}`;
  const bits = describeBits(machine, s.sym.name);
  return { title: `${s.sym.name} · ${at}${decimal ? ` · $${addr.toString(16).padStart(4, '0')}` : ` · ${addr}`}`, desc: s.desc, bits,
    notes: s.sym.read ? [`read: ${s.sym.read}`] : [] };
}

// the registers of a machine whose address starts with what is typed: [{ addr, name, desc, text }]
export function registersLike(machine, typed, { decimal = false } = {}) {
  if (!machine) return [];
  const t = typed.toLowerCase().replace(/^\$|^0x/, '');
  const out = [];
  for (const s of symbolsFor(machine).list) {
    if (s.port || s.size > 1) continue;
    const text = decimal ? String(s.addr) : s.addr.toString(16).padStart(s.addr > 0xff ? 4 : 2, '0');
    if (text.startsWith(t)) out.push({ ...s, text: decimal ? text : `$${text}` });
  }
  return out.sort((a, b) => a.addr - b.addr);
}

// --- the operand of an instruction ------------------------------------------------------------------------

// the instruction whose operand the caret is in: 'loop  lda $d0' -> { mnemonic: 'lda', operand: '$d0' }
export function operandAt(before, isMnemonic) {
  let rest = before.replace(/^\s*/, '');
  for (let k = 0; k < 2; k++) {                  // a label first, then the mnemonic
    const m = /^([.@!]?[A-Za-z_]\w*)(?:\+[12]|\.[a-z]+)?(:?)\s+/i.exec(rest);
    if (!m) return null;
    if (!m[2] && isMnemonic(m[1])) return { mnemonic: m[1].toLowerCase(), operand: rest.slice(m[0].length) };
    rest = rest.slice(m[0].length);
  }
  return null;
}

// the help in the operand of an instruction: the doc of the instruction, the bits of the register it
// addresses ($d011, 53265 or a label of that value), and the registers whose address starts with a typed
// $d0 -> { info: [doc], hex: { from, typed, items } | null }
export function asmHelp({ before, caret, cpu, machine, isMnemonic, valueOf = () => null }) {
  const at = operandAt(before, isMnemonic);
  if (!at) return null;
  const info = [mnemonicDoc(cpu, at.mnemonic)].filter(Boolean);
  const imm = /^\s*#/.test(at.operand);
  const v = /^\s*\(?\s*(\$[0-9a-f]+|%[01]+|\d+|[.@]?[A-Za-z_]\w*)/i.exec(at.operand)?.[1];
  if (v && !imm && String(cpu).toLowerCase() !== 'z80') {
    const value = v.startsWith('$') ? parseInt(v.slice(1), 16) : v.startsWith('%') ? parseInt(v.slice(1), 2) : /^\d/.test(v) ? Number(v) : valueOf(v);
    const reg = registerDoc(machine, value);
    if (reg) info.push(reg);
  }
  const typed = !imm && /(?:^|[\s(,])(\$[0-9a-f]{0,4})$/i.exec(before)?.[1];
  const hex = typed ? {
    from: caret - typed.length, typed,
    items: registersLike(machine, typed).map(r => ({ label: r.text, kind: 'const', hint: r.name, doc: registerDoc(machine, r.addr) })),
  } : null;
  return { info, hex };
}

// --- BASIC: the parameters of a keyword ---------------------------------------------------------------------

// what the usual names of the syntax stand for
const PARAM = {
  addr: 'an address, 0-65535', address: 'an address, 0-65535', value: 'a byte, 0-255', byte: 'a byte, 0-255', mask: 'the bits to wait for (AND)',
  xor: 'the bits that are inverted first (XOR)', line: 'a line number', line1: 'a line number', line2: 'a line number', start: 'the first value',
  end: 'the last value', inc: 'the step, 1 when it is left out', v: 'a numeric variable', w: 'a numeric variable', var: 'a variable',
  expr: 'an expression', cond: 'a condition: true when not 0', stmt: 'a statement', const: 'a number or a string', lf: 'the logical file number, 1-255',
  dev: 'the device: 1 tape, 4 printer, 8-11 disk', sa: 'the secondary address (channel)', name: 'the file name', '"name"': 'the file name', n: 'a number',
  x: 'a number', y: 'a number', 's$': 'a string', 'a$': 'a string', 'x$': 'a string', 'hex$': 'a string of hexadecimal digits', 'find$': 'the string searched for',
  len: 'a length', pos: 'a position, 1 the first character', prompt: 'the text shown first', '"prompt"': 'the text shown first', src: 'the color source',
  color: 'a color', col: 'a column', row: 'a row', lum: 'the luminance, 0-7', mode: 'the mode', vol: 'the volume, 0-15', voice: 'the voice', freq: 'the frequency',
  dur: 'the duration', a: 'an array', b: 'an array', m: 'the highest index', 'str$': 'a string',
};

// the parameters of a syntax: 'POKE addr, value' -> ['addr', 'value'] (no keyword, no [ ] , ...)
export function paramsOf(syntax, keyword) {
  const words = String(syntax ?? '').split(/\s+\/\s+|\s*\|\s*/)[0]
    .replace(/\.\.\./g, ' ').match(/"[a-z]+"|[a-z][\w]*\$?/g) ?? [];
  const kw = String(keyword ?? '').toLowerCase().replace(/[#$]$/, '');
  const seen = new Set();
  return words.filter(w => {
    if (w.toLowerCase() === kw || /^[A-Z]{2,}\$?$/.test(w) || seen.has(w)) return false;
    seen.add(w);
    return true;
  }).map(w => ({ name: w, desc: PARAM[w] ?? PARAM[w.replace(/\d+$/, '')] ?? '' }));
}

// the parameter the caret is at: the separators of the syntax (',' '=' TO STEP ...) in the order they
// come, found in what is typed after the keyword. 'FOR v = start TO end [STEP inc]', ' I=1 TO 10 ST' -> 2
export function activeParam(syntax, keyword, rest) {
  const kw = String(keyword ?? '').toLowerCase().replace(/[#$(]$/, '');
  const tokens = String(syntax ?? '').split(/\s+\/\s+|\s*\|\s*/)[0].replace(/\.\.\./g, ' ').match(/"[a-z]+"|[a-z]\w*\$?|[A-Z]{2,}\$?|[,=;]/g) ?? [];
  const seps = [];                // the separator before each parameter after the first
  let sep = null, seen = new Set(), first = true;
  for (const t of tokens) {
    if (/^[,=;]$/.test(t) || /^[A-Z]{2,}\$?$/.test(t)) { if (t.toLowerCase() !== kw) sep = t.toLowerCase(); continue; }
    if (seen.has(t)) continue;
    seen.add(t);
    if (!first) seps.push(sep ?? ',');
    first = false;
    sep = null;
  }
  const text = String(rest ?? '').toLowerCase();
  let at = 0, active = 0;
  for (const s of seps) {
    const found = text.indexOf(s, at);
    if (found < 0) break;
    active++;
    at = found + s.length;
  }
  // more of a repeated parameter (var[, var...]): commas after the last one stay at the last
  return active;
}

// the doc of a BASIC keyword: its syntax and its parameters; rest: what is typed after it (the
// parameter at the caret is marked), or a number: that parameter
export function keywordDoc(k, rest = null) {
  const active = rest == null ? null : typeof rest === 'number' ? rest : activeParam(k.syntax, k.name, rest);
  return { title: k.name.toUpperCase(), syntax: k.syntax, desc: k.desc, params: paramsOf(k.syntax, k.name), active };
}
