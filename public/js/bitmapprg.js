// bitmapprg.js - a bitmap picture as a program the C64 runs: LOAD "PICTURE",8,1 (or ,8) and RUN.
// It shows the picture until a key is pressed, then goes back to BASIC with a clear screen.
//
// The file loads at $0801 and puts every part where the VIC reads it, so only the color RAM is
// copied: VIC bank 0, screen RAM at $0c00, bitmap at $2000 ($d018 = $38).
//   $0801  10 SYS2061
//   $080d  the code
//   $0c00  screen RAM (1000 bytes): the two colors of each 8 x 8 block
//   $1000  color RAM (1000 bytes, multicolor): copied to $d800
//   $2000  bitmap (8000 bytes)

export const PRG_LOAD = 0x0801;
export const PRG_START = 0x080d;          // the SYS of the BASIC line
export const PRG_SCREEN = 0x0c00;
export const PRG_COLORS = 0x1000;
export const PRG_BITMAP = 0x2000;
const END = PRG_BITMAP + 8000;

// 10 SYS2061: the link to the next line, the line number, SYS, the address, the end of the program
const BASIC = [0x0b, 0x08, 0x0a, 0x00, 0x9e, ...[...'2061'].map(c => c.charCodeAt(0)), 0x00, 0x00, 0x00];

// bg: $d020 and $d021; mc: multicolor ($d016)
function code(bg, mc) {
  const lo = a => a & 255, hi = a => a >> 8;
  const sta = a => [0x8d, lo(a), hi(a)];
  const set = (reg, v) => [0xa9, v, ...sta(reg)];
  const copy = [];                        // 4 pages from PRG_COLORS to $d800: the 1000 colors
  for (let p = 0; p < 4; p++) copy.push(0xbd, 0x00, hi(PRG_COLORS) + p, 0x9d, 0x00, 0xd8 + p);
  return [
    ...set(0xd011, 0x3b),                 // bitmap mode, 25 rows, the screen on
    ...set(0xd016, mc ? 0x18 : 0x08),     // multicolor or hires, 40 columns
    ...set(0xd018, 0x38),                 // screen RAM $0c00, bitmap $2000
    0xa9, bg & 15, ...sta(0xd020), ...sta(0xd021),
    0xa2, 0x00,                           //       ldx #0
    ...copy,                              // loop: lda PRG_COLORS+p*256,x / sta $d800+p*256,x
    0xe8,                                 //       inx
    0xd0, 0x100 - (copy.length + 3),      //       bne loop
    0x20, 0xe4, 0xff,                     // wait: jsr GETIN
    0xf0, 0xfb,                           //       beq wait
    ...set(0xd011, 0x1b),                 // text mode again, as the C64 starts
    ...set(0xd016, 0xc8),
    ...set(0xd018, 0x15),
    ...set(0xd020, 14),
    ...set(0xd021, 6),
    0x20, 0x44, 0xe5,                     // jsr $e544: clears the screen and fills the color RAM
    0x60,                                 // rts: back to BASIC
  ];
}

// bitmap: 8000 bytes, screen: 1000, colors: 1000 (multicolor) or null; bg the background color
export function bitmapPrg({ bitmap, screen, colors = null, bg = 0, mc = true }) {
  const out = new Uint8Array(2 + END - PRG_LOAD);
  out[0] = PRG_LOAD & 255; out[1] = PRG_LOAD >> 8;
  const put = (addr, bytes) => out.set(bytes, 2 + addr - PRG_LOAD);
  put(PRG_LOAD, BASIC);
  const prog = code(bg, mc);
  if (PRG_START + prog.length > PRG_SCREEN) throw new Error('the code does not fit below the screen RAM');
  put(PRG_START, prog);
  put(PRG_SCREEN, screen.subarray(0, 1000));
  if (mc && colors) put(PRG_COLORS, colors.subarray(0, 1000));
  put(PRG_BITMAP, bitmap.subarray(0, 8000));
  return out;
}
