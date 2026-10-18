// the languages of the code editor: completion and the BASIC helpers (lang-basic.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basicLanguage, renumber, lineNumbers, keywords } from '../public/js/lang-basic.js';

test('renumber follows GOTO, GOSUB and THEN, not strings', () => {
  const src = '5 print "goto 7"\n7 gosub 9:if a then 5\n9 goto 7';
  assert.equal(renumber(src), '10 print "goto 7"\n20 gosub 30:if a then 10\n30 goto 20');
});

test('line numbers of a program', () => {
  assert.deepEqual(lineNumbers('10 a\n\n20 b').map(x => x.number), [10, 20]);
});

test('keywords come longest first', () => {
  const k = keywords('v2').map(x => x.name);
  assert.ok(k.indexOf('print#') < k.indexOf('print'));
});

test('completion: keywords, control codes, line numbers', () => {
  const lang = basicLanguage({ dialect: () => 'v2' });
  const text = '10 pr';
  let r = lang.complete(text, text.length);
  assert.ok(r.items.some(x => x.label === 'print'));
  const s = '10 print "{cl';
  r = lang.complete(s, s.length);
  assert.ok(r.items.some(x => x.label === '{clr}'));
  const g = '10 rem\n20 goto ';
  r = lang.complete(g, g.length, { force: true });
  assert.deepEqual(r.items.map(x => x.label), ['10', '20']);
});

test('Enter proposes the next line number', () => {
  const lang = basicLanguage();
  assert.equal(lang.newline('10 print', 8), '\n20 ');
  assert.equal(lang.newline('10 print\n15 x', 8), '\n12 ');
});

import { acmeLanguage, scanDefinitions } from '../public/js/lang-acme.js';

test('ACME completion: mnemonics where a statement starts, labels in operands', () => {
  const defs = [{ name: 'start', kind: 'label', line: 1 }, { name: 'screen', kind: 'const', line: 2, value: '$0400' }];
  const L = acmeLanguage({ cpu: () => '6510', definitions: () => defs });
  const labels = t => L.complete(t, t.length, {}).items.map(x => x.label);
  assert.deepEqual(labels('        st').slice(0, 3), ['sta', 'stx', 'sty']);
  assert.deepEqual(labels('lda st'), ['start']);
  assert.deepEqual(labels('lda+2 sc'), ['screen']);
  assert.ok(labels('loop: ld').includes('lda'));
  assert.ok(labels('        !by').includes('!byte'));
  const Z = acmeLanguage({ cpu: () => 'z80' });
  assert.equal(Z.complete('  ld', 4, {}).items[0].label, 'ld');
});

test('ACME definitions: labels, locals, constants, macros, zones', () => {
  const d = scanDefinitions('start:\n.loop  inx\nSCREEN = $0400\n!macro wait .n {\n!zone main\n  lda #1');
  assert.deepEqual(d.map(x => `${x.kind}:${x.name}`), ['label:start', 'label:.loop', 'const:SCREEN', 'macro:wait', 'zone:main']);
});
