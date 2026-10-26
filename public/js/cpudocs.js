// cpudocs.js - the details the autocompletion of the code editor shows (codeeditor.js: an item's doc):
//   the 6502 family   the addressing modes of an instruction with its opcode, bytes and cycles, and the
//                     flags of the status register it changes (N V - B D I Z C)
//   the Z80           the operands of an instruction and the flags it changes (S Z H P/V N C)
//   BASIC             the parameters of a keyword, from its syntax (basic/dialects.js)
//   the machines      the bits of a register of a chip, by its address (memmap.js)
//
// A doc: { title, syntax?, desc?, params?: [{ name, desc }], active?, modes?: [{ syntax, op, bytes, cycles }],
//          flags?: { names, effects: [{ name, effect }] }, bits?: [{ where, what }], notes?: [text] }

import { CPU_TABLES, CPU_ALIASES, MODE_SYNTAX, opBytes } from './acme/acme.js';
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
  // 65ce02, 4502, 45gs02 (the quad instructions as the ones they extend)
  ldz: '*----*-', plz: '*----*-', tza: '*----*-', tba: '*----*-', tsy: '*----*-', inz: '*----*-', dez: '*----*-', cpz: '*----**',
  neg: '*----*-', asr: '*----**', inw: '*----*-', dew: '*----*-', asw: '*----**', row: '*----**',
  ldq: '*----*-', adcq: '**---**', sbcq: '**---**', andq: '*----*-', orq: '*----*-', eorq: '*----*-', cpq: '*----**', cmpq: '*----**',
  aslq: '*----**', lsrq: '0----**', rolq: '*----**', rorq: '*----**', asrq: '*----**', inq: '*----*-', deq: '*----*-', bitq: 'mm---*-',
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
  sr: 2, sry: 2, ildp: 2, ildpy: 2, long: 4, longx: 4, ialong: 3, rell: 3, blk: 3, izpz: 2, imm16: 3, rel16: 3, izl: 2, izlq: 2 };

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
  if (CPU_ALIASES[String(cpu).toLowerCase()] === 'm68k') return m68kDoc(name, desc);
  const modes = tableOf(cpu)?.[name];
  if (!modes) return null;
  const c816 = /65816/.test(cpu);
  // the 65CE02 family (the MEGA65's 45GS02): other cycles than the NMOS 6502, the prefixes before the opcode
  const ce02 = ['65ce02', '4502', 'm65'].includes(CPU_ALIASES[String(cpu).toLowerCase()]);
  const accu = ['asl', 'lsr', 'rol', 'ror', 'inc', 'dec'].includes(name);
  const order = Object.keys(BYTES);
  const rows = Object.entries(modes).sort(([a], [b]) => order.indexOf(a) - order.indexOf(b)).map(([mode, op]) => ({
    syntax: mode === 'imp' ? (accu ? `${name} a` : name) : `${name} ${MODE_SYNTAX[mode] ?? mode}`,
    op: opBytes(op).map(b => `$${b.toString(16).padStart(2, '0')}`).join(' '),
    bytes: c816 && mode === 'imm' && !['rep', 'sep', 'cop', 'brk', 'wdm'].includes(name) ? '2/3' : BYTES[mode] != null ? BYTES[mode] + opBytes(op).length - 1 : '',
    cycles: c816 || ce02 ? '' : cycles6502(name, mode) ?? '',
  }));
  const notes = [];
  if (rows.some(r => String(r.cycles).endsWith('+'))) notes.push(modes.rel != null || modes.zprel != null ? '+1 cycle when the branch is taken, +2 when it goes to another page' : '+1 cycle when a page is crossed');
  if (c816) notes.push('65816: #imm is 2 or 3 bytes, as the m and x flags set the width');
  if (modes.izpz != null) notes.push('(zp),z: the 65CE02 indexes the pointer with Z - (zp) of the 65C02 when Z is 0');
  if (modes.rel16 != null) notes.push('the offset counts from the third byte of the instruction');
  if (/q$/.test(name) && opBytes(Object.values(modes)[0])[0] === 0x42) notes.push('Q is A X Y Z, 32 bits: A the low byte, Z the high one');
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

// the 68000: the forms of an instruction (docs.js), the sizes
function m68kDoc(name, desc) {
  const m = MNEMONICS['68000']?.find(x => x.name === name);
  if (!m) return null;
  return {
    title: name, desc: desc ?? m.desc,
    modes: (m.modes ?? []).map(op => ({ syntax: op === 'implied' ? name : `${name} ${op}` })),
    notes: ['.b .w .l the size (without one .w), .s a short branch · ea: dn an (an) (an)+ -(an) d(an) d(an,xn) abs.w abs.l d(pc) d(pc,xn) #n'],
  };
}

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

// --- Shift and the mouse: the whole doc of what is under the pointer (codeeditor.js: lang.hover) -----------

// what an instruction does: M the operand, -> where the result goes
const OPERATION = {
  adc: 'A + M + C -> A, C', sbc: 'A - M - (1 - C) -> A, C (C set: no borrow)', and: 'A AND M -> A', ora: 'A OR M -> A', eor: 'A XOR M -> A',
  asl: 'C <- [7..0] <- 0', lsr: '0 -> [7..0] -> C', rol: 'C <- [7..0] <- C', ror: 'C -> [7..0] -> C',
  bit: 'A AND M sets Z; bit 7 of M -> N, bit 6 -> V', cmp: 'A - M sets N Z C (C set: A >= M)', cpx: 'X - M sets N Z C', cpy: 'Y - M sets N Z C',
  dec: 'M - 1 -> M', inc: 'M + 1 -> M', dex: 'X - 1 -> X', dey: 'Y - 1 -> Y', inx: 'X + 1 -> X', iny: 'Y + 1 -> Y',
  lda: 'M -> A', ldx: 'M -> X', ldy: 'M -> Y', sta: 'A -> M', stx: 'X -> M', sty: 'Y -> M',
  tax: 'A -> X', tay: 'A -> Y', txa: 'X -> A', tya: 'Y -> A', tsx: 'S -> X', txs: 'X -> S',
  pha: 'A -> stack', php: 'P -> stack (B and bit 5 set)', pla: 'stack -> A', plp: 'stack -> P',
  jmp: 'the address -> PC', jsr: 'PC + 2 -> stack, the address -> PC', rts: 'stack + 1 -> PC', rti: 'stack -> P, stack -> PC',
  brk: 'PC + 2 -> stack, P -> stack, I set, ($fffe) -> PC', nop: 'nothing',
  bcc: 'branch if C = 0', bcs: 'branch if C = 1', beq: 'branch if Z = 1', bne: 'branch if Z = 0', bmi: 'branch if N = 1', bpl: 'branch if N = 0',
  bvc: 'branch if V = 0', bvs: 'branch if V = 1',
  clc: '0 -> C', sec: '1 -> C', cld: '0 -> D', sed: '1 -> D', cli: '0 -> I', sei: '1 -> I', clv: '0 -> V',
  // 65c02
  bra: 'branch always', stz: '0 -> M (the 65CE02: Z -> M)', phx: 'X -> stack', phy: 'Y -> stack', plx: 'stack -> X', ply: 'stack -> Y',
  trb: 'M AND NOT A -> M; A AND M sets Z', tsb: 'M OR A -> M; A AND M sets Z', wai: 'wait for an interrupt', stp: 'stop until reset',
  // 65ce02, 4502, 45gs02
  ldz: 'M -> Z', cpz: 'Z - M sets N Z C', inz: 'Z + 1 -> Z', dez: 'Z - 1 -> Z', phz: 'Z -> stack', plz: 'stack -> Z', taz: 'A -> Z', tza: 'Z -> A',
  tab: 'A -> B (the base page)', tba: 'B -> A', tsy: 'the high byte of S -> Y', tys: 'Y -> the high byte of S', neg: '0 - A -> A', asr: 'bit 7 -> [7..0] -> C',
  inw: 'the word M + 1 -> M', dew: 'the word M - 1 -> M', asw: 'C <- the word M <- 0', row: 'C <- the word M <- C',
  phw: 'a word -> stack', rtn: 'stack + 1 -> PC, then S + n -> S', bsr: 'PC + 2 -> stack, PC + offset -> PC',
  map: 'A X Y Z -> the memory map; interrupts off until EOM', eom: 'the end of a MAP: interrupts again (the NOP opcode)', aug: 'nothing (4 bytes)',
  cle: '0 -> E: a 16 bit stack', see: '1 -> E: an 8 bit stack',
  ldq: 'M (4 bytes) -> Q', stq: 'Q -> M (4 bytes)', adcq: 'Q + M + C -> Q, C', sbcq: 'Q - M - (1 - C) -> Q, C', andq: 'Q AND M -> Q', orq: 'Q OR M -> Q',
  eorq: 'Q XOR M -> Q', cpq: 'Q - M sets N Z C', cmpq: 'Q - M sets N Z C', bitq: 'Q AND M sets Z; bit 31 of M -> N, bit 30 -> V',
  aslq: 'C <- Q <- 0', lsrq: '0 -> Q -> C', rolq: 'C <- Q <- C', rorq: 'C -> Q -> C', asrq: 'bit 31 -> Q -> C', inq: 'Q + 1 -> Q', deq: 'Q - 1 -> Q',
  // 65816
  xba: 'the high and the low byte of C swap', xce: 'C <-> E (the emulation mode)', rep: 'P AND NOT #n -> P', sep: 'P OR #n -> P',
  jsl: 'PB, PC + 3 -> stack, the long address -> PB, PC', jml: 'the long address -> PB, PC', rtl: 'stack -> PC + 1, PB', brl: 'branch always, 16 bit offset',
  mvn: 'C + 1 bytes from X to Y, upwards (the banks: the operands)', mvp: 'C + 1 bytes from X to Y, downwards', tcd: 'C -> D', tdc: 'D -> C', tcs: 'C -> S', tsc: 'S -> C',
  txy: 'X -> Y', tyx: 'Y -> X', phb: 'DB -> stack', plb: 'stack -> DB', phd: 'D -> stack', pld: 'stack -> D', phk: 'PB -> stack', pea: 'a word -> stack',
  pei: '(dp) -> stack', per: 'PC + offset -> stack', cop: 'the COP interrupt', wdm: 'nothing (reserved)',
  // undocumented (NMOS)
  lax: 'M -> A, X', sax: 'A AND X -> M', dcp: 'M - 1 -> M, then CMP', isc: 'M + 1 -> M, then SBC', slo: 'ASL M, then ORA', rla: 'ROL M, then AND',
  sre: 'LSR M, then EOR', rra: 'ROR M, then ADC', anc: 'A AND #n -> A, N -> C', alr: 'A AND #n, then LSR A', arr: 'A AND #n, then ROR A', sbx: '(A AND X) - #n -> X',
  las: 'M AND S -> A, X, S', jam: 'the CPU stops (only a reset goes on)',
};
for (const [m, t] of Object.entries({ lbcc: 'C = 0', lbcs: 'C = 1', lbeq: 'Z = 1', lbne: 'Z = 0', lbmi: 'N = 1', lbpl: 'N = 0', lbvc: 'V = 0', lbvs: 'V = 1' })) OPERATION[m] = `branch if ${t}, 16 bit offset`;
OPERATION.lbra = 'branch always, 16 bit offset';
for (let n = 0; n < 8; n++) {
  OPERATION[`rmb${n}`] = `0 -> bit ${n} of M`;
  OPERATION[`smb${n}`] = `1 -> bit ${n} of M`;
  OPERATION[`bbr${n}`] = `branch if bit ${n} of M = 0`;
  OPERATION[`bbs${n}`] = `branch if bit ${n} of M = 1`;
}
// what an instruction does; the NMOS 6502's asr is the undocumented ALR
export const operationOf = (cpu, name) => (CPU_ALIASES[String(cpu).toLowerCase()] === 'm68k' ? null
  : name === 'asr' && /^(6510|nmos6502)$/i.test(String(cpu)) ? OPERATION.alr : OPERATION[name] ?? null);

// a value with what it is on the machine: the register or the area it addresses (its bits), as hex, decimal
// and binary. name: the symbol it is the value of; immediate: #n, a value and no address; decimal: BASIC
// (decimal first); where: where the symbol is defined
export function valueDoc(machine, value, { name = null, immediate = false, decimal = false, where = null } = {}) {
  if (value == null || !Number.isFinite(value)) return null;
  const v = Math.trunc(value), u = v < 0 ? v & 0xffff : v, wide = u > 0xff;
  const hexs = `$${u.toString(16).padStart(wide ? 4 : 2, '0')}`;
  const bin = `%${u.toString(2).padStart(wide ? 16 : 8, '0')}`;
  const forms = decimal ? `${v} · ${hexs} · ${bin}` : `${hexs} · ${v} · ${bin}`;
  const s = !immediate && machine && u <= 0xffff ? symbolsFor(machine).at(u) : null;
  const notes = [where];
  if (s?.sym.read) notes.push(`read: ${s.sym.read}`);
  if (immediate && u <= 0xff) notes.push(`low nibble ${u & 15}, high nibble ${u >> 4}`);
  return {
    title: name ? `${name} = ${hexs}` : s ? `${s.name}${s.offset ? `+${s.offset}` : ''}` : forms.split(' · ')[0],
    desc: s ? s.desc : immediate ? 'a value' : name ? 'an address or a value' : 'an address (no register of the machine)',
    syntax: forms,
    bits: s && !s.offset ? describeBits(machine, s.sym.name) : [],
    notes: notes.filter(Boolean),
  };
}

// where the code of a line ends: at its comment (outside the strings)
function codeEnd(line, comment) {
  let quote = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quote = !quote;
    else if (!quote && line.startsWith(comment, i)) return i;
  }
  return line.length;
}
const inString = (line, col) => ((line.slice(0, col).match(/"/g) ?? []).length % 2) === 1;
const lineOf = (text, at) => {
  const ls = text.lastIndexOf('\n', at - 1) + 1, nl = text.indexOf('\n', at);
  return { ls, line: text.slice(ls, nl < 0 ? text.length : nl), col: at - ls };
};

// the doc of the word of an assembler source at an offset: a mnemonic (its modes, opcodes, cycles, flags and
// what it does), a pseudo op or directive, a number or a symbol (its value, the register it is on the
// machine with its bits). -> { from, to, docs } or null
export function asmHover(text, at, { cpu = '6502', machine = null, isMnemonic, comment = ';', pseudo = () => null, valueOf = () => null, whereOf = () => null }) {
  const { ls, line, col } = lineOf(text, at);
  if (col >= codeEnd(line, comment) || inString(line, col)) return null;
  const re = /(#?)(\$[0-9a-f]+|0x[0-9a-f]+|%[01]+|\d+|[!.]?@?[A-Za-z_]\w*)/gi;
  for (let m; (m = re.exec(line));) {
    if (col < m.index || col >= m.index + m[0].length) continue;
    const word = m[2], from = ls + m.index, to = from + m[0].length;
    const num = /^\$/.test(word) ? parseInt(word.slice(1), 16) : /^0x/i.test(word) ? parseInt(word.slice(2), 16)
      : /^%/.test(word) ? parseInt(word.slice(1), 2) : /^\d/.test(word) ? Number(word) : null;
    if (num != null) return { from, to, docs: [valueDoc(machine, num, { immediate: !!m[1] })] };
    const p = (m[1] && pseudo('#' + word)) || pseudo(word);
    if (p) return { from, to, docs: [p] };
    if (isMnemonic(word)) {
      const d = mnemonicDoc(cpu, word);
      if (!d) return null;
      return { from, to, docs: [{ ...d, operation: operationOf(cpu, word.toLowerCase()), notes: [...(d.notes ?? []), `CPU: ${cpu}`] }] };
    }
    const v = valueOf(word), where = whereOf(word);
    if (v == null && !where) return null;
    return { from, to, docs: [valueDoc(machine, v, { name: word, where }) ?? { title: word, desc: 'a symbol: its value comes with a build', notes: [where] }] };
  }
  return null;
}

// the doc of what is at an offset of a BASIC source: a keyword (its syntax, parameters, token and dialect) or
// a number (the register it addresses). keywords: the dialect's, longest first. -> { from, to, docs } or null
export function basicHover(text, at, { keywords = [], dialect = null, machine = null }) {
  const { ls, line, col } = lineOf(text, at);
  const low = line.toLowerCase();
  if (inString(line, col)) return null;
  const lead = /^\s*\d*\s*/.exec(line)[0].length;            // the line number
  if (col < lead) return null;
  // the keywords as the tokenizer finds them: from the left, the longest at each place, none in strings or after REM
  for (let pos = lead, quote = false; pos < line.length;) {
    if (line[pos] === '"') { quote = !quote; pos++; continue; }
    if (quote) { pos++; continue; }
    const k = keywords.find(x => x.name && low.startsWith(x.name.toLowerCase(), pos));
    if (k) {
      const end = pos + k.name.length;
      if (col >= pos && col < end) {
        const d = keywordDoc(k);
        const token = Array.isArray(k.token) ? k.token : k.token != null ? [k.token] : null;
        d.notes = [token && `token ${token.map(b => `$${b.toString(16).padStart(2, '0')}`).join(' ')}`, k.short && `short form: ${k.short}`, dialect && `dialect: ${dialect}`].filter(Boolean);
        return { from: ls + pos, to: ls + end, docs: [d] };
      }
      if (/^rem$/i.test(k.name)) return null;
      pos = end;
      continue;
    }
    const n = /^(\$[0-9a-f]+|&h[0-9a-f]+|\d+)/i.exec(line.slice(pos));
    if (n && !/[a-z_]/i.test(line[pos - 1] ?? '')) {
      const end = pos + n[0].length;
      if (col >= pos && col < end) {
        const t = n[0], hexed = t[0] === '$' || /^&h/i.test(t);
        const v = t[0] === '$' ? parseInt(t.slice(1), 16) : hexed ? parseInt(t.slice(2), 16) : Number(t);
        return { from: ls + pos, to: ls + end, docs: [valueDoc(machine, v, { decimal: !hexed })] };
      }
      pos = end;
      continue;
    }
    pos++;
  }
  return null;
}
