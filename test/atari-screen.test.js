// stage 3 of the graphics of the machines: the Atari 800 XL's text modes in the editors - its colour registers,
// ANTIC 2 and ANTIC 4, its font (atarifont.js) and the palettes of Altirra and Stella. The rules are those
// Altirra 4.40 shows (a test program in ANTIC 2 and 4)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setVideoMachine, PALETTES, ATARI_REGS, antic2Text, atariCellColors } from '../public/js/video.js';
import { placeInfo, cellColors } from '../public/js/c64.js';
import { atariFont, FONT_SIZE } from '../public/js/atarifont.js';
import { CHARGEN } from '../public/js/chargen.js';
import { newCanvas, lookAttrs, screenLook, encodeScreen, decodeScreen } from '../public/js/gfxfile.js';
import { parse } from '../public/js/adv.js';

const on = (id, f) => { setVideoMachine(id); try { return f(); } finally { setVideoMachine('c64'); } };
const game = parse('charset upper\n');
// a screen of 2 chars, its look
const screen = look => {
  const c = newCanvas('s', 2, 1, 'upper');
  c.members[0].lines = [String.fromCharCode(0xee00 + 1, 0xee00 + 0x81)];
  c.members.unshift(...lookAttrs({ bg: 0, border: 0, text: 1, multicolor: null, ecm: null, charset: null, tiles: null, patches: [], ...look }));
  return c;
};

test('the palettes of Altirra and Stella: 16 hues in 8 luminances', () => {
  assert.equal(PALETTES.gtia.colors.length, 128);
  assert.equal(PALETTES.gtia.colors[0], '#000000');
  assert.equal(PALETTES.gtia.colors[7], '#f3ebf8');                 // $0e, the brightest grey
  assert.equal(PALETTES.tia.colors[1], '#4a4a4a');                  // Stella's table
  assert.equal(PALETTES.tia.colors[8], '#484800');
});

test('the colour registers of the OS, COLOR1 on COLOR2', () => {
  assert.deepEqual(ATARI_REGS, [20, 101, 74, 35, 0]);               // $28 $ca $94 $46 $00
  assert.equal(antic2Text(ATARI_REGS), 74 - 2 + 5);                   // the hue of $94, the luminance of $ca: $9a
  assert.deepEqual([...atariCellColors([1, 0x81], ATARI_REGS, true)], [74, 35]);   // ANTIC 4: COLOR2, bit 7 COLOR3
});

test('ANTIC 2: codes 128-255 inverse, the background COLOR2', () => on('atari8', () => {
  const info = placeInfo(game, screen({}));
  assert.equal(info.atari.antic4, false);
  assert.equal(info.bg, ATARI_REGS[2]);
  assert.deepEqual([...info.colors], [antic2Text(ATARI_REGS), antic2Text(ATARI_REGS)]);
  const font = atariFont();
  assert.equal(info.chr[0x81 * 8], font[8] ^ 0xff);
  assert.equal(info.chr[8], font[8]);
}));

test('ANTIC 4: 00 COLOR4, 01 COLOR0, 10 COLOR1, 11 COLOR2 - COLOR3 with bit 7; the registers of the file', () => on('atari8', () => {
  const regs = [1, 2, 3, 4, 5];
  const s = screen({ multicolor: [0, 0], registers: regs });
  const info = placeInfo(game, s);
  assert.equal(info.atari.antic4, true);
  assert.deepEqual([info.bg, ...info.multicolor], [5, 1, 2]);
  assert.deepEqual([...info.colors], [3, 4]);
  assert.equal(info.chr[0x81 * 8], atariFont()[8]);                 // the same glyph: bit 7 is a colour
  assert.deepEqual([...cellColors(info, [0x02, 0x82], null)], [3, 4]);
  // the registers in the screen file
  assert.deepEqual(decodeScreen(encodeScreen({ screen: { w: 1, h: 1, chars: Uint8Array.of(0), colors: null }, patches: new Map(), look: screenLook(s) })).look.registers, regs);
}));

test('the font in the order of the Atari codes: ASCII 32-95, the graphics, the lower case', () => {
  const f = atariFont();
  assert.equal(f.length, FONT_SIZE);
  const glyph = (set, code) => [...CHARGEN.subarray(set * 2048 + code * 8, set * 2048 + code * 8 + 8)];
  assert.deepEqual([...f.subarray(33 * 8, 34 * 8)], glyph(0, 1));   // 33: A
  assert.deepEqual([...f.subarray(16 * 8, 17 * 8)], glyph(0, 48));  // 16: 0
  assert.deepEqual([...f.subarray(97 * 8, 98 * 8)], glyph(1, 1));   // 97: a
  assert.deepEqual([...f.subarray(0, 8)], [0, 0, 0, 0, 0, 0, 0, 0]);   // 0: space
});

test('an Atari picture: the screen memory row after row, its colours, the program that shows it', async () => {
  const { encodeAtariPicture, decodeAtariPicture, atariPictureXex, toReg, fromReg, SCREEN_BYTES } = await import('../public/js/ataribitmap.js');
  assert.equal(toReg(9 * 8 + 2), 0x94);
  assert.equal(fromReg(0xca), 101);
  const rows = Array.from({ length: 192 }, (_, y) => Uint8Array.from({ length: 160 }, (_, x) => (x + y) & 3));
  const regs = [1, 2, 3, 4, 5];
  const mic = encodeAtariPicture({ mc: true, rows, regs });
  assert.equal(mic.length, SCREEN_BYTES + 4);
  assert.equal(mic[0], 0b00011011);                                  // row 0: pixels 0 1 2 3
  assert.equal(mic[40], 0b01101100);                                 // row 1: 1 2 3 0
  assert.deepEqual([...mic.subarray(SCREEN_BYTES)], [5, 1, 2, 3].map(toReg));   // COLOR4, COLOR0, COLOR1, COLOR2
  const back = decodeAtariPicture(mic, true);
  assert.deepEqual([...back.rows[5]], [...rows[5]]);
  assert.deepEqual(back.regs.slice(0, 3), [1, 2, 3]);
  // GRAPHICS 8: 320 pixels of 1 bit, COLOR1 COLOR2 COLOR4
  const hi = encodeAtariPicture({ mc: false, rows: Array.from({ length: 192 }, () => Uint8Array.from({ length: 320 }, (_, x) => x < 8 ? 1 : 0)), regs });
  assert.deepEqual([hi[0], hi[1], hi.length], [0xff, 0, SCREEN_BYTES + 3]);
  // the program: a DOS binary, the picture at $6010
  const xex = atariPictureXex({ mc: true, rows, regs });
  assert.deepEqual([xex[0], xex[1]], [0xff, 0xff]);
  const at = [...xex].findIndex((v, k) => v === 0x10 && xex[k + 1] === 0x60 && xex[k + 2] === 0x0f && xex[k + 3] === 0x7e);   // the segment $6010-$7e0f
  assert.ok(at > 0, 'the segment of the picture');
  assert.deepEqual([...xex.subarray(at + 4, at + 8)], [...mic.subarray(0, 4)]);
});

test('an Atari player: 8 x 16 pixels, a byte a row, a sprite file of version 2', async () => {
  const { SPRITE_COLS, spriteRowBytes } = await import('../public/js/adv.js');
  const adv = await import('../public/js/adv.js');
  const { spriteBlocks, encodeSprites, decodeSprites } = await import('../public/js/gfxfile.js');
  on('atari8', () => {
    assert.deepEqual([adv.SPRITE_COLS, adv.SPRITE_ROWS, adv.SPRITE_BLOCK, adv.spriteRowBytes()], [8, 16, 16, 1]);
    const art = ['X.......', '.X......', ...Array(14).fill('........')];
    assert.deepEqual([...spriteBlocks(art, false)].slice(0, 3), [0x80, 0x40, 0]);
    // two parts side by side: two players, 16 bytes each
    assert.equal(spriteBlocks(art.map(l => l + 'XXXXXXXX'), false, 2, 1).length, 32);
    const file = encodeSprites({ multicolor: false, w: 1, h: 1, colors: [20], frames: [{ name: 'stand', default: true, data: spriteBlocks(art, false) }], layers: [] });
    const back = decodeSprites(file);
    assert.equal(back.frames[0].data.length, 16);
    assert.equal(back.frames[0].data[0], 0x80);
  });
  // the C64's again: 24 x 21, 64 bytes; a file of the Atari's sprites is refused
  assert.deepEqual([adv.SPRITE_COLS, adv.SPRITE_ROWS, adv.SPRITE_BLOCK], [24, 21, 64]);
  assert.equal(SPRITE_COLS, 24);
  assert.equal(spriteRowBytes(), 3);
});
