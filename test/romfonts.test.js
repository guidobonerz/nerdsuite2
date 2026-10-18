// the ROM font of the machine of the project (romfonts.js): the C64's of chargen.js, one an emulator here has
// (backend/romfont), else one like the machine's made of the C64's glyphs - and the codes the text tool types
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { machineFont, textCode, loadMachineFont } from '../public/js/romfonts.js';
import { CHARGEN } from '../public/js/chargen.js';
import { romCharset } from '../public/js/c64.js';

const rowsOf = (font, code) => [...font.subarray(code * 8, code * 8 + 8)];

test('the C64 and the Commodores without an emulator: chargen.js', () => {
  assert.equal(machineFont('c64').kind, 'commodore');
  assert.equal(machineFont('c64').data.length, 4096);
  assert.equal(machineFont('vic20').data.buffer, CHARGEN.buffer);
});

test('the ZX81: its 64 chars, the block graphics, inverse from 128', () => {
  const f = machineFont('zx81').data;
  assert.deepEqual(rowsOf(f, 3), [0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]);            // the upper half
  assert.deepEqual(rowsOf(f, 38), rowsOf(CHARGEN, 1));                              // A
  assert.deepEqual(rowsOf(f, 128 + 38), rowsOf(CHARGEN, 1).map(v => v ^ 0xff));     // inverse A
});

test('the TRS-80: ASCII, its arrows, the block graphics of 2 x 3', () => {
  const f = machineFont('trs80').data;
  assert.deepEqual(rowsOf(f, 65), rowsOf(CHARGEN, 1));                              // A
  assert.deepEqual(rowsOf(f, 128 + 1), [0xf0, 0xf0, 0xf0, 0, 0, 0, 0, 0]);         // top left
  assert.deepEqual(rowsOf(f, 128 + 0b100000), [0, 0, 0, 0, 0, 0, 0x0f, 0x0f]);       // bottom right
  assert.deepEqual(rowsOf(f, 91), rowsOf(CHARGEN, 30));                             // [ is the up arrow
});

test('the codes of the text tool on each machine', async () => {
  await loadMachineFont('c64');
  assert.equal(textCode('A', 'upper'), 1);
  await loadMachineFont('atari8');
  assert.equal(textCode('A'), 33);
  assert.equal(textCode(' '), 0);
  await loadMachineFont('zx81');
  assert.equal(textCode('a'), 38);
  assert.equal(romCharset('upper'), machineFont('zx81').data);                     // the screens draw with it
  await loadMachineFont('bbcb');
  assert.equal(textCode('a'), 97);
  await loadMachineFont('c64');
  assert.equal(romCharset('upper').length, 2048);
});
