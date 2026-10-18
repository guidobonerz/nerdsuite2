// tedbitmap.js - the bitmap pictures of the TED (Plus/4, C16): a file of the bitmap editor and a
// program that shows one.
//
// The TED reads a bitmap picture from three areas (as xplus4 of VICE 3.10 shows them):
//   $1800  the luminances, a byte per 8 x 8 cell: the low nibble the luminance of the set pixels
//          (multicolor 01), the high nibble that of the clear ones (multicolor 10)
//   $1c00  the hues, a byte per cell: the high nibble the hue of the set pixels (01), the low nibble
//          that of the clear ones (10)
//   $2000  the bitmap, 8000 bytes, a cell is 8 bytes as on the C64
// Multicolor: 00 is $ff15 (the background), 11 $ff16 - colours of the whole picture. A colour of the
// TED is its luminance (bits 4-6) and its hue (bits 0-3).
//
// The file (.tbm) is nerdsuite's own: the load address $1800 and the memory $1800-$3f3f, with in the
// unused bytes after the luminances $1be8 the mode (0 hires, 1 multicolor), $1be9 $ff15, $1bea $ff16,
// $1beb the border ($ff19). LOAD "X.TBM",8,1 puts it where a program can show it (tedPrg does).

export const TBM_LOAD = 0x1800;
const LUM = 0x1800, HUE = 0x1c00, BITMAP = 0x2000, END = 0x3f40, INFO = 0x1be8;
export const TBM_SIZE = 2 + END - TBM_LOAD;
const CELLS = 1000;

// the two cell colours of a pair: c1 the set pixels (01), c2 the clear ones (10)
const hue = c => c & 15, lum = c => (c >> 4) & 7;
export const lumByte = (c1, c2) => (lum(c2) << 4) | lum(c1);
export const hueByte = (c1, c2) => (hue(c1) << 4) | hue(c2);
const colorOf = (h, l) => (h ? (l << 4) | h : 0);

// { mc, bitmap: 8000 bytes, cells: [[c1, c2], ...] (1000), bg, bg2, border } -> the .tbm bytes
export function encodeTbm({ mc, bitmap, cells, bg = 0, bg2 = 0, border = 0 }) {
  const out = new Uint8Array(TBM_SIZE);
  out[0] = TBM_LOAD & 255; out[1] = TBM_LOAD >> 8;
  const at = a => 2 + a - TBM_LOAD;
  for (let k = 0; k < CELLS; k++) {
    const [c1, c2] = cells[k];
    out[at(LUM) + k] = lumByte(c1, c2);
    out[at(HUE) + k] = hueByte(c1, c2);
  }
  out.set(bitmap.subarray(0, 8000), at(BITMAP));
  out.set([mc ? 1 : 0, bg & 0x7f, bg2 & 0x7f, border & 0x7f], at(INFO));
  return out;
}

export const isTbm = bytes => bytes.length === TBM_SIZE && bytes[0] === (TBM_LOAD & 255) && bytes[1] === TBM_LOAD >> 8;

export function decodeTbm(bytes) {
  if (!isTbm(bytes)) throw new Error(`${bytes.length} bytes: not a TED picture (.tbm, ${TBM_SIZE} bytes from $1800)`);
  const at = a => 2 + a - TBM_LOAD;
  const cells = Array.from({ length: CELLS }, (_, k) => {
    const l = bytes[at(LUM) + k], h = bytes[at(HUE) + k];
    return [colorOf(h >> 4, l & 7), colorOf(h & 15, (l >> 4) & 7)];
  });
  const [mode, bg, bg2, border] = bytes.subarray(at(INFO), at(INFO) + 4);
  return { mc: mode === 1, bitmap: bytes.slice(at(BITMAP), at(BITMAP) + 8000), cells, bg, bg2, border };
}

// a program the Plus/4 and the C16 run: LOAD and RUN show the picture until a key is pressed. It loads
// at $1001 (10 SYS4109) and holds the picture where the TED reads it ($1800-$3f3f)
const PRG_LOAD = 0x1001, PRG_START = 0x100d;
const BASIC = [0x0b, 0x10, 0x0a, 0x00, 0x9e, ...[...'4109'].map(c => c.charCodeAt(0)), 0x00, 0x00, 0x00];
export function tedPrg(pic) {
  const tbm = encodeTbm(pic);
  const out = new Uint8Array(2 + END - PRG_LOAD);
  out[0] = PRG_LOAD & 255; out[1] = PRG_LOAD >> 8;
  const put = (addr, bytes) => out.set(bytes, 2 + addr - PRG_LOAD);
  put(PRG_LOAD, BASIC);
  const sta = a => [0x8d, a & 255, a >> 8], lda = v => [0xa9, v];
  const code = [
    0x78,                                         // sei: the KERNAL's interrupt sets the text screen again
    ...lda(pic.border & 0x7f), ...sta(0xff19),
    ...lda(pic.bg & 0x7f), ...sta(0xff15),
    ...lda(pic.bg2 & 0x7f), ...sta(0xff16),
    0xad, 0x12, 0xff, 0x48,                       // lda $ff12 / pha: as it was
    0x29, 0xc3, 0x09, 0x08, ...sta(0xff12),       // and #%11000011 / ora #%00001000: the bitmap at $2000
    ...lda(0x18), ...sta(0xff14),                 // the matrix at $1800 (luminances), $1c00 (hues)
    ...lda(0x3b), ...sta(0xff06),                 // bitmap, the screen on, 25 rows
    ...lda(pic.mc ? 0x18 : 0x08), ...sta(0xff07), // multicolor or hires, 40 columns
    // a key: the keyboard matrix through $fd30 / $ff08 - every row selected, a pressed key reads a 0 bit
    ...lda(0x00), ...sta(0xfd30), ...sta(0xff08),
    0xad, 0x08, 0xff, 0xc9, 0xff, 0xf0, 0xf6,     // wait: lda $ff08 / cmp #$ff / beq (back to sta $ff08)
    0x68, ...sta(0xff12),                         // pla / sta $ff12
    ...lda(0x1b), ...sta(0xff06),                 // the text screen again
    ...lda(0x08), ...sta(0xff07),
    ...lda(0x08), ...sta(0xff14),                 // the screen at $0c00, its colours at $0800
    ...lda(0x71), ...sta(0xff15),                 // the colours the Plus/4 starts with
    ...lda(0x6e), ...sta(0xff19),
    0x58,                                         // cli
    ...lda(0x93), 0x20, 0xd2, 0xff,               // CHR$(147): a clear screen
    0x60,                                         // rts: back to BASIC
  ];
  if (PRG_START + code.length > TBM_LOAD) throw new Error('the code does not fit below the picture');
  put(PRG_START, code);
  out.set(tbm.subarray(2), 2 + TBM_LOAD - PRG_LOAD);
  return out;
}
