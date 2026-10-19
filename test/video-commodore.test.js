// stage 2 of the graphics of the machines: the VIC-20, the TED (Plus/4, C16) and the PET in the editors -
// their palettes in PALETTE, their multicolor modes, the colours of a cell, the TED's pictures. The
// orders of the bit pairs and the TED's matrices are those VICE 3.10 shows (xvic, xplus4)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setVideoMachine, video, colorMask, mcPens, mcPair, mcCell, mcCellColor, colorChoices, colorName, colorValue, PALETTES } from '../public/js/video.js';
import { PALETTE } from '../public/js/c64.js';
import { colorDigit, digitColor, resolveCell } from '../public/js/petscii.js';
import { encodeScreen, decodeScreen, screenLook, lookAttrs, mapToLines, linesToMap, canvasesFrom } from '../public/js/gfxfile.js';
import { encodeTbm, decodeTbm, tedPrg, lumByte, hueByte, TBM_SIZE } from '../public/js/tedbitmap.js';
import { COLOR_NAMES } from '../public/js/adv.js';
import { readAssets, NEW_ASSETS } from '../public/js/assets.js';

const machine = (id, f) => { setVideoMachine(id); try { f(); } finally { setVideoMachine('c64'); } };

test('the machine of the project: its palette in PALETTE, its colour mask', () => {
  machine('plus4', () => {
    assert.equal(PALETTE.length, 128);
    assert.equal(PALETTE[0x71], PALETTES.ted.colors[0x71]);
    assert.equal(colorMask(), 0x7f);
  });
  assert.equal(PALETTE.length, 16);
  assert.equal(PALETTE[2], '#880000');
  machine('vic20', () => { assert.equal(PALETTE[2], '#c13c0e'); assert.equal(colorMask(), 15); });
  machine('pet', () => { assert.equal(video().cells, 'mono'); assert.equal(PALETTE[5], PALETTE[1]); });
});

test('multicolor: the bit pairs of the C64, the VIC-20 and the TED', () => {
  // the C64: 00 background, 01 mc1, 10 mc2, 11 the cell colour & 7
  assert.deepEqual(mcPens(6, [8, 9], 0x0d), [6, 8, 9, 5]);
  assert.deepEqual([mcPair('bg'), mcPair('mc1'), mcPair('mc2'), mcPair('color')], [0, 1, 2, 3]);
  machine('vic20', () => {
    // the VIC-20: 01 the border, 10 the cell colour, 11 the auxiliary colour
    assert.deepEqual(mcPens(2, [5, 7], 8 | 3), [2, 5, 3, 7]);
    assert.deepEqual([mcPair('mc1'), mcPair('color'), mcPair('mc2')], [1, 2, 3]);
    assert.equal(mcCell(13), 13);
  });
  machine('plus4', () => {
    // the TED: $ff15, $ff16, $ff17, the attribute & $77 (hue 0-7 with its luminance)
    assert.deepEqual(mcPens(0x32, [0x45, 0x67], 0x5b), [0x32, 0x45, 0x67, 0x53]);
    assert.equal(mcCell(0x63), 0x6b);
    assert.equal(mcCellColor(0x6f), 0x67);
  });
});

test('the colours a pen offers and their names', () => {
  assert.equal(colorChoices().list.length, 16);
  assert.equal(colorChoices('mc').list.length, 8);
  machine('vic20', () => { assert.equal(colorChoices('cell').list.length, 8); assert.equal(colorName(10), 'pink'); });
  machine('plus4', () => {
    const all = colorChoices(), mc = colorChoices('mc');
    assert.equal(all.list.length, 128);
    assert.equal(all.cols, 16);
    assert.equal(all.list[0], 0x70);                               // the brightest luminance on top
    assert.equal(mc.list.length, 64);
    assert.ok(mc.list.every(c => (c & 15) < 8));
    assert.equal(colorName(0x53), 'cyan 5');
  });
  assert.equal(colorValue(8, COLOR_NAMES), 'orange');
  assert.equal(colorValue(0x71, COLOR_NAMES), '113');
});

test('the colour digits of a map: 0-f, the TED colours 16-127 one character each', () => {
  for (let c = 0; c < 128; c++) assert.equal(digitColor(colorDigit(c)), c);
  assert.equal(colorDigit(10), 'a');
  assert.equal(resolveCell('A', colorDigit(0x71), 1, 'upper')[1], 0x71);
  const m = { w: 2, h: 1, chars: Uint8Array.from([1, 2]), colors: Uint8Array.from([0x71, 3]) };
  const lines = mapToLines(m, 'upper');
  assert.deepEqual([...linesToMap(lines.lines, lines.colors, 'upper').colors], [0x71, 3]);
});

test('a screen file of version 3 keeps the look of a canvas', () => {
  const look = { bg: 1, border: 3, text: 6, multicolor: [5, 7], ecm: null, charset: 'gfx/charset/font.chr', tiles: null, patches: [], registers: null };
  const screen = { w: 22, h: 23, chars: new Uint8Array(22 * 23).fill(32), colors: new Uint8Array(22 * 23).fill(14) };
  const back = decodeScreen(encodeScreen({ screen, patches: new Map(), look }));
  assert.deepEqual(back.look, look);
  assert.equal(back.tiles, null);
  assert.equal(decodeScreen(encodeScreen({ screen, patches: new Map() })).look, null);   // version 1 as before
  // the attributes of the canvas and back
  const canvas = { members: lookAttrs(look) };
  assert.deepEqual(canvas.members.map(m => m.key), ['bgcolor', 'border', 'textcolor', 'multicolor', 'charset']);
  assert.deepEqual(screenLook(canvas), look);
  assert.equal(screenLook({ members: lookAttrs({ ...look, bg: 0x71, multicolor: null }) }).bg, 0x71);
});

test('a canvas of a version 3 file: its lines, its colours and its look', () => {
  const look = { bg: 1, border: 3, text: 6, multicolor: null, ecm: null, charset: null, tiles: null, patches: [], registers: null };
  const chars = new Uint8Array(22 * 23).fill(32);
  chars[11 * 22 + 6] = 13;
  const file = encodeScreen({ screen: { w: 22, h: 23, chars, colors: new Uint8Array(22 * 23).fill(6) }, patches: new Map(), look });
  const [c] = canvasesFrom(readAssets(NEW_ASSETS), new Map([['gfx/screen/title.scr', file]]));
  const bg = c.members.find(m => m.kind === 'background');
  assert.equal(bg.lines.length, 23);
  assert.equal(bg.lines[11].charCodeAt(6), 0xee00 + 13);
  assert.equal(bg.colors[11], '6'.repeat(22));
  assert.deepEqual(screenLook(c), look);
});

test('a TED picture: luminances and hues as the TED reads them, the file and the program', () => {
  // the set pixels (01) take the low nibble of the luminance and the high nibble of the hue
  assert.equal(lumByte(0x15, 0x72), 0x71);
  assert.equal(hueByte(0x15, 0x72), 0x52);
  const cells = Array.from({ length: 1000 }, (_, k) => [(k * 7 + 1) & 0x7f || 0x71, 0x46]);
  const pic = { mc: true, bitmap: Uint8Array.from({ length: 8000 }, (_, k) => k & 255), cells, bg: 0x32, bg2: 0x56 };
  const tbm = encodeTbm(pic);
  assert.equal(tbm.length, TBM_SIZE);
  assert.deepEqual([tbm[0], tbm[1]], [0x00, 0x18]);
  const back = decodeTbm(tbm);
  assert.equal(back.mc, true);
  assert.deepEqual([back.bg, back.bg2], [0x32, 0x56]);
  // hue 0 is black at every luminance: such a colour comes back as 0
  assert.deepEqual(back.cells.slice(0, 50), cells.slice(0, 50).map(([a, b]) => [a & 15 ? a : 0, b]));
  assert.deepEqual([...back.bitmap.subarray(0, 300)], [...pic.bitmap.subarray(0, 300)]);
  const prg = tedPrg(pic);
  assert.deepEqual([prg[0], prg[1]], [0x01, 0x10]);                    // $1001, 10 SYS4109
  assert.deepEqual([...prg.subarray(2 + 0x1800 - 0x1001, 2 + 0x1800 - 0x1001 + 4)], [...tbm.subarray(2, 6)]);
});
