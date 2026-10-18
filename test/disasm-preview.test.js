// the preview of the disassembler (public/js/disasmview.js): chars and sprites in groups of w x h
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawPreview, groupOf } from '../public/js/disasmview.js';

// a canvas of its own: the size and the pixels drawn (1: not the background)
function canvas() {
  const cv = { width: 0, height: 0, style: {} };
  cv.getContext = () => ({
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: img => { cv.img = img; },
  });
  cv.at = (x, y) => (cv.img.data[(y * cv.width + x) * 4] === 0 && cv.img.data[(y * cv.width + x) * 4 + 3] === 255 ? 0 : 1);
  return cv;
}
const base = { mc: false, colors: [0, 1, 12, 15], zoom: 1 };
// four chars: char k has its pixel at (k, 0) set (bit 7 - k of its first row)
const chars = Uint8Array.from({ length: 32 }, (_, i) => (i % 8 === 0 ? 0x80 >> (i / 8) : 0));

test('groupOf: 1x1 at first, at most 8x8, none for a bitmap', () => {
  assert.deepEqual(groupOf({ mode: 'chars' }), { w: 1, h: 1, down: false });
  assert.deepEqual(groupOf({ mode: 'sprites', group: { w: 12, h: 0, order: 'down' } }), { w: 8, h: 1, down: true });
  assert.deepEqual(groupOf({ mode: 'bitmap', group: { w: 2, h: 2 } }), { w: 1, h: 1, down: false });
});

test('chars 1x1: side by side with a gap', () => {
  const cv = canvas();
  drawPreview(cv, chars, { ...base, mode: 'chars' });
  assert.deepEqual([cv.width, cv.height], [4 * 9 - 1, 8]);
  assert.equal(cv.at(9 + 1, 0), 1);                  // char 1: its pixel 1, after the gap
});

test('chars 2x2 across: one tile of 16 x 16, the chars left to right, then down', () => {
  const cv = canvas();
  drawPreview(cv, chars, { ...base, mode: 'chars', group: { w: 2, h: 2, order: 'across' } });
  assert.deepEqual([cv.width, cv.height], [16, 16]);
  assert.deepEqual([cv.at(0, 0), cv.at(8 + 1, 0), cv.at(2, 8), cv.at(8 + 3, 8)], [1, 1, 1, 1]);
  assert.equal(cv.at(1, 0), 0);
});

test('chars 2x2 down: top to bottom, then the next column', () => {
  const cv = canvas();
  drawPreview(cv, chars, { ...base, mode: 'chars', group: { w: 2, h: 2, order: 'down' } });
  assert.deepEqual([cv.at(0, 0), cv.at(1, 8), cv.at(8 + 2, 0), cv.at(8 + 3, 8)], [1, 1, 1, 1]);
});

test('sprites 2x1: 48 x 21 a group, two groups with a gap', () => {
  const cv = canvas();
  drawPreview(cv, new Uint8Array(64 * 4), { ...base, mode: 'sprites', group: { w: 2, h: 1 } });
  assert.deepEqual([cv.width, cv.height], [2 * 48 + 1, 21]);
  const tall = canvas();
  drawPreview(tall, new Uint8Array(64 * 2), { ...base, mode: 'sprites', group: { w: 1, h: 2 } });
  assert.deepEqual([tall.width, tall.height], [24, 42]);
});
