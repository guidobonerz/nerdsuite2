// the graphics of each machine (public/js/video.js): its editors, its palette, its screen
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { videoOf, hasEditor, PALETTES, GFX_VIEWS } from '../public/js/video.js';
import { PLATFORMS } from '../public/js/platforms.js';

const shown = id => GFX_VIEWS.filter(v => hasEditor(id, v));

test('every machine has a profile with a palette', () => {
  for (const p of PLATFORMS) {
    const v = videoOf(p.id);
    assert.ok(v.palette, p.id);
    assert.ok(v.palette.colors === null ? v.palette.rgb === 15 : v.palette.colors.every(c => /^#[0-9a-f]{6}$/.test(c)), p.id);
  }
});

test('the editors: no sprites without hardware sprites, no bitmap or chars where there are none', () => {
  assert.deepEqual(shown('c64'), ['screen', 'sprites', 'chars', 'tiles', 'bitmap']);
  assert.deepEqual(shown('vic20'), ['screen', 'chars', 'tiles']);
  assert.deepEqual(shown('plus4'), ['screen', 'chars', 'tiles', 'bitmap']);
  assert.deepEqual(shown('pet'), ['screen', 'tiles']);
  assert.deepEqual(shown('vcs'), ['sprites']);
  assert.deepEqual(shown('cpc6128'), ['screen', 'chars', 'tiles', 'bitmap']);
  assert.deepEqual(shown('nes'), ['screen', 'sprites', 'chars', 'tiles']);
  assert.deepEqual(shown('zx81'), ['screen', 'tiles']);
  assert.deepEqual(shown('bbcb'), ['screen', 'chars', 'tiles', 'bitmap']);
  assert.equal(hasEditor('vcs', 'code'), true);                       // not a graphics view: always there
});

test('the palettes: their sizes and the colours of the rules', () => {
  assert.equal(PALETTES.vic2.colors.length, 16);
  assert.equal(PALETTES.vic.colors.length, 16);
  assert.equal(PALETTES.ted.colors.length, 128);
  assert.equal(new Set(PALETTES.ted.colors).size <= 121, true);         // hue 0 is black at every luminance
  assert.equal(PALETTES.gtia.colors.length, 128);                  // 16 hues in 8 luminances, as most modes show them
  assert.equal(PALETTES.tia.colors.length, 128);
  assert.equal(PALETTES.nes.colors.length, 64);
  // the CPC: firmware colour 9 G + 3 R + B
  assert.equal(PALETTES.cpc.colors.length, 27);
  assert.deepEqual([PALETTES.cpc.colors[0], PALETTES.cpc.colors[6], PALETTES.cpc.colors[18], PALETTES.cpc.colors[2], PALETTES.cpc.colors[26]],
    ['#000000', '#ff0000', '#00ff00', '#0000ff', '#ffffff']);
  assert.deepEqual(PALETTES.bbc.colors, ['#000000', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff']);
  assert.deepEqual(videoOf('zx81').screen, { cols: 32, rows: 24 });
});

test('the machines of the later stages: their palette in the editors, any colour a cell', async () => {
  const { setVideoMachine, colorMask, colorChoices, colorName, startColors, hasMulticolor, isMcCell, pickerColors } = await import('../public/js/video.js');
  const { PALETTE } = await import('../public/js/c64.js');
  const on = (id, f) => { setVideoMachine(id); try { f(); } finally { setVideoMachine('c64'); } };
  on('atari8', () => {
    assert.equal(PALETTE.length, 128);
    assert.equal(PALETTE[9 * 8 + 2], PALETTES.gtia.colors[74]);
    assert.equal(colorName(9 * 8 + 2), '$94');                      // the blue of GRAPHICS 0, as its register
    assert.equal(colorChoices().list.length, 128);
    assert.equal(colorChoices('bitmap').list.length, 16);           // a Koala file: 16 of them
    assert.deepEqual(startColors(), { bg: 74, border: 0, text: 77, mc: [20, 101], ecm: null });   // COLOR0, COLOR1 of the OS
    assert.equal(hasMulticolor(), true);                            // ANTIC 4
    assert.equal(isMcCell(9), true);
  });
  on('cpc6128', () => {
    assert.equal(colorMask(), 31);
    assert.equal(PALETTE.length, 32);                                // 27, the rest black
    assert.equal(PALETTE[31], '#000000');
    assert.equal(colorName(24), 'bright yellow');
    assert.equal(colorChoices().cols, 9);
    assert.equal(startColors().text, 24);
  });
  on('nes', () => { assert.equal(PALETTE.length, 64); assert.equal(colorName(0x30), '$30'); });
  on('snes', () => { assert.equal(PALETTE.length, 128); assert.equal(colorName(127), '$7fff'); });
  on('bbcb', () => { assert.equal(PALETTE.length, 8); assert.equal(colorName(3), 'yellow'); assert.deepEqual(colorChoices('bitmap').list, [0, 1, 2, 3, 4, 5, 6, 7]); });
  on('zx81', () => { assert.equal(colorMask(), 1); assert.deepEqual(pickerColors(), { fg: 1, bg: 0 }); });
  assert.equal(PALETTE.length, 16);
});
