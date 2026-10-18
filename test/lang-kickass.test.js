// the KickAssembler language of the code editor (public/js/lang-kickass.js); KickAssembler itself runs
// on the server (backend/kickass, its tests in Go)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kickassLanguage, scanDefinitions, tokens } from '../public/js/lang-kickass.js';

test('editor language: tokens, definitions, completion', () => {
  const src = '.const SCREEN = $0400\n/* x\n y */\nstart: lda #0\n!loop: jmp !loop-\n.macro Border(c) {\n}\n';
  assert.ok(tokens(src).some(t => t.cls === 'tok-comment' && t.text.includes('\n')));
  assert.deepEqual(scanDefinitions(src).map(d => `${d.kind}:${d.name}`), ['const:SCREEN', 'label:start', 'macro:Border']);
  const L = kickassLanguage({ definitions: () => scanDefinitions(src) });
  const labels = t => L.complete(t, t.length, {}).items.map(x => x.label);
  assert.ok(labels('  .by').includes('.byte'));
  assert.ok(labels('#imp').includes('#import'));
  assert.ok(labels('  lda #BL').includes('BLACK'));
  assert.ok(labels('  Bor').includes('Border'));
  assert.ok(labels('  lda SC').includes('SCREEN'));
});
