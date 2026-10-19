// Shift and the mouse over the code (codeeditor.js: lang.hover): the doc of the instruction, the keyword, the
// number or the symbol under the pointer, by the CPU, the dialect and the machine of the project
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asmHover, basicHover, valueDoc, operationOf } from '../public/js/cpudocs.js';
import { acmeLanguage } from '../public/js/lang-acme.js';
import { basicLanguage, keywords } from '../public/js/lang-basic.js';
import { kickassLanguage } from '../public/js/lang-kickass.js';

const at = (text, word, k = 1) => text.indexOf(word) + k;

test('assembler: an instruction - its modes, opcodes, flags and what it does', () => {
  const lang = acmeLanguage({ cpu: () => '6510', machine: () => 'c64' });
  const src = 'start:  adc #$41 ; adc in a comment\n';
  const r = lang.hover(src, at(src, 'adc'));
  assert.deepEqual([r.from, r.to], [8, 11]);
  const [d] = r.docs;
  assert.equal(d.title, 'adc');
  assert.equal(d.operation, 'A + M + C -> A, C');
  assert.ok(d.modes.some(m => m.syntax === 'adc #imm' && m.op === '$69'));
  assert.ok(d.flags.effects.some(e => e.name === 'C'));
  assert.equal(lang.hover(src, at(src, 'adc in')), null);                    // in the comment
  assert.equal(operationOf('6510', 'asr'), operationOf('6510', 'alr'));      // the NMOS asr is ALR
});

test('assembler: a number is the register of the machine, with its bits; #n a value', () => {
  const lang = acmeLanguage({ cpu: () => '6510', machine: () => 'c64' });
  const src = '  sta $d011\n  lda #$1b\n  sta $0428\n';
  const [reg] = lang.hover(src, at(src, '$d011')).docs;
  assert.equal(reg.title, 'VIC_CTRL1');
  assert.match(reg.syntax, /^\$d011 · 53265 · %1101000000010001$/);
  assert.ok(reg.bits.length > 0);
  const [imm] = lang.hover(src, at(src, '#$1b')).docs;
  assert.equal(imm.desc, 'a value');
  assert.equal(lang.hover(src, at(src, '$0428')).docs[0].title, 'SCREEN_RAM+40');
  // the same address on another machine: the MEGA65
  assert.equal(valueDoc('mega65', 0xd031).title, 'VIC3_CTRLB');
});

test('assembler: a symbol - its value from the build or its definition, what it addresses', () => {
  const lang = acmeLanguage({ cpu: () => '6510', machine: () => 'c64', symbols: () => [{ name: 'border', value: 0xd020 }],
    definitions: () => [{ name: 'border', kind: 'const', value: '$d020', file: 'src/main.asm', line: 1 }] });
  const src = 'border = $d020\n  inc border\n  !byte 1\n';
  const [d] = lang.hover(src, at(src, 'inc border', 5)).docs;
  assert.equal(d.title, 'border = $d020');
  assert.match(d.desc, /border color/);
  assert.ok(d.notes.some(n => /src\/main\.asm:1/.test(n)));
  assert.match(lang.hover(src, at(src, '!byte')).docs[0].title, /!byte/);
});

test('assembler: the CPU of the project - the 45GS02 of the MEGA65', () => {
  const lang = acmeLanguage({ cpu: () => 'm65', machine: () => 'mega65' });
  const src = '  ldq [$fb]\n';
  const [d] = lang.hover(src, at(src, 'ldq')).docs;
  assert.equal(d.operation, 'M (4 bytes) -> Q');
  assert.ok(d.modes.some(m => m.op === '$42 $42 $ea $b2'));
});

test('KickAssembler: directives and the library', () => {
  const lang = kickassLanguage({ cpu: () => '_6502', machine: () => 'c64' });
  const src = '  .byte 1\n  lda #<label // lda\n';
  assert.equal(lang.hover(src, at(src, '.byte')).docs[0].title, '.byte');
  assert.equal(lang.hover(src, at(src, 'lda')).docs[0].title, 'lda');
  assert.equal(lang.hover(src, src.lastIndexOf('lda') + 1), null);
});

test('BASIC: a keyword with its syntax, token and dialect; an address of POKE', () => {
  const lang = basicLanguage({ dialect: () => 'v2', machine: () => 'c64' });
  const src = '10 poke 53280,0:print "poke":rem poke\n';
  const r = lang.hover(src, at(src, 'poke'));
  assert.equal(r.docs[0].title, 'POKE');
  assert.ok(r.docs[0].notes.includes('token $97'));
  assert.ok(r.docs[0].notes.includes('dialect: BASIC V2'));
  assert.equal(lang.hover(src, at(src, '53280')).docs[0].title, 'VIC_BORDER');
  assert.match(lang.hover(src, at(src, '53280')).docs[0].syntax, /^53280 · \$d020/);
  assert.equal(lang.hover(src, at(src, '"poke"', 2)), null);                  // in a string
  assert.equal(lang.hover(src, src.lastIndexOf('poke') + 1), null);           // after REM
  assert.equal(lang.hover(src, 1), null);                                      // the line number
  // BASIC 65: a two byte token
  const d = basicHover('10 border 0\n', 4, { keywords: keywords('v65'), dialect: 'BASIC 65', machine: 'mega65' }).docs[0];
  assert.ok(d.notes.includes('token $fe $3c'));
});
