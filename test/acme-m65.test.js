// the 65CE02, the 4502 and the 45GS02 (the MEGA65, ACME's !cpu m65): their opcodes, (zp),z, the 16 bit
// branches (from the third byte of the instruction, as ca65's PutPCRel4510), the quad instructions ($42 $42),
// the 32 bit pointers [zp],z ($ea) - and the disassembler reading them back
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assemble, disassemble, CPU_TABLES } from '../public/js/acme/acme.js';
import { MNEMONICS } from '../public/js/acme/docs.js';

const asm = (src, cpu = 'm65') => assemble('main.asm', new Map([['main.asm', `!cpu ${cpu}\n*= $2000\n${src}`]]), { format: 'plain' });
const bytes = (src, cpu) => {
  const r = asm(src, cpu);
  assert.deepEqual(r.errors, [], src);
  return Array.from(r.output);
};
const h = s => s.trim().split(/\s+/).map(x => parseInt(x, 16));

test('the 65CE02: the Z register, (zp),z, the stack, words', () => {
  for (const [src, out] of [
    ['lda ($fb),z', 'b2 fb'], ['sta ($fb),z', '92 fb'], ['ldz #3', 'a3 03'], ['ldz $1234', 'ab 34 12'], ['ldz $1234,x', 'bb 34 12'],
    ['cpz #1', 'c2 01'], ['cpz $10', 'd4 10'], ['cpz $1234', 'dc 34 12'], ['inz', '1b'], ['dez', '3b'], ['phz', 'db'], ['plz', 'fb'],
    ['taz', '4b'], ['tza', '6b'], ['tab', '5b'], ['tba', '7b'], ['tsy', '0b'], ['tys', '2b'], ['cle', '02'], ['see', '03'],
    ['neg', '42'], ['asr', '43'], ['asr $10', '44 10'], ['asr $10,x', '54 10'], ['inw $10', 'e3 10'], ['dew $10', 'c3 10'],
    ['asw $1234', 'cb 34 12'], ['row $1234', 'eb 34 12'], ['phw #$1234', 'f4 34 12'], ['phw $1234', 'fc 34 12'],
    ['rtn #2', '62 02'], ['jsr ($1234)', '22 34 12'], ['jsr ($1234,x)', '23 34 12'], ['sty $1234,x', '8b 34 12'],
    ['stx $1234,y', '9b 34 12'], ['lda (2,s),y', 'e2 02'], ['sta (2,s),y', '82 02'], ['aug', '5c'], ['rmb3 $10', '37 10'],
  ]) assert.deepEqual(bytes(src, '65ce02'), h(out), src);
  // (zp) is (zp),z now: ACME refuses the old form
  assert.equal(asm('lda ($fb)', '65ce02').ok, false);
});

test('the 16 bit branches count from the third byte of the instruction', () => {
  // $2000: lbne $2000 - the offset from $2002 is -2
  assert.deepEqual(bytes('l: lbne l'), h('d3 fe ff'));
  assert.deepEqual(bytes('bsr t\nt: rts'), h('63 01 00 60'));
  assert.deepEqual(bytes('lbra t\n!fill 300, 0\nt: rts').slice(0, 3), h('83 2d 01'));     // $2003 + 300 - $2002 = 301
  for (const [m, op] of [['lbpl', 0x13], ['lbmi', 0x33], ['lbvc', 0x53], ['lbvs', 0x73], ['lbcc', 0x93], ['lbcs', 0xb3], ['lbeq', 0xf3]]) assert.equal(bytes(`l: ${m} l`)[0], op, m);
});

test('the 4502: map and eom', () => {
  assert.deepEqual(bytes('map\neom\nnop', '4502'), h('5c ea ea'));
  assert.equal(asm('ldq $10', '4502').ok, false);                 // the quad instructions are the 45GS02's
});

test('the 45GS02: [zp],z and the quad instructions', () => {
  for (const [src, out] of [
    ['lda [$fb],z', 'ea b2 fb'], ['sta [$fb],z', 'ea 92 fb'], ['cmp [$fb],z', 'ea d2 fb'],
    ['ldq $fb', '42 42 a5 fb'], ['ldq $1234', '42 42 ad 34 12'], ['ldq ($fb)', '42 42 b2 fb'], ['ldq [$fb]', '42 42 ea b2 fb'],
    ['stq $fb', '42 42 85 fb'], ['adcq $10', '42 42 65 10'], ['sbcq $10', '42 42 e5 10'], ['andq $10', '42 42 25 10'],
    ['orq $10', '42 42 05 10'], ['eorq $10', '42 42 45 10'], ['cpq $10', '42 42 c5 10'], ['cmpq $10', '42 42 c5 10'],
    ['aslq', '42 42 0a'], ['lsrq $10', '42 42 46 10'], ['rolq $10,x', '42 42 36 10'], ['rorq $1234,x', '42 42 7e 34 12'],
    ['inq', '42 42 1a'], ['deq $1234', '42 42 ce 34 12'], ['bitq $1234', '42 42 2c 34 12'], ['asrq', '42 42 43'], ['asrq $10,x', '42 42 54 10'],
  ]) assert.deepEqual(bytes(src), h(out), src);
  // what ACME refuses: lda [zp] without z, ldq #imm, stq (zp),z
  for (const src of ['lda [$fb]', 'ldq #1', 'stq ($fb),z']) assert.equal(asm(src).ok, false, src);
});

test('the disassembler reads the prefixes and the new modes back', () => {
  const src = 'l: ldq [$fb]\nlda [$fb],z\nstq $1234\ninq\nlda ($fb),z\nphw #$1234\nlbne l\nnop\nneg';
  const text = disassemble(Uint8Array.from(bytes(src)), 0x2000, 'm65').map(x => x.text);
  assert.deepEqual(text, ['ldq [$fb]', 'lda [$fb],z', 'stq $1234', 'inq', 'lda ($fb),z', 'phw #$1234', 'lbne $2000', 'nop', 'neg']);   // $ea alone: nop (eom)
  assert.deepEqual(disassemble(Uint8Array.of(0x42, 0x42, 0xa5, 0x10), 0x2000, 'm65')[0].bytes, [0x42, 0x42, 0xa5, 0x10]);
});

test('the help of the code editor knows the new instructions', () => {
  assert.ok(CPU_TABLES.m65.ldq && CPU_TABLES.m65.lda.izl && !CPU_TABLES['65ce02'].ldq);
  assert.ok(MNEMONICS.m65.find(m => m.name === 'ldq').modes.includes('[zp]'));
  assert.ok(MNEMONICS['65ce02'].find(m => m.name === 'lda').modes.includes('(zp),z'));
});
