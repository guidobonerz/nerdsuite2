import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { preprocess, activeLines, embedData, parseDefines, resolveEmbeds } from '../public/js/basic/preprocess.js';

const texts = r => r.lines.map(l => l.text);

test('@if / @else / @end with the defines of the project', () => {
  const src = '10 print "a"\n@if debug\n20 print "debug"\n@else\n30 print "release"\n@end\n40 end';
  assert.deepEqual(texts(preprocess(src, { defines: 'debug' })), ['10 print "a"', '', '20 print "debug"', '', '', '', '40 end']);
  assert.deepEqual(texts(preprocess(src)), ['10 print "a"', '', '', '', '30 print "release"', '', '40 end']);
  assert.equal(preprocess(src).lines[4].src, 5);
});

test('#define in the source, nested blocks, values, @elif', () => {
  const src = ['#define debug', '#define level 2', '@if debug', '@if level = 2', 'a', '@elif level = 3', 'b', '@else', 'c', '@end', '@end',
    '@if !debug', 'd', '@end', '#undef debug', '@if !debug', 'e', '@end'].join('\n');
  const r = activeLines(src, '');
  assert.deepEqual(r.errors, []);
  const kept = src.split('\n').filter((_, i) => r.active[i]);
  assert.deepEqual(kept, ['a', 'e']);
  assert.equal(activeLines('@if level = 3\nx\n@end', 'level=3').active[1], true);
  assert.deepEqual([...parseDefines('debug, level=2')], [['debug', '1'], ['level', '2']]);
});

test('the errors of the directives', () => {
  assert.deepEqual(activeLines('@else\n@end\n@if x\n@if a b c\n@end', '').errors.map(e => `${e.line}: ${e.msg}`), [
    '1: @else without @if', '2: @end without @if', '3: @if without @end']);          // a block left out: its conditions are not read
  assert.match(activeLines('@if a b c\n@end', '').errors[0].msg, /'a b c' is no condition/);
  assert.match(activeLines('@define debug', '').errors[0].msg, /#define debug/);         // only #define names a name
});

const files = {
  'gfx/chars.chr': Uint8Array.from({ length: 2048 }, (_, k) => k & 0xff),
  'gfx/dave.spr': new Uint8Array(readFileSync(new URL('../examples/demo/gfx/sprite/Dave.spr', import.meta.url))),
  'data.bin': Uint8Array.from([1, 2, 3, 4, 5]),
};
const readFile = p => files[p] ?? null;

test('@embed: DATA lines with the bytes of a file, numbered on, or in the label mode', () => {
  const r = preprocess('10 data @embed charset "gfx/chars.chr", , 1, 3\n100 end', { readFile });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(texts(r), ['10 data 8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23', '11 data 24,25,26,27,28,29,30,31', '100 end']);
  assert.deepEqual(r.lines.map(l => l.src), [1, 1, 2]);
  const l = preprocess('  data @embed binary "data.bin", 16, 1, 3', { readFile, labelMode: true });
  assert.deepEqual(texts(l), ['  data 2,3,4']);
  assert.match(preprocess('10 data @embed charset "gfx/chars.chr"\n11 end', { readFile }).errors[0].msg, /its 128 DATA lines need the numbers 10-137, line 11 comes first/);
});

test('@embed: the items per DATA line after the file', () => {
  const r = preprocess('  data @embed charset "gfx/chars.chr", 8, 1, 2', { readFile, labelMode: true });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(texts(r), ['  data 8,9,10,11,12,13,14,15', '  data 16,17,18,19,20,21,22,23']);
  assert.deepEqual(texts(preprocess('  data @embed binary "data.bin", 2', { readFile, labelMode: true })), ['  data 1,2', '  data 3,4', '  data 5']);
  assert.equal(texts(preprocess('  data @embed binary "data.bin",', { readFile, labelMode: true }))[0], '  data 1,2,3,4,5');
  assert.equal(preprocess('  data @embed binary "data.bin", $4', { readFile, labelMode: true }).lines.length, 2);
  for (const bad of ['0', 'walk', '256']) assert.match(preprocess(`  data @embed binary "data.bin", ${bad}`, { readFile }).errors[0].msg, /items per DATA line/);
  // the numbers of the lines: 128 DATA lines of 16, 256 of 8
  assert.match(preprocess('10 data @embed charset "gfx/chars.chr", 8\n11 end', { readFile }).errors[0].msg, /its 256 DATA lines/);
});

test('resolveEmbeds: the source with its @embed lines as DATA lines, the directives kept', () => {
  const src = '#define debug\n@if debug\n10 data @embed binary "data.bin", , 1, 3\n@end\n100 end';
  const r = resolveEmbeds(src, { readFile });
  assert.deepEqual(r.errors, []);
  assert.equal(r.count, 1);
  assert.equal(r.text, '#define debug\n@if debug\n10 data 2,3,4\n@end\n100 end');
  assert.equal(resolveEmbeds('  data @embed binary "data.bin"', { readFile, labelMode: true }).text, '  data 1,2,3,4,5');
  assert.match(resolveEmbeds('10 data @embed binary "none.bin"', { readFile }).errors[0].msg, /there is no none\.bin/);
});

test('@embed sprite: a frame of the sprite editor by its name or index', () => {
  const s = embedData('sprite', 'gfx/dave.spr', 'right3', readFile);
  assert.equal(s.bytes.length % 64, 0);
  assert.match(s.note, /sprite right3/);
  assert.equal(embedData('sprite', 'gfx/dave.spr', '0', readFile).note.startsWith('sprite left3'), true);
  assert.match(embedData('sprite', 'gfx/dave.spr', 'nope', readFile).error, /has no frame nope/);
  assert.match(embedData('sprite', 'nothere.spr', '', readFile).error, /there is no nothere.spr/);
  assert.match(embedData('sound', 'x.sng', '', () => new Uint8Array(4)).error, /export it as \.sid/);
});
