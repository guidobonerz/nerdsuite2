import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mnemonicDoc, registerDoc, registersLike, paramsOf, activeParam, operandAt, asmHelp } from '../public/js/cpudocs.js';

test('mnemonicDoc: the modes, their opcodes, bytes and cycles, the flags', () => {
  const lda = mnemonicDoc('6510', 'lda');
  assert.deepEqual(lda.modes[0], { syntax: 'lda #imm', op: '$a9', bytes: 2, cycles: 2 });
  assert.equal(lda.modes.find(m => m.syntax === 'lda abs,x').cycles, '4+');
  assert.deepEqual(lda.flags.effects.map(e => e.name), ['N', 'Z']);
  assert.equal(mnemonicDoc('6510', 'inc').modes.find(m => m.syntax === 'inc abs,x').cycles, 7);
  assert.equal(mnemonicDoc('6510', 'sta').flags.effects.length, 0);
  assert.deepEqual(mnemonicDoc('6510', 'bit').flags.effects.map(e => e.effect), ['bit 7 of the operand', 'bit 6 of the operand', 'changed']);
  assert.deepEqual(mnemonicDoc('6510', 'lsr').flags.effects.map(e => `${e.name}${e.effect}`), ['Ncleared', 'Zchanged', 'Cchanged']);
  assert.deepEqual(mnemonicDoc('z80', 'and').flags.effects.map(e => `${e.name} ${e.effect}`), ['S changed', 'Z changed', 'H set', 'P/V parity', 'N cleared', 'C cleared']);
  assert.equal(mnemonicDoc('6510', 'nosuch'), null);
});

test('registerDoc and registersLike: the registers of a machine and their bits', () => {
  const d = registerDoc('c64', 0xd011);
  assert.match(d.title, /^VIC_CTRL1 · \$d011 · 53265$/);
  assert.ok(d.bits.some(b => b.where === 'bit 4'));
  assert.equal(registerDoc('c64', 0x1234), null);
  assert.deepEqual(registersLike('c64', '5328', { decimal: true }).slice(0, 2).map(r => r.name), ['VIC_BORDER', 'VIC_BG_COLOR0']);
  assert.equal(registersLike('c64', '$d02')[0].text, '$d020');
});

test('BASIC: the parameters of a syntax and the one at the caret', () => {
  assert.deepEqual(paramsOf('FOR v = start TO end [STEP inc]', 'for').map(p => p.name), ['v', 'start', 'end', 'inc']);
  assert.deepEqual(paramsOf('POKE addr, value', 'poke').map(p => p.name), ['addr', 'value']);
  assert.equal(activeParam('FOR v = start TO end [STEP inc]', 'for', ' i=1 to 10 step '), 3);
  assert.equal(activeParam('FOR v = start TO end [STEP inc]', 'for', ' i='), 1);
  assert.equal(activeParam('POKE addr, value', 'poke', ' 53280'), 0);
  assert.equal(activeParam('POKE addr, value', 'poke', ' 53280,'), 1);
  assert.equal(activeParam('DATA const[, const...]', 'data', ' 1,2,3,'), 0);
});

test('asm: the operand at the caret, the help there', () => {
  const isMnemonic = w => ['lda', 'sta'].includes(w.toLowerCase());
  assert.deepEqual(operandAt('loop  lda $d0', isMnemonic), { mnemonic: 'lda', operand: '$d0' });
  assert.deepEqual(operandAt('  sta ', isMnemonic), { mnemonic: 'sta', operand: '' });
  assert.equal(operandAt('loop', isMnemonic), null);
  const h = asmHelp({ before: '  sta $d011', caret: 11, cpu: '6510', machine: 'c64', isMnemonic });
  assert.deepEqual(h.info.map(d => d.title.split(' ')[0]), ['sta', 'VIC_CTRL1']);
  assert.equal(h.hex.from, 6);
  assert.equal(asmHelp({ before: '  lda #$d0', caret: 10, cpu: '6510', machine: 'c64', isMnemonic }).hex, null);
});
