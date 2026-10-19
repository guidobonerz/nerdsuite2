// the addresses in the gutter of the code view: those of the instruction lines of a build (nsbuild.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assemble } from '../public/js/acme/acme.js';
import { codeAddresses, isCodeLine } from '../public/js/nsbuild.js';

test('the lines of code, data and labels have an address - not *=, constants or comments', () => {
  const src = [
    'border = $d020',            // 1 constant
    '*= $0810',                  // 2
    'start:',                    // 3 a label alone
    '        lda #$00',          // 4
    'loop:   sta border  ; x',   // 5
    '        !byte 1, 2, 3',     // 6 data
    '-       jmp loop',          // 7
    '; a comment',               // 8
    'text:   !byte 4',           // 9 a label before data
  ].join('\n');
  const r = assemble('main.asm', new Map([['main.asm', src]]), { format: 'plain' });
  assert.ok(r.ok, JSON.stringify(r.errors));
  const lines = codeAddresses(r).get('main.asm');
  assert.deepEqual([...lines].sort((a, b) => a[0] - b[0]), [[3, 0x0810], [4, 0x0810], [5, 0x0812], [6, 0x0815], [7, 0x0818], [9, 0x081b]]);
});

test('isCodeLine: ACME and KickAssembler', () => {
  for (const t of ['  lda #1', 'x: rts', '+ bne -', '  jmp * ; *= in a comment']) assert.ok(isCodeLine(t), t);
  for (const t of ['  !byte 1', '  .byte 1', 'label: .text "a"', '*= $1000', 'n = 3', '  .pc = $1000']) assert.ok(!isCodeLine(t), t);
});
