// the longest BASIC line of a platform (Settings › Editor › BASIC and assembler per platform): a build warns
// of a line longer than the screen editor of the machine takes as typed in - a BASIC of tokens counted with
// its keywords as short as they are typed, one of text as written (basic/typed.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { longLines } from '../public/js/nsbuild.js';
import { typedLength, tokenBased, limitColumn } from '../public/js/basic/typed.js';
import { platformPref, setPlatformPref, isPlatformPrefSet } from '../public/js/platformprefs.js';

test('a BASIC of tokens: the keywords as short as they are typed; strings, REM and DATA as they are', () => {
  assert.ok(tokenBased('v2') && tokenBased('v7') && tokenBased('zx81'));
  assert.ok(!tokenBased('atari') && !tokenBased('loco') && !tokenBased('trs80') && !tokenBased('bbc'));
  assert.equal(typedLength('10 print "hello"', 'v2'), 12);                 // 10_ ? _ "hello"
  assert.equal(typedLength('10 poke 53280,0', 'v2'), 13);                  // pO
  assert.equal(typedLength('10 gosub 100', 'v2'), 10);                     // goS: gO is GOTO
  assert.equal(typedLength('10 goto 100', 'v2'), 9);                       // gO
  assert.equal(typedLength('10 if a then 20', 'v2'), 13);                  // IF has no shorter form, tH
  assert.equal(typedLength('10 rem poke poke', 'v2'), 16);                 // REM (rE is READ), its text as it is
  assert.equal(typedLength('10 data print,poke:poke 1,2', 'v2'), 23);      // dA, the data as it is, after : a statement again
  assert.equal(typedLength('  10 print "{clr}hi"  ', 'v2'), 10);           // {clr}: one key; the spaces around: none
  assert.equal(typedLength('10 print "{3 right}"', 'v2'), 10);
  assert.equal(typedLength('10 print "{nope}"', 'v2'), 13);                // no code: its characters
});

test('a BASIC of text: as written', () => {
  assert.equal(typedLength('10 PRINT "HELLO"', 'atari'), 16);
  assert.equal(typedLength('10 PRINT "HELLO"', 'loco'), 16);
});

test('the column where a line passes the limit', () => {
  assert.equal(limitColumn('10 print "abcdef"', 10, 'atari'), 10);
  assert.equal(limitColumn('10 print "abcdef"', 10, 'v2'), 14);            // print: one key - 4 columns more
  assert.equal(limitColumn('  10 print "abcdef"', 10, 'atari'), 12);       // the indent is no key
  assert.equal(limitColumn('10 print "abc"', 20, 'v2'), null);             // it fits
});

test('longLines: the lines over the limit; 0 no limit', () => {
  const text = `10 print "${'x'.repeat(60)}"\n20 print "${'x'.repeat(80)}"\n30 end`;
  assert.deepEqual(longLines(text, 80, 'v2'), [{ line: 2, length: 87 }]);
  assert.deepEqual(longLines(text, 80, 'atari'), [{ line: 2, length: 91 }]);
  assert.deepEqual(longLines(text, 0, 'v2'), []);
});

test('the limit of a platform: its default, or the setting', () => {
  assert.equal(platformPref('c64', 'basicLine'), 80);
  assert.equal(platformPref('vic20', 'basicLine'), 88);
  assert.equal(platformPref('c128', 'basicLine'), 160);
  assert.equal(platformPref('zx81', 'basicLine'), 0);
  setPlatformPref('c64', 'basicLine', 120);
  assert.equal(platformPref('c64', 'basicLine'), 120);
  assert.ok(isPlatformPrefSet('c64', 'basicLine'));
  setPlatformPref('c64', 'basicLine', null);
  assert.equal(platformPref('c64', 'basicLine'), 80);
  assert.ok(!isPlatformPrefSet('c64', 'basicLine'));
});
