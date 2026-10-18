import { test } from 'node:test';
import assert from 'node:assert/strict';
import { disassembleAll, toSource } from '../public/js/disasm.js';

// $c000: jsr $c006 / jmp $c000 / rts at $c006
const code = new Uint8Array([0x20, 0x06, 0xc0, 0x4c, 0x00, 0xc0, 0x60]);
const opts = { base: 0xc000, cpu: '6502', entries: [0xc000], regions: [], auto: true };

test('the labels: their own names, in the operands and the source', () => {
  const plain = disassembleAll(code, opts);
  assert.equal(plain.labels.get(0xc006), 'l_c006');
  const named = disassembleAll(code, { ...opts, names: { c006: 'wait', c000: 'main' } });
  assert.equal(named.labels.get(0xc006), 'wait');
  assert.equal(named.labels.get(0xc000), 'main');
  assert.ok(named.lines.some(l => /jsr wait/i.test(l.text)), 'jsr wait');
  assert.ok(named.lines.some(l => /jmp main/i.test(l.text)), 'jmp main');
  assert.match(toSource(named, opts), /^wait\b/m);
});

test('a name for an address nothing points to: a label there all the same', () => {
  const r = disassembleAll(code, { ...opts, names: { c003: 'again' } });
  assert.equal(r.labels.get(0xc003), 'again');
  assert.equal(r.lines.find(l => l.addr === 0xc003)?.label, 'again');
});

test('a renamed label: every reference of the disassembly follows - operands, offsets, data words, the source', () => {
  // $c000: lda $c009,x / jmp $c000 / rts / !word $c009 / data at $c009
  const data = new Uint8Array([0xbd, 0x09, 0xc0, 0x4c, 0x00, 0xc0, 0x60, 0x09, 0xc0, 1, 2, 3]);
  const o = { base: 0xc000, cpu: '6502', entries: [0xc000], auto: true, regions: [{ from: 7, to: 8, type: 'words' }, { from: 9, to: 11, type: 'bytes' }] };
  const before = toSource(disassembleAll(data, o), o);
  const after = toSource(disassembleAll(data, { ...o, names: { c009: 'table' } }), o);
  assert.match(before, /d_c009/);
  assert.doesNotMatch(after, /d_c009/);
  assert.equal((after.match(/\btable\b/g) ?? []).length, (before.match(/\bd_c009\b/g) ?? []).length);
});
