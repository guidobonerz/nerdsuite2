import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLabels, toLabels, toNumbers, scanLabels } from '../public/js/basic/labels.js';
import { tokenize } from '../public/js/basic/basic.js';

const program = [
  'start:',
  '  print "goto loop"',
  'loop:',
  '  x=x+1:if x<10 then loop',
  '  on x gosub sub1, sub2',
  '  if a then a=1',
  '  goto start: rem goto nowhere',
  'sub1:',
  '  return',
  'sub2:',
  '  return',
].join('\n');

test('resolveLabels: numbers 10, 20 ..., the jumps to their lines, the line count stays', () => {
  const r = resolveLabels(program);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.text.split('\n'), [
    '', '10 print "goto loop"', '', '20 x=x+1:if x<10 then 20', '30 on x gosub 60, 70', '40 if a then a=1',
    '50 goto 10: rem goto nowhere', '', '60 return', '', '70 return',
  ]);
  assert.deepEqual(r.labels.map(l => `${l.name}=${l.number}@${l.line}`), ['start=10@1', 'loop=20@3', 'sub1=60@8', 'sub2=70@10']);
  assert.ok(tokenize(r.text).ok);
});

test('resolveLabels: an unknown label, a label twice, a label at the end', () => {
  const r = resolveLabels('a:\n print\n goto b\na:\n end\nlast:');
  assert.deepEqual(r.errors.map(e => `${e.line}: ${e.msg}`), [
    '4: the label a is there twice (line 1 too)', '6: the label last has no line of code after it', '3: there is no label b']);
});

test('resolveLabels: a line with a number of its own keeps it', () => {
  assert.deepEqual(resolveLabels(' print\n1000 print\n print').text.split('\n'), ['10 print', '1000 print', '1010 print']);
});

test('toLabels and toNumbers: there and back', () => {
  const numbered = '10 print "hi"\n20 goto 10\n30 if x then 20\n40 gosub 100\n100 return';
  const labeled = toLabels(numbered);
  assert.equal(labeled, 'l10:\n  print "hi"\nl20:\n  goto l10\n  if x then l20\n  gosub l100\nl100:\n  return');
  assert.deepEqual(scanLabels(labeled).map(l => l.name), ['l10', 'l20', 'l100']);
  assert.equal(toNumbers(labeled).text, '10 print "hi"\n20 goto 10\n30 if x then 20\n40 gosub 50\n50 return');
});
