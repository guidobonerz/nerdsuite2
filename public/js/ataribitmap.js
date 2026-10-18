// ataribitmap.js - the bitmap pictures of the Atari 800 XL: a file of the bitmap editor and a program
// (.xex) that shows one. The picture has no colours of its own per block: the colour registers of the
// whole screen show its pixels (as Altirra 4.40 shows them):
//   GRAPHICS 15 (ANTIC E)  160 x 192, 2 bits a pixel: 00 COLOR4, 01 COLOR0, 10 COLOR1, 11 COLOR2
//   GRAPHICS 8 (ANTIC F)   320 x 192, 1 bit: 0 COLOR2, 1 the hue of COLOR2 in the luminance of COLOR1
// The screen memory is 40 bytes a row, 192 rows: 7680 bytes, row after row.
//
// The files: .mic (GRAPHICS 15) the 7680 bytes and 4 colours - COLOR4, COLOR0, COLOR1, COLOR2;
// .gr8 (GRAPHICS 8) the 7680 bytes and 3 colours - COLOR1, COLOR2, COLOR4. The colours are register
// values ($94: hue 9, luminance 4). A file of only 7680 bytes takes the colours the OS starts with.

import { assemble } from './acme/acme.js';
import { ATARI_REGS } from './video.js';

export const ATARI_ROWS = 192, ROW_BYTES = 40, SCREEN_BYTES = ROW_BYTES * ATARI_ROWS;
// a palette index (hue * 8 + luminance / 2) and the register value
export const toReg = k => ((k >> 3) << 4) | ((k & 7) << 1);
export const fromReg = v => (v >> 4) * 8 + ((v & 15) >> 1);

// the registers COLOR0-COLOR4 (palette indices) and the order of the colours of a file
const MIC_ORDER = [4, 0, 1, 2], GR8_ORDER = [1, 2, 4];

// { mc, rows: 192 arrays of pixel values (160 of 0-3, or 320 of 0/1), regs: 5 palette indices } -> the file
export function encodeAtariPicture({ mc, rows, regs }) {
  const order = mc ? MIC_ORDER : GR8_ORDER;
  const out = new Uint8Array(SCREEN_BYTES + order.length);
  for (let y = 0; y < ATARI_ROWS; y++) {
    const row = rows[y];
    for (let b = 0; b < ROW_BYTES; b++) {
      let v = 0;
      if (mc) for (let x = 0; x < 4; x++) v |= (row[b * 4 + x] & 3) << (6 - 2 * x);
      else for (let x = 0; x < 8; x++) v |= (row[b * 8 + x] & 1) << (7 - x);
      out[y * ROW_BYTES + b] = v;
    }
  }
  order.forEach((r, k) => { out[SCREEN_BYTES + k] = toReg(regs[r]); });
  return out;
}

export const isAtariPicture = (bytes, mc) => bytes.length === SCREEN_BYTES || bytes.length === SCREEN_BYTES + (mc ? MIC_ORDER : GR8_ORDER).length;

export function decodeAtariPicture(bytes, mc) {
  if (!isAtariPicture(bytes, mc)) throw new Error(`${bytes.length} bytes: not an Atari picture (${mc ? '.mic' : '.gr8'}: ${SCREEN_BYTES} bytes and its colours)`);
  const regs = [...ATARI_REGS];
  if (bytes.length > SCREEN_BYTES) (mc ? MIC_ORDER : GR8_ORDER).forEach((r, k) => { regs[r] = fromReg(bytes[SCREEN_BYTES + k]); });
  const rows = Array.from({ length: ATARI_ROWS }, (_, y) => {
    const row = new Uint8Array(mc ? 160 : 320);
    for (let b = 0; b < ROW_BYTES; b++) {
      const v = bytes[y * ROW_BYTES + b];
      if (mc) for (let x = 0; x < 4; x++) row[b * 4 + x] = (v >> (6 - 2 * x)) & 3;
      else for (let x = 0; x < 8; x++) row[b * 8 + x] = (v >> (7 - x)) & 1;
    }
    return row;
  });
  return { mc, rows, regs };
}

// a program the Atari runs (a DOS binary, .xex): it shows the picture until a key is pressed, then goes back.
// The screen memory at $6010, so that row 102 starts at $7000: ANTIC reads no row across a 4K boundary
export function atariPictureXex(pic) {
  const data = encodeAtariPicture(pic).subarray(0, SCREEN_BYTES);
  const mode = pic.mc ? 0x0e : 0x0f, regs = pic.regs.map(toReg);
  const bytes = list => [...list].map(v => `$${v.toString(16).padStart(2, '0')}`).join(', ');
  const src = `!cpu 6502
SDMCTL = $022f
SDLSTL = $0230
COLOR0 = $02c4
CH     = $02fc
SCREEN = $6010
*= $2000
start:  lda SDLSTL
        pha
        lda SDLSTL+1
        pha
        lda #0
        sta SDMCTL              ; no DMA while the display list changes
        ldx #4
-       lda colors,x
        sta COLOR0,x            ; the colours, copied into the GTIA by the OS
        dex
        bpl -
        lda #<dlist
        sta SDLSTL
        lda #>dlist
        sta SDLSTL+1
        lda #$22
        sta SDMCTL              ; the playfield, DMA on
        lda #$ff
        sta CH
-       lda CH                  ; wait for a key
        cmp #$ff
        beq -
        lda #$ff
        sta CH
        lda #0
        sta SDMCTL
        pla
        sta SDLSTL+1
        pla
        sta SDLSTL
        lda #$22
        sta SDMCTL
        rts
colors: !byte ${bytes(regs)}
dlist:  !byte $70, $70, $70
        !byte $${(0x40 | mode).toString(16)}, <SCREEN, >SCREEN
        !fill 101, $${mode.toString(16).padStart(2, '0')}
        !byte $${(0x40 | mode).toString(16)}, $00, $70
        !fill 89, $${mode.toString(16).padStart(2, '0')}
        !byte $41, <dlist, >dlist
*= SCREEN
${Array.from({ length: SCREEN_BYTES / 32 }, (_, k) => `        !byte ${bytes(data.subarray(k * 32, k * 32 + 32))}`).join('\n')}
!run start
`;
  const r = assemble('picture.asm', new Map([['picture.asm', src]]), { format: 'xex' });
  if (!r.ok) throw new Error(`the program of the picture: ${r.errors.map(e => e.msg).join(', ')}`);
  return r.output;
}
