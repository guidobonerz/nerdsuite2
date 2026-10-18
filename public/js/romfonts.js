// romfonts.js - the character ROM of the machine of the project, for the screen and the char editor:
//   - read from an emulator on this computer when it has it (backend/romfont: VICE for the VIC-20, the PET,
//     the Plus/4 and the C16, the C128; WinAPE for the CPC) - nothing of them is in nerdsuite
//   - else a font like it, in the machine's order of codes, made of the C64's glyphs (chargen.js) and a few
//     drawn ones: the ZX81's, the TRS-80's, the ASCII of the BBC and the CPC (the Atari's: atarifont.js)
// The C64's is the one of chargen.js.
//
//   machineFont()          the font of the machine: { kind: 'commodore', data: 4K in the C64's layout (upper
//                          case set, then lower case) } or { kind: 'codes', data: 2K, its 256 codes }, source
//   loadMachineFont(m)     asks the server once; onFontChange: the font of a machine came
//   textCode(ch)           the code a typed character has on the machine (the text tool)

import { CHARGEN } from './chargen.js';
import { DRAWN, atariFont } from './atarifont.js';
import { screencode } from './petscii.js';
import { charOf } from './zx81.js';

const glyph = (set, code) => CHARGEN.subarray(set * 2048 + code * 8, set * 2048 + code * 8 + 8);
const up = code => glyph(0, code), low = code => glyph(1, code);

// a quarter, half or third of a cell set: the block graphics
const rows = f => Uint8Array.from({ length: 8 }, (_, y) => f(y));
const QUAD = (tl, tr, bl, br) => rows(y => (y < 4 ? (tl ? 0xf0 : 0) | (tr ? 0x0f : 0) : (bl ? 0xf0 : 0) | (br ? 0x0f : 0)));
const GREY = (top, bottom) => rows(y => ((y < 4 ? top : bottom) ? (y & 1 ? 0x55 : 0xaa) : 0));

// ASCII 32-127 as the C64 draws them: upper case from its upper case set, lower case from the other
function ascii(c, { arrows = false } = {}) {
  if (c < 32 || c > 126) return null;
  if (arrows && c >= 91 && c <= 94) return [up(30), DRAWN.down, up(31), DRAWN.right][c - 91];   // the TRS-80: ↑ ↓ ← →
  if (c < 64) return up(c);
  if (c === 64) return up(0);
  if (c <= 90) return up(c - 64);
  if (c >= 97 && c <= 122) return low(c - 96);
  return { 91: up(27), 92: DRAWN.backslash, 93: up(29), 94: DRAWN.caret, 95: up(100), 96: up(28), 123: DRAWN.braceOpen, 124: up(93), 125: DRAWN.braceClose, 126: DRAWN.tilde }[c];
}
Object.assign(DRAWN, {
  braceOpen: [0x0c, 0x18, 0x18, 0x70, 0x18, 0x18, 0x0c, 0x00],
  braceClose: [0x30, 0x18, 0x18, 0x0e, 0x18, 0x18, 0x30, 0x00],
  tilde: [0x00, 0x00, 0x32, 0x4c, 0x00, 0x00, 0x00, 0x00],
});

// 256 codes of 8 bytes from a function of the code (null: blank)
function font256(f) {
  const out = new Uint8Array(2048);
  for (let k = 0; k < 256; k++) { const g = f(k); if (g) out.set(g, k * 8); }
  return out;
}
const inverse = g => g && Uint8Array.from(g, b => b ^ 0xff);

// the ZX81: 64 chars (zx81.js: space, the block graphics, " £ $ : ? ( ) > < = + - * / ; , . 0-9 A-Z), 128-191 inverse
const ZX81_BLOCKS = [null, QUAD(1, 0, 0, 0), QUAD(0, 1, 0, 0), QUAD(1, 1, 0, 0), QUAD(0, 0, 1, 0), QUAD(1, 0, 1, 0), QUAD(0, 1, 1, 0), QUAD(1, 1, 1, 0),
  GREY(1, 1), GREY(0, 1), GREY(1, 0)];
function zx81Glyph(k) {
  if (k < 11) return ZX81_BLOCKS[k];
  const ch = charOf(k);
  return ch === '£' ? up(28) : ascii(ch.charCodeAt(0));
}
const zx81 = () => font256(k => (k < 64 ? zx81Glyph(k) : k >= 128 && k < 192 ? inverse(zx81Glyph(k - 128) ?? new Uint8Array(8)) : null));

// the TRS-80: ASCII (91-94 its arrows), 128-191 the block graphics of 2 x 3: bit 0 top left, 1 top right, 2 middle
// left, 3 middle right, 4 bottom left, 5 bottom right - the rows 0-2, 3-5 and 6-7 of the cell
function trs80Block(bits) {
  return rows(y => { const r = y < 3 ? 0 : y < 6 ? 2 : 4; return (bits >> r & 1 ? 0xf0 : 0) | (bits >> (r + 1) & 1 ? 0x0f : 0); });
}
const trs80 = () => font256(k => (k >= 128 && k < 192 ? trs80Block(k - 128) : ascii(k, { arrows: true })));
const asciiFont = () => font256(k => ascii(k));

// what each machine shows: 'vice' / 'winape' - read from there, else the font made here
const MADE = { zx81, trs80, trs80m3: trs80, bbcb: asciiFont, cpc464: asciiFont, cpc6128: asciiFont, atari8: () => { const out = new Uint8Array(2048); out.set(atariFont()); return out; } };
const READ = new Set(['vic20', 'pet', 'plus4', 'c16', 'c128', 'cpc464', 'cpc6128']);
const COMMODORE = new Set(['c64', 'c128', 'vic20', 'pet', 'plus4', 'c16']);

const loaded = new Map();        // machine -> { kind, data, source }: read from an emulator
const made = new Map();          // machine -> the font made here
const listeners = new Set();
export const onFontChange = f => { listeners.add(f); return () => listeners.delete(f); };
let machine = 'c64';

export function machineFont(m = machine) {
  if (loaded.has(m)) return loaded.get(m);
  if (COMMODORE.has(m)) return { kind: 'commodore', data: CHARGEN.subarray(0, 4096), source: 'the C64 (chargen.js)' };
  if (!MADE[m]) return { kind: 'commodore', data: CHARGEN.subarray(0, 4096), source: 'the C64 (chargen.js)' };
  if (!made.has(m)) made.set(m, { kind: 'codes', data: MADE[m](), source: 'made of the C64 glyphs' });   // made once
  return made.get(m);
}

// the machine of the project: its font from the server, once (the editors draw again when it comes)
// - the same answer for every caller while it is on the way (fontReady: the font of the machine, once it is there)
const asking = new Map();         // machine -> the promise of its font
export function loadMachineFont(m) {
  machine = m;
  if (!READ.has(m)) return Promise.resolve();
  if (!asking.has(m)) asking.set(m, (async () => {
    try {
      const res = await fetch(`api/fonts/${m}`);
      if (!res.ok) return;
      const j = await res.json();
      const data = Uint8Array.from(atob(j.font), c => c.charCodeAt(0));
      loaded.set(m, { kind: COMMODORE.has(m) ? 'commodore' : 'codes', data, source: j.source });
      if (m === machine) for (const f of listeners) f(m);
    } catch { /* no server: the font made here */ }
  })());
  return asking.get(m);
}
export const fontReady = () => loadMachineFont(machine);

// the code of a typed character on the machine (the text tool of the screen editor)
const ZX_CODE = new Map(Array.from({ length: 64 }, (_, k) => [charOf(k), k]));
export function textCode(ch, charset) {
  const c = ch.charCodeAt(0);
  switch (machine) {
    case 'atari8': return c >= 32 && c < 96 ? c - 32 : c >= 96 && c < 128 ? c : 0;
    case 'zx81': return ZX_CODE.get(ch.toUpperCase()) ?? 0;
    case 'trs80': case 'trs80m3': case 'bbcb': case 'cpc464': case 'cpc6128': return c >= 32 && c < 127 ? c : 32;
    default: return screencode(ch, charset);
  }
}
