// atarifont.js - a font in the order of the Atari's internal character codes, for the screens and the
// char editor of an Atari project: 128 characters, 1024 bytes (.fnt). It is made of the C64's glyphs
// (chargen.js) where they match - the letters, the digits, the box lines - and a few drawn here; it is
// like the Atari's ROM font, not the same (the Atari's lines are two pixels wide).
//
//   0-63    ASCII 32-95:  space ! " # ... 0-9 ... @ A-Z [ \ ] ^ _
//   64-95   the graphics of ATASCII 0-31: heart, box lines, triangles, bars, arrows
//   96-127  diamond, a-z, spade, |, the clear and the cursor arrows

import { CHARGEN } from './chargen.js';

export const FONT_SIZE = 1024;

// a C64 glyph: [the set, 0 upper case / graphics, 1 lower case; its screen code]
const up = code => [0, code], low = code => [1, code];
// the glyphs the C64 has not, as 8 rows
export const DRAWN = {
  backslash: [0x40, 0x60, 0x30, 0x18, 0x0c, 0x06, 0x02, 0x00],
  caret: [0x10, 0x38, 0x6c, 0xc6, 0x00, 0x00, 0x00, 0x00],
  down: [0x18, 0x18, 0x18, 0x18, 0x7e, 0x3c, 0x18, 0x00],
  right: [0x00, 0x18, 0x0c, 0xfe, 0x0c, 0x18, 0x00, 0x00],
  esc: [0x7e, 0x60, 0x60, 0x7c, 0x60, 0x60, 0x7e, 0x00],
  clear: [0xf8, 0xc0, 0xa0, 0x90, 0x08, 0x04, 0x02, 0x00],
  backspace: [0x02, 0x06, 0x0e, 0x1e, 0x0e, 0x06, 0x02, 0x00],
  tab: [0x40, 0x60, 0x70, 0x78, 0x70, 0x60, 0x40, 0x00],
  lowerRight: [0x01, 0x03, 0x07, 0x0f, 0x1f, 0x3f, 0x7f, 0xff],
  lowerLeft: [0x80, 0xc0, 0xe0, 0xf0, 0xf8, 0xfc, 0xfe, 0xff],
  rightBar: Array(8).fill(0x03),
  leftBar: Array(8).fill(0xc0),
  topBar: [0xff, 0xff, 0, 0, 0, 0, 0, 0],
  bottomBar: [0, 0, 0, 0, 0, 0, 0xff, 0xff],
};

// the source of each internal code
function source(i) {
  if (i < 64) {
    const a = i + 32;                                     // ASCII 32-95
    if (a < 64) return up(a);                             // space to ?: the same screen codes
    if (a === 64) return up(0);                           // @
    if (a <= 90) return up(a - 64);                       // A-Z
    return { 91: up(27), 92: 'backslash', 93: up(29), 94: 'caret', 95: up(100) }[a];
  }
  if (i < 96) {
    return [up(83), up(107), 'rightBar', up(125), up(115), up(110), up(78), up(77),       // heart, box lines, slashes
      'lowerRight', up(108), 'lowerLeft', up(124), up(126), 'topBar', 'bottomBar', up(123),   // triangles, quarters, bars
      up(88), up(112), up(64), up(91), up(81), up(98), 'leftBar', up(114),                // club, box lines, ball, half
      up(113), up(97), up(109), 'esc', up(30), 'down', up(31), 'right'][i - 64];
  }
  if (i === 96) return up(90);                            // diamond
  if (i <= 122) return low(i - 96);                       // a-z
  return { 123: up(65), 124: up(93), 125: 'clear', 126: 'backspace', 127: 'tab' }[i];
}

let font = null;
// the font (1024 bytes), made once
export function atariFont() {
  if (font) return font;
  font = new Uint8Array(FONT_SIZE);
  for (let i = 0; i < 128; i++) {
    const s = source(i);
    const rows = typeof s === 'string' ? DRAWN[s] : CHARGEN.subarray(s[0] * 2048 + s[1] * 8, s[0] * 2048 + s[1] * 8 + 8);
    font.set(rows, i * 8);
  }
  return font;
}
