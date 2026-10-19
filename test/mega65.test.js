// the MEGA65: its platform (45GS02, BASIC 65, Xemu), its programs to start with, the tokens of BASIC 65
// (petcat -w65 of VICE), its palette and screen, its memory map
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { platformOf, starterAsm, starterBasic, starterKick } from '../public/js/platforms.js';
import { assemble } from '../public/js/acme/acme.js';
import { tokenize, detokenize } from '../public/js/basic/basic.js';
import { videoOf, PALETTES } from '../public/js/video.js';
import { symbolsFor, decodeBits } from '../public/js/memmap.js';
import { emulatorRuns } from '../public/js/toolchain.js';

const p = platformOf('mega65');
const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join(' ');

test('the platform: the 45GS02, BASIC 65 at $2001, run in Xemu', () => {
  assert.equal(p.id, 'mega65');
  assert.equal(p.family, 'commodore');
  assert.deepEqual([p.cpu, p.basic[0], p.basicStart, p.emulator.platform], ['m65', 'v65', 0x2001, 'mega65']);
  assert.ok(emulatorRuns('xemu', p) && !emulatorRuns('vice', p));
});

test('the first assembler program: 10 SYS 8208 at $2001, assembled for the 45GS02', () => {
  const r = assemble('main.asm', new Map([['main.asm', starterAsm(p)]]), { cpu: p.cpu, format: p.format });
  assert.deepEqual(r.errors, []);
  assert.deepEqual([...r.output.slice(0, 2)], [0x01, 0x20]);         // the load address $2001
  assert.match(new TextDecoder().decode(r.output.slice(7, 11)), /8208/);
  assert.match(starterKick(p), /\.const BASIC = \$2001/);
});

test('BASIC 65: the tokens of petcat -w65', () => {
  const src = '10 border 0:background 1:directory:fast:line 1,2,3,4\n20 a=wpeek(53280)+mod(7,3):play "o4 qcdefg":vsync 100:x=a<<2\n';
  const r = tokenize(src, { dialect: 'v65' });
  assert.deepEqual(r.errors, []);
  assert.equal(r.start, 0x2001);
  const out = hex(r.prg);
  // border $fe $3c, background $fe $3b, dir $ee + ectory $fe $29, fast $fe $25, line $e5
  assert.ok(out.includes('fe 3c 20 30 3a fe 3b 20 31 3a ee fe 29 3a fe 25 3a e5'), out);
  // wpeek $ce $10, mod $ce $0b, play $fe $04, vsync $fe $54, << $fe $52
  for (const t of ['ce 10', 'ce 0b', 'fe 04', 'fe 54', 'fe 52']) assert.ok(out.includes(t), t);
  assert.equal(detokenize(r.prg, { dialect: 'v65' }).trim(), src.trim());
  // the names BASIC 65 gave BASIC 7.0's tokens
  for (const [kw, tok] of [['rgraphic(1,2)', 'cc'], ['rcolor(1)', 'cd'], ['rpen(1)', 'd0'], ['paste 1,2,3,4', 'e3'], ['cut 1,2,3,4', 'e4'], ['merge "a"', 'e6'], ['dir', 'ee']]) {
    assert.ok(hex(tokenize(`10 ${kw}\n`, { dialect: 'v65' }).prg).includes(` 0a 00 ${tok}`), kw);
  }
  assert.deepEqual(tokenize(starterBasic(p, 'v65'), { dialect: 'v65' }).errors, []);
});

test('the graphics: the VIC-II modes in the system palette of the MEGA65, an 80 x 25 screen', () => {
  const v = videoOf('mega65');
  assert.equal(v.palette, PALETTES.mega65);
  assert.deepEqual(v.screen, { cols: 80, rows: 25 });
  assert.ok(v.editors.sprites && v.editors.bitmap && v.cells === 'vic2');
  assert.deepEqual(PALETTES.mega65.colors.slice(0, 3), ['#000000', '#ffffff', '#ff0000']);
  assert.equal(PALETTES.mega65.colors[9], '#aa4400');                 // brown: 10, 4, 0
});

test('the memory map: the VIC-IV, four SIDs, the DMA controller', () => {
  const s = symbolsFor('mega65');
  assert.equal(s.at(0xd020).name, 'VIC_BORDER');
  assert.equal(s.at(0xd031).name, 'VIC3_CTRLB');
  assert.equal(s.at(0xd700).name, 'DMA_ADDRLSB');
  assert.deepEqual([s.at(0xd425).name, s.at(0xd425).offset], ['SID2', 5]);
  assert.equal(s.at(0x2001).name, 'BASIC_START');
  assert.match(decodeBits('mega65', 'VIC3_CTRLB', 0xc0), /fast CPU.*80 columns/);
});
