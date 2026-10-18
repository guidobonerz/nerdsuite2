import { test } from 'node:test';
import assert from 'node:assert/strict';
import { charsOf, screenCode } from '../public/js/petsciipanel.js';

const glyphs = list => new Set(list.map(screenCode));

test('the natural order: the 128 characters of the charset, by their screen code', () => {
  const list = charsOf('natural', 'upper');
  assert.equal(list.length, 128);
  assert.deepEqual(list.map(screenCode), Array.from({ length: 128 }, (_, k) => k));
});

test('the organized order: text first, every glyph of the charset in it', () => {
  for (const cs of ['upper', 'lower']) {
    const list = charsOf('organized', cs);
    assert.deepEqual(list.slice(0, 3), [0x20, 0x21, 0x22], cs);
    assert.equal(glyphs(list).size, 128, cs);
    assert.equal(list.length % 16, 0, `${cs}: full rows of 16 (${list.length})`);
  }
});
