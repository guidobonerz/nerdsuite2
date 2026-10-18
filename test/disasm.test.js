// the Disassembler view's analysis: code found by tracing, the marks of the user, and source that
// assembles to the same bytes again
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { assemble } from '../public/js/acme/acme.js';
import { disassembleAll, toSource, markRange, basicSys, classify, fileLayout, detectBasic } from '../public/js/disasm.js';
import { PLATFORMS, starterAsm } from '../public/js/platforms.js';
import { includeSource, decodeBits, symbolsFor } from '../public/js/memmap.js';

// assembles src (6502 unless cpu) to plain bytes
function bytes(src, cpu = '6510') {
  const r = assemble('main.asm', new Map([['main.asm', src]]), { format: 'plain', cpu });
  assert.deepEqual(r.errors, []);
  return r.output;
}
// the disassembly of data assembles to data again
function roundTrip(data, opts) {
  const src = toSource(disassembleAll(data, opts), opts);
  assert.deepEqual([...bytes(src, opts.cpu)], [...data], src);
  return src;
}

test('marking ranges cuts what overlaps and joins neighbours', () => {
  let r = markRange([], 0, 9, 'code');
  r = markRange(r, 4, 5, 'bytes');
  assert.deepEqual(r, [{ start: 0, end: 3, type: 'code' }, { start: 4, end: 5, type: 'bytes' }, { start: 6, end: 9, type: 'code' }]);
  r = markRange(r, 4, 5, 'code');
  assert.deepEqual(r, [{ start: 0, end: 9, type: 'code' }]);
  assert.deepEqual(markRange(r, 0, 9, 'none'), []);
});

test('the SYS of a BASIC line is the entry', () => {
  const data = bytes('* = $0801\n!word next, 10\n!byte $9e\n!text "2064"\n!byte 0\nnext !word 0\n* = $0810\nrts');
  assert.equal(basicSys(data, 0x0801), 0x0810);
  const { types } = classify(data, { base: 0x0801 });
  assert.equal(types[0x0f], 'code');
  assert.equal(types[0], 'basic');
});

test('auto mode traces the code and leaves the data', () => {
  const src = '* = $c000\nstart jsr sub\n jmp start\ntable !byte 1,2,3,4\nsub ldx #3\nloop lda table,x\n dex\n bpl loop\n rts\nmsg !text "HELLO WORLD"\n';
  const data = bytes(src);
  const r = disassembleAll(data, { base: 0xc000, cpu: '6510' });
  const text = r.lines.map(l => `${l.label ?? ''} ${l.text}`).join('\n');
  assert.match(text, /jsr l_c00a/);
  assert.match(text, /d_c006 !byte \$01, \$02, \$03, \$04/);
  assert.match(text, /lda d_c006,x/);
  assert.match(text, /!text "HELLO WORLD"/);
  roundTrip(data, { base: 0xc000, cpu: '6510' });
});

test('the marks of the user win over the trace', () => {
  const data = bytes('* = $1000\n lda $1006\n sta $1007\n rts\n!byte $a9, $00, $60, $40, $41, $42, $43\n');
  const regions = [{ start: 7, end: 9, type: 'code' }, { start: 10, end: 13, type: 'petscii' }];
  const r = disassembleAll(data, { base: 0x1000, cpu: '6510', regions });
  assert.equal(r.types[7], 'code');
  assert.ok(r.lines.some(l => l.text.startsWith('!pet')));
  assert.ok(r.lines.some(l => l.text === 'sta l_1007'));
  roundTrip(data, { base: 0x1000, cpu: '6510', regions });
});

test('every data type assembles to its bytes', () => {
  const data = Uint8Array.from({ length: 256 }, (_, k) => (k * 37 + 11) & 0xff);
  for (const type of ['bytes', 'words', 'text', 'petscii', 'screen', 'chars', 'sprites', 'bitmap']) {
    roundTrip(data, { base: 0x2000, cpu: '6510', regions: [{ start: 0, end: 255, type }] });
  }
});

test('without auto mode every byte that is not marked is code', () => {
  const data = Uint8Array.from({ length: 512 }, (_, k) => (k * 97 + 3) & 0xff);
  const r = disassembleAll(data, { base: 0x4000, cpu: '6510', auto: false });
  assert.ok(r.types.every(t => t === 'code'));
  roundTrip(data, { base: 0x4000, cpu: '6510', auto: false });
});

test('Z80: calls, relative jumps and returns', () => {
  const src = '!cpu z80\n* = $4000\nstart call func\n jr start\nfunc ld hl,data\n ld a,(hl)\n ret\ndata !byte 1,2,3\n';
  const data = bytes(src, 'z80');
  const r = disassembleAll(data, { base: 0x4000, cpu: 'z80' });
  assert.equal(r.types[r.types.length - 1], 'bytes');
  assert.ok(r.lines.some(l => l.text === 'ld hl,d_400a'));
  roundTrip(data, { base: 0x4000, cpu: 'z80' });
});

test('the demo program round-trips', () => {
  const dir = 'examples/demo';
  const files = new Map();
  const walk = d => { for (const e of readdirSync(join(dir, d), { withFileTypes: true })) { const p = d ? `${d}/${e.name}` : e.name; if (e.isDirectory()) walk(p); else files.set(p, readFileSync(join(dir, p))); } };
  walk('');
  for (const [p, b] of files) if (/\.(asm|inc)$/.test(p)) files.set(p, b.toString('utf8'));
  const r = assemble('src/main.asm', files, { format: 'cbm' });
  assert.ok(r.ok, JSON.stringify(r.errors));
  const data = r.output.subarray(2), base = r.output[0] | r.output[1] << 8;
  roundTrip(data, { base, cpu: '6510' });
});

// a file as the Disassembler view reads it: its layout, the disassembly, the source of it assembled again
function viewRoundTrip(name, file, machine, cpu) {
  const lay = fileLayout(name, file);
  const data = file.subarray(lay.head);
  const opts = { base: lay.base, split: lay.split, entries: lay.entries, noBase: lay.entries.length > 0, cpu: lay.cpu ?? cpu, machine };
  const r = disassembleAll(data, opts);
  const src = toSource(r, { ...opts, name, head: lay.source === 'prg' ? null : file.subarray(0, lay.head) });
  const out = assemble('main.asm', new Map([['main.asm', src]]), { format: lay.source === 'prg' ? 'cbm' : 'plain', cpu: opts.cpu });
  assert.deepEqual(out.errors, [], src);
  assert.deepEqual([...out.output], [...file], src);
  return { r, src };
}

test('every starter program assembles, and its disassembly too', () => {
  for (const p of PLATFORMS) {
    const out = assemble('main.asm', new Map([['main.asm', starterAsm(p)]]), { format: p.format, cpu: p.cpu });
    assert.deepEqual(out.errors, [], p.id);
    // a file that tells its address (a .prg, a cartridge); a .bin of the BBC does not
    if ((p.format === 'plain' || p.format === 'cbm') && fileLayout(`main.${p.format === 'cbm' ? 'prg' : p.ext}`, out.output)) viewRoundTrip(`main.${p.format === 'cbm' ? 'prg' : p.ext}`, out.output, p.id, p.cpu);
  }
});

test('NES: the iNES header, the vectors, the CHR ROM after the code', () => {
  const p = PLATFORMS.find(x => x.id === 'nes');
  const file = assemble('main.asm', new Map([['main.asm', starterAsm(p)]]), { format: 'plain', cpu: '6502' }).output;
  assert.equal(file.length, 16 + 0x4000 + 0x2000);
  const lay = fileLayout('main.nes', file);
  assert.equal(lay.base, 0xc000);
  assert.ok(lay.entries.includes(0xc000), 'the reset vector');
  const { r, src } = viewRoundTrip('main.nes', file, 'nes', '6502');
  assert.ok(r.lines.some(l => l.text === 'stx PPUCTRL'));
  assert.ok(r.lines.some(l => l.text === 'sta PPUMASK' && /\$0a: background in the left 8 · background/.test(l.comment)), src);
  assert.match(src, /!pseudopc \$c000 \{/);
  assert.match(src, /^PPUSTATUS\s+= \$2002/m);
});

test('SNES: 65816 code with 16 bit immediates, the registers and their bits', () => {
  const p = PLATFORMS.find(x => x.id === 'snes');
  const file = assemble('main.asm', new Map([['main.asm', starterAsm(p)]]), { format: 'plain', cpu: '65816' }).output;
  assert.equal(file.length, 0x8000);
  const lay = fileLayout('main.sfc', file);
  assert.deepEqual(lay.entries.slice(0, 1), [0x8000]);
  const { r, src } = viewRoundTrip('main.sfc', file, 'snes', '65816');
  const text = r.lines.map(l => l.text);
  assert.ok(text.includes('ldx #$1fff') && text.includes('lda #$0000'), src);
  assert.ok(r.lines.some(l => l.text === 'sta INIDISP' && /forced blank/.test(l.comment)), src);
  assert.match(src, /!al\n/);
});

test('C64: registers by name, the values stored told in words', () => {
  const data = bytes('* = $c000\n lda #$1b\n sta $d011\n lda #6\n sta $d020\n jsr $ffd2\n rts\n');
  const r = disassembleAll(data, { base: 0xc000, cpu: '6510', machine: 'c64' });
  const by = t => r.lines.find(l => l.text === t);
  assert.match(by('sta VIC_CTRL1').comment, /y scroll 3 · rows 25 · screen on/);
  assert.match(by('sta VIC_BORDER').comment, /color blue/);
  assert.ok(by('jsr CHROUT'));
  roundTrip(data, { base: 0xc000, cpu: '6510', machine: 'c64' });
});

test('VCS: the TIA in the zero page, its read names', () => {
  const data = bytes('* = $f000\n sta $02\n lda $0c\n sta $09\n rts\n');
  const r = disassembleAll(data, { base: 0xf000, cpu: '6502', machine: 'vcs' });
  assert.deepEqual(r.lines.map(l => l.text), ['sta WSYNC', 'lda INPT4', 'sta COLUBK', 'rts']);
  roundTrip(data, { base: 0xf000, cpu: '6502', machine: 'vcs' });
});

test('the include file of every machine assembles', () => {
  for (const p of PLATFORMS) {
    const src = includeSource(p.id, p.name);
    const out = assemble('main.asm', new Map([['main.asm', `!cpu ${p.cpu}\n${src}* = $1000\n nop\n`]]), { format: 'plain', cpu: p.cpu });
    assert.deepEqual(out.errors.filter(e => !/nop/.test(e.msg)), [], p.id);
    if (p.id !== 'pet') assert.ok(symbolsFor(p.id).list.length > 20, p.id);
  }
  assert.equal(decodeBits('c64', 'SID_V1_CTRL', 0x41), 'gate · pulse');
  assert.equal(decodeBits('atari8', 'DMACTL', 0x22), 'playfield normal · display list DMA');
});

test('a .prg is a program of a Commodore: its machine by the load address', () => {
  const prg = Uint8Array.from([0x01, 0x08, 0x0b, 0x08, 0x0a, 0x00, 0x9e, 0x32, 0x30, 0x36, 0x31, 0x00, 0x00, 0x00, 0xa9, 0x00, 0x60]);
  const lay = fileLayout('lines.prg', prg);
  assert.equal(lay.machine, 'c64');
  assert.equal(lay.base, 0x0801);
  assert.equal(fileLayout('x.prg', Uint8Array.from([0x01, 0x1c, 0])).machine, 'c128');
  const r = disassembleAll(prg.subarray(2), { base: 0x0801, cpu: '6510', machine: lay.machine });
  assert.ok(r.lines.some(l => l.text === 'lda #$00' && l.comment === 'entry'));
});

test('BASIC: found by the chain of its lines, a line each, its SYS the entries', () => {
  const src = '* = $0801\n!word l20, 10\n!byte $99, $22\n!text "HI"\n!byte $22, 0\nl20 !word end, 20\n!byte $9e\n!text "2072"\n!byte 0\nend !word 0\n* = $0818\n lda #1\n rts\n';
  const data = bytes(src);
  const b = detectBasic(data, 0x0801);
  assert.deepEqual(b.lines.map(l => l.text), ['10 print"hi"', '20 sys2072']);
  assert.deepEqual(b.sys, [0x0818]);
  assert.equal(b.end, 22);
  // not at a BASIC start: only on a Commodore
  const moved = bytes(src.replace(/\$0801/, '$2001').replace('2072', '8216').replace('$0818', '$2018'));
  assert.equal(detectBasic(moved, 0x2001), null);
  assert.ok(detectBasic(moved, 0x2001, { any: true }));
  const r = disassembleAll(data, { base: 0x0801, cpu: '6510', machine: 'c64' });
  assert.deepEqual(r.lines.filter(l => l.type === 'basic').map(l => l.view), ['10 PRINT"HI"', '20 SYS2072', undefined]);
  assert.deepEqual(r.entries, [0x0818]);
  assert.ok(r.lines.some(l => l.text === 'lda #$01' && l.comment === 'entry'));
  const sysLine = r.lines.find(l => l.view === '20 SYS2072');
  assert.equal(sysLine.note, 'SYS $0818');
  assert.equal(sysLine.comment, '20 sys2072 · SYS $0818');
  assert.equal(sysLine.ref, 0x0818 - 0x0801);
  roundTrip(data, { base: 0x0801, cpu: '6510', machine: 'c64' });
  // a BASIC program without SYS: no code at the load address
  const plain = bytes('* = $0801\n!word end, 10\n!byte $99, 0\nend !word 0\n');
  const p = disassembleAll(plain, { base: 0x0801, cpu: '6510', machine: 'c64' });
  assert.ok(p.types.every(t => t === 'basic'));
  assert.deepEqual(p.entries, []);
});
