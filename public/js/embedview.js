// embedview.js - the data of an @embed in the BASIC editor (basic/preprocess.js): what the line puts into
// its DATA, shown after its end when the bar asks for it (codeview.js): a picture of a sprite, of the
// characters, of a screen or a Koala bitmap, one line high, and how many bytes and DATA lines it makes.

import { h } from './pui.js';
import { PALETTE } from './c64.js';
import { CHARGEN } from './chargen.js';
import { EMBED, embedLines } from './basic/preprocess.js';

const cache = new Map();          // the line + the size of its file -> { node }

// the picture of a preview as a data: URL, or null (bytes: no picture)
function picture(p) {
  if (typeof document === 'undefined') return null;
  let w, hgt, draw;
  if (p.kind === 'sprite') {
    // the sprites side by side (w x h of them), 24 x 21 pixels each
    w = 24 * p.w; hgt = 21 * p.h;
    draw = px => {
      const mc = ['#00000000', '#9a9a9a', '#e0e0e0', '#6c5eb5'];
      for (let s = 0; s < p.w * p.h; s++) {
        const ox = (s % p.w) * 24, oy = Math.floor(s / p.w) * 21, b = p.data.subarray(s * 64);
        for (let y = 0; y < 21; y++) for (let x = 0; x < 24; x++) {
          const byte = b[y * 3 + (x >> 3)];
          const c = p.multicolor ? mc[(b[y * 3 + (x >> 3)] >> (6 - ((x & 7) & ~1))) & 3] : (byte & (0x80 >> (x & 7)) ? '#e0e0e0' : null);
          if (c && c !== '#00000000') px(ox + x, oy + y, c);
        }
      }
    };
  } else if (p.kind === 'chars') {
    const n = Math.min(p.data.length >> 3, 32);
    w = n * 8; hgt = 8;
    draw = px => { for (let c = 0; c < n; c++) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (p.data[c * 8 + y] & (0x80 >> x)) px(c * 8 + x, y, '#e0e0e0'); };
  } else if (p.kind === 'screen') {
    w = p.w * 8; hgt = p.h * 8;
    draw = px => {
      for (let i = 0; i < p.w * p.h; i++) {
        const ch = p.chars[i], col = PALETTE[(p.colors?.[i] ?? 14) & 15], cx = (i % p.w) * 8, cy = Math.floor(i / p.w) * 8;
        for (let y = 0; y < 8; y++) { const bits = CHARGEN[ch * 8 + y]; for (let x = 0; x < 8; x++) if (bits & (0x80 >> x)) px(cx + x, cy + y, col); }
      }
    };
  } else if (p.kind === 'koala') {
    // 160 x 200 multicolor pixels, two screen pixels wide
    w = 320; hgt = 200;
    draw = (px, ctx) => {
      ctx.fillStyle = PALETTE[p.data[10000] & 15];
      ctx.fillRect(0, 0, 320, 200);
      for (let cell = 0; cell < 1000; cell++) {
        const cx = (cell % 40) * 8, cy = Math.floor(cell / 40) * 8;
        const scr = p.data[8000 + cell], col = p.data[9000 + cell] & 15;
        for (let y = 0; y < 8; y++) {
          const b = p.data[cell * 8 + y];
          for (let x = 0; x < 4; x++) {
            const v = (b >> (6 - x * 2)) & 3;
            if (!v) continue;
            const c = PALETTE[v === 1 ? scr >> 4 : v === 2 ? scr & 15 : col];
            px(cx + x * 2, cy + y, c); px(cx + x * 2 + 1, cy + y, c);
          }
        }
      }
    };
  } else return null;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = hgt;
  const ctx = canvas.getContext('2d');
  const px = (x, y, c) => { ctx.fillStyle = c; ctx.fillRect(x, y, 1, 1); };
  draw(px, ctx);
  return canvas.toDataURL();
}

// the node after an @embed line, or null (no @embed); readFile(path) -> bytes | null
export function embedInlay(line, readFile) {
  const m = EMBED.exec(line);
  if (!m) return null;
  const data = readFile(m[3]);
  const key = `${line}\u0000${data?.length ?? -1}\u0000${data ? data[0] ^ data[data.length >> 1] ^ data[data.length - 1] : 0}`;
  if (cache.has(key)) return cache.get(key);
  const e = embedLines(m, readFile), r = e.r;
  let node;
  if (e.error) node = h('span', { class: 'tok-inlay tok-inlay--error' }, `  ⚠ ${e.error}`);
  else {
    const src = picture(r.preview ?? {});
    const n = e.data.length;
    const first = [...r.bytes.subarray(0, 8)].join(',');
    node = h('span', { class: 'tok-inlay' }, '  ', src && h('img', { class: 'tok-inlay__img', src, alt: '' }),
      ` ${r.note} · ${r.bytes.length} bytes, ${n} DATA line${n === 1 ? '' : 's'}: ${first}${r.bytes.length > 8 ? ',…' : ''}`);
  }
  if (cache.size > 200) cache.clear();
  cache.set(key, node);
  return node;
}
