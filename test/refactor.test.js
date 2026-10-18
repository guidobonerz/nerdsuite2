import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordAt, renameInSource, localScope } from '../public/js/refactor.js';
import { renameLabel, basicLabelAt } from '../public/js/basic/labels.js';

test('wordAt: the name at the caret, a local one with its . or @', () => {
  assert.deepEqual(wordAt('  jmp loop', 8), { word: 'loop', from: 6, to: 10 });
  assert.equal(wordAt('  bne .next', 9).word, '.next');
  assert.equal(wordAt('  bne @x', 8).word, '@x');
  assert.equal(wordAt('  lda #$10', 9), null);
});

test('renameInSource: whole words outside comments and strings', () => {
  const src = [
    'loop    lda loop2        ; loop again',
    '        jmp loop',
    '        !word loop, loop+1, .loop, $c0de',
    '        !text "loop"',
    'c0de    lda #<loop',
  ].join('\n');
  const r = renameInSource(src, 'loop', 'main');
  assert.equal(r.count, 5);
  assert.equal(r.text, [
    'main    lda loop2        ; loop again',
    '        jmp main',
    '        !word main, main+1, .loop, $c0de',
    '        !text "loop"',
    'c0de    lda #<main',
  ].join('\n'));
  assert.equal(renameInSource(src, 'c0de', 'x').text.includes('$c0de'), true, 'a hex number stays');
});

test('renameInSource: KickAssembler comments, // and /* */', () => {
  const r = renameInSource('loop: jmp loop // loop\n/* loop\nloop */ bne loop', 'loop', 'main', { lang: 'kickass' });
  assert.equal(r.text, 'main: jmp main // loop\n/* loop\nloop */ bne main');
  assert.equal(r.count, 3);
});

test('localScope: a .local in its zone, an @local between its global labels', () => {
  const src = ['!zone a', '.x  nop', '    bne .x', '!zone b', '.x  nop', '    bne .x'].join('\n');
  const [a, b] = localScope(src, src.indexOf('bne .x'), '.x');
  assert.equal(renameInSource(src, '.x', '.y', { from: a, to: b }).text,
    ['!zone a', '.y  nop', '    bne .y', '!zone b', '.x  nop', '    bne .x'].join('\n'));
  const cheap = ['first', '@l  nop', '    bne @l', 'second', '@l  nop', '    bne @l'].join('\n');
  const [c, d] = localScope(cheap, cheap.lastIndexOf('bne @l'), '@l');
  assert.equal(renameInSource(cheap, '@l', '@m', { from: c, to: d }).text,
    ['first', '@l  nop', '    bne @l', 'second', '@m  nop', '    bne @m'].join('\n'));
});

test('renameLabel: the label line and the jumps of a BASIC program', () => {
  const r = renameLabel('loop:\n  print "goto loop"\n  if x then loop\n  on x goto loop, done\n  goto LOOP\ndone:\n  end', 'loop', 'again');
  assert.equal(r.text, 'again:\n  print "goto loop"\n  if x then again\n  on x goto again, done\n  goto again\ndone:\n  end');
  assert.equal(r.count, 4);
});

test('basicLabelAt: the label at the caret - its line, a jump to it, without spaces too', () => {
  const t = 'loop:\n  gotoloop\n  on x gosub loop,done\n  print "loop"\ndone:\n  end';
  const at = (s, k = 0) => t.indexOf(s) + k;
  assert.equal(basicLabelAt(t, 2), 'loop');
  assert.equal(basicLabelAt(t, at('gotoloop', 5)), 'loop');
  assert.equal(basicLabelAt(t, at(',done', 3)), 'done');
  assert.equal(basicLabelAt(t, at('"loop"', 2)), null, 'in a string');
  assert.equal(basicLabelAt(t, at('gotoloop', 1)), null, 'on the keyword');
});
