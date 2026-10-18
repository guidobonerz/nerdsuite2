// petscii.js - PETSCII glyphs, map resolution and conversion of text maps
//
// Place maps store real PETSCII glyphs as used by the C64 Pro Mono font:
//   U+EE00 + screen code   upper case / graphics character set
//   U+EF00 + screen code   lower / upper case character set
// plus an optional color map with one hex digit per cell (the colours 16-127 of the TED: one character
// each from U+0100, colorDigit). Plain text still works and is resolved like the compiler does.

import { symbols, walk } from './adv.js';
import { numValue } from './advgen.js';

export const PETSCII_UPPER = 0xee00;
export const PETSCII_LOWER = 0xef00;
export const COLOR_DIGITS = '0123456789abcdef';

export const isPetscii = ch => {
  const o = ch?.charCodeAt(0);
  return o >= PETSCII_UPPER && o <= PETSCII_LOWER + 0xff;
};

export const petsciiChar = (code, charset = 'lower') =>
  String.fromCharCode((charset === 'upper' ? PETSCII_UPPER : PETSCII_LOWER) + (code & 0xff));

// the digit of a colour: 0-f, the colours 16-127 of the TED U+0110-U+017F (one character a cell)
const WIDE = 0x100;
export const colorDigit = color => ((color &= 0x7f) < 16 ? COLOR_DIGITS[color] : String.fromCharCode(WIDE + color));
export const digitColor = digit => {
  const d = COLOR_DIGITS.indexOf(digit.toLowerCase());
  if (d >= 0) return d;
  const o = digit.charCodeAt(0) - WIDE;
  return o >= 16 && o < 128 ? o : -1;
};

// port of screencode() in advc/adv/compile.go
export function screencode(ch, charset) {
  const o = ch.charCodeAt(0);
  if (ch >= 'a' && ch <= 'z') return o - 96;
  if (ch >= 'A' && ch <= 'Z') return charset === 'upper' ? o - 64 : o;
  if (ch === '@') return 0;
  if (o >= 32 && o <= 63) return o;
  return { '[': 27, ']': 29, '^': 30, '_': 100 }[ch] ?? 32;
}

// [screen code, color] of one map cell, same rules as the compiler
export function resolveCell(ch, digit, textcolor, charset) {
  let color = textcolor;
  const code = isPetscii(ch) ? ch.charCodeAt(0) & 0xff : screencode(ch, charset);
  const d = digit ? digitColor(digit) : -1;
  if (d >= 0) color = d;
  return [code, color];
}

export function resolveMap(lines, colorLines, width, height, textcolor, charset) {
  const chars = new Uint8Array(width * height), colors = new Uint8Array(width * height);
  for (let r = 0; r < height; r++) {
    const text = lines?.[r] ?? '', ctext = colorLines?.[r] ?? '';
    for (let c = 0; c < width; c++) {
      const [code, color] = resolveCell(text[c] ?? ' ', ctext[c], textcolor, charset);
      chars[r * width + c] = code;
      colors[r * width + c] = color;
    }
  }
  return { chars, colors };
}

// explicit PETSCII glyphs and color digits, line lengths unchanged
export function mapToPetscii(lines, colorLines, textcolor, charset) {
  const out = { lines: [], colors: [] };
  lines.forEach((text, r) => {
    const ctext = colorLines?.[r] ?? '';
    let l = '', cl = '';
    for (let c = 0; c < text.length; c++) {
      const [code, color] = resolveCell(text[c], ctext[c], textcolor, charset);
      l += petsciiChar(code, charset);
      cl += colorDigit(color);
    }
    out.lines.push(l);
    out.colors.push(cl);
  });
  return out;
}

const isMap = n => n.kind === 'background' || n.kind === 'patch';

// maps that still use text characters
export function legacyMaps(game) {
  const found = [];
  walk(game, n => { if (isMap(n) && n.lines.some(l => [...l].some(ch => !isPetscii(ch)))) found.push(n); });
  return found;
}

// convert all maps to PETSCII glyphs + color maps. The compiled binary does not change.
export function convertGameToPetscii(game) {
  const S = symbols(game);
  const consts = Object.fromEntries(S.consts.map(c => [c.name, c.value]));
  let maps = 0;
  const convert = (n, textcolor) => {
    Object.assign(n, mapToPetscii(n.lines, n.colors, textcolor, S.charset));
    maps++;
  };
  const visit = items => items.forEach(it => {
    if (it.kind === 'place') {
      const tc = it.members.find(m => m.kind === 'attr' && m.key === 'textcolor')?.values[0] ?? '15';
      const textcolor = (numValue(tc, consts) ?? 15) & 15;
      it.members.filter(isMap).forEach(m => convert(m, textcolor));
      visit(it.members.filter(m => m.kind === 'place'));
    } else if (it.kind === 'patch') {
      convert(it, 15);
    }
  });
  visit(game.items);
  return maps;
}

// the ROM characters as the screen editor shows them, position -> screen code: letters,
// digits and signs in code order, then the graphics arranged by shape (lines, corners and
// blocks side by side), then all of it again in reverse video (+ 128). Of the characters
// that look the same ($20/$60, $40/$43, $42/$5D, $65/$74, $67/$6A) the lower code comes first.
const ROM_ORDER_NORMAL = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
  32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47,
  48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63,
  112, 114, 110, 82, 70, 64, 67, 68, 69, 85, 73, 87, 81, 79, 119, 80,
  107, 91, 115, 78, 77, 86, 121, 120, 102, 74, 75, 108, 123, 101, 96, 103,
  109, 113, 125, 95, 105, 118, 117, 104, 92, 94, 97, 124, 126, 76, 111, 122,
  116, 84, 71, 66, 93, 72, 89, 106, 99, 100, 127, 98, 90, 65, 83, 88,
];
export const ROM_ORDER = [...ROM_ORDER_NORMAL, ...ROM_ORDER_NORMAL.map(c => c + 128)];
// screen code -> position in ROM_ORDER
export const ROM_POS = ROM_ORDER.reduce((pos, code, k) => { pos[code] = k; return pos; }, []);
