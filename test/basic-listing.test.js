import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, detokenize } from '../public/js/basic/basic.js';
import { DIALECTS } from '../public/js/basic/dialects.js';
import { ATASCII_CODES } from '../public/js/basic/listing.js';

const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));

test('dialect metadata: output formats and keyword lists', () => {
  for (const id of ['v2', 'v4', 'v35', 'v7', 'simons']) assert.equal(DIALECTS[id].output, 'prg');
  assert.equal(DIALECTS.atari.output, 'atascii-lst');
  assert.equal(DIALECTS.turbo.output, 'atascii-lst');
  assert.equal(DIALECTS.loco.output, 'cpc-ascii');
  for (const id of ['atari', 'turbo', 'loco']) {
    const d = DIALECTS[id];
    assert.ok(d.name && d.machine && d.machines[d.machine], id);
    const names = new Set();
    for (const kw of d.keywords) {
      assert.ok(kw.name && kw.syntax && kw.desc, `${id} ${kw.name}`);
      assert.ok(!names.has(kw.name), `${id}: duplicate ${kw.name}`);
      names.add(kw.name);
    }
  }
  assert.ok(ATASCII_CODES.find((c) => c.name === 'clear' && c.code === 0x7d));
});

test('atari: ENTER-able ATASCII listing', () => {
  const r = tokenize('10 print "Hello":goto 10\n20 rem lower case stays\n30 data a,b:c\n', { dialect: 'atari' });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.prg, null);
  assert.equal(r.format, 'atascii-lst');
  assert.deepEqual(Array.from(r.listing), [
    ...ascii('10 PRINT "Hello":GOTO 10'), 0x9b,
    ...ascii('20 REM lower case stays'), 0x9b,
    ...ascii('30 DATA a,b:c'), 0x9b,
  ]);
  assert.deepEqual(r.lines.map((l) => [l.src, l.number, l.addr]), [[1, 10, 0], [2, 20, 25], [3, 30, 49]]);
});

test('atari: escapes and inverse video', () => {
  const r = tokenize('10 ? "{clear}{down}{bell}{inv}Ab{/inv}c{$9c}":if x then rem ok', { dialect: 'atari' });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(Array.from(r.listing), [
    ...ascii('10 ? "'), 0x7d, 0x1d, 0xfd, 0xc1, 0xe2, 0x63, 0x9c, ...ascii('":IF X THEN REM ok'), 0x9b,
  ]);
  const text = detokenize(r.listing, { dialect: 'atari' });
  assert.equal(text, '10 ? "{clear}{down}{bell}{inv}Ab{/inv}c{delline}":IF X THEN REM ok\n');
  assert.deepEqual(tokenize(text, { dialect: 'atari' }).listing, r.listing);
});

test('atari: line number and character errors', () => {
  const r = tokenize('0 rem ok\n32768 end\n20 a=1\n10 b=2\n20 c=3\nx=1\n30 ? "{nope}"\n40 ? "{$9b}"', { dialect: 'atari' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.map((e) => e.line), [2, 4, 5, 6, 7, 8]);
  assert.equal(tokenize('32767 END', { dialect: 'atari' }).ok, true);
  assert.equal(tokenize('10 REM ' + 'x'.repeat(120), { dialect: 'atari' }).ok, false);
});

test('turbo-basic: same listing format', () => {
  const r = tokenize('10 repeat:dpoke 88,0:until stick(0)<>15', { dialect: 'turbo' });
  assert.equal(r.ok, true);
  assert.deepEqual(Array.from(r.listing), [...ascii('10 REPEAT:DPOKE 88,0:UNTIL STICK(0)<>15'), 0x9b]);
});

test('loco: CPC ASCII file (SAVE "x",A)', () => {
  const r = tokenize("10 mode 1:print chr$(65);name$\n20 for i=1 to 10:next ' a comment\n30 rem keep print\n40 data print,\"x\":locate 1,1", { dialect: 'loco' });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.prg, null);
  assert.equal(r.format, 'cpc-ascii');
  assert.deepEqual(Array.from(r.listing), [
    ...ascii('10 MODE 1:PRINT CHR$(65);name$'), 0x0d, 0x0a,
    ...ascii("20 FOR i=1 TO 10:NEXT ' a comment"), 0x0d, 0x0a,
    ...ascii('30 REM keep print'), 0x0d, 0x0a,
    ...ascii('40 DATA print,"x":LOCATE 1,1'), 0x0d, 0x0a,
    0x1a,
  ]);
  const text = detokenize(r.listing, { dialect: 'loco' });
  assert.equal(text.split('\n')[0], '10 MODE 1:PRINT CHR$(65);name$');
  assert.deepEqual(tokenize(text, { dialect: 'loco' }).listing, r.listing);
});

test('loco: escapes and errors', () => {
  const r = tokenize('10 print "{$18}x{$7b}"', { dialect: 'loco' });
  assert.deepEqual(Array.from(r.listing), [...ascii('10 PRINT "'), 0x18, 0x78, 0x7b, 0x22, 0x0d, 0x0a, 0x1a]);
  assert.equal(detokenize(r.listing, { dialect: 'loco' }), '10 PRINT "{$18}x{$7b}"\n');
  const e = tokenize('0 cls\n65535 end\n65536 end\n100 a=1\n{clear}', { dialect: 'loco' });
  assert.deepEqual(e.errors.map((x) => x.line), [1, 3, 4, 5]);
  assert.equal(tokenize('', { dialect: 'loco' }).listing.length, 1); // just the EOF marker
});
