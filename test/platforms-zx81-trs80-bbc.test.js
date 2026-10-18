// the ZX81, the TRS-80 and the BBC Micro: their .p files (public/js/zx81.js), the /CMD output of the
// assembler, the listings of Level II and BBC BASIC, the starter programs and the memory maps
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { float5, fromFloat5, tokenizeZx81, detokenizeZx81, codeP, PROGRAM } from '../public/js/zx81.js';
import { assemble } from '../public/js/acme/acme.js';
import { tokenize, detokenize } from '../public/js/basic/basic.js';
import { PLATFORMS, starterAsm, starterBasic } from '../public/js/platforms.js';
import { symbolsFor } from '../public/js/memmap.js';

const at = (p, addr) => p[addr - 0x4009];
const word = (p, addr) => at(p, addr) | at(p, addr + 1) << 8;

test('float5: the 5 byte numbers of the ZX81', () => {
  assert.deepEqual(float5(0), [0, 0, 0, 0, 0]);
  assert.deepEqual(float5(1), [0x81, 0, 0, 0, 0]);
  assert.deepEqual(float5(10), [0x84, 0x20, 0, 0, 0]);
  assert.deepEqual(float5(-0.5), [0x80, 0x80, 0, 0, 0]);
  assert.deepEqual(float5(16514), [0x8f, 0x01, 0x04, 0, 0]);
  for (const v of [3.25, -1234.5, 0.1, 65535]) assert.ok(Math.abs(fromFloat5(float5(v)) - v) < 1e-6 * Math.abs(v));
});

test('tokenizeZx81: keywords as tokens, numbers with $7E and their value, a .p file that runs', () => {
  const r = tokenizeZx81('10 PRINT "HI"\n20 GOTO 10');
  assert.deepEqual(r.errors, []);
  const p = r.bytes;
  // line 10 at $407D: number (big endian), length, PRINT "HI" newline
  assert.deepEqual([...p.subarray(PROGRAM - 0x4009, PROGRAM - 0x4009 + 10)], [0, 10, 6, 0, 0xf5, 0x0b, 0x2d, 0x2e, 0x0b, 0x76]);
  // line 20: GOTO 1 0 $7E and 10 as a float, newline (10 bytes)
  assert.deepEqual([...p.subarray(PROGRAM - 0x4009 + 10, PROGRAM - 0x4009 + 24)], [0, 20, 10, 0, 0xec, 0x1d, 0x1c, 0x7e, 0x84, 0x20, 0, 0, 0, 0x76]);
  assert.equal(word(p, 0x4029), PROGRAM);                                    // NXTLIN: it runs from its first line
  const dfile = word(p, 0x400c);
  assert.equal(at(p, dfile), 0x76);
  assert.equal(word(p, 0x4014), word(p, 0x4010) + 1);                        // E_LINE after the variables
  assert.equal(p.length, word(p, 0x4014) - 0x4009);                          // the file ends at E_LINE
});

test('tokenizeZx81: names stay names, "" in strings, errors', () => {
  assert.equal(detokenizeZx81(tokenizeZx81('10 LET TOTAL=A1+2**3\n20 PRINT "SAY ""HI"""\n30 REM 12 GOTO').bytes),
    '10 LET TOTAL=A1+2**3\n20 PRINT "SAY ""HI"""\n30 REM 12 GOTO\n');
  assert.match(tokenizeZx81('10 PRINT "HI!"').errors[0].msg, /no character "!"/);
  assert.match(tokenizeZx81('20 CLS\n10 CLS').errors[0].msg, /not greater/);
  assert.equal(detokenize(tokenize('10 CLS', { dialect: 'zx81' }).listing, { dialect: 'zx81' }), '10 CLS\n');
});

test('codeP: machine code in 1 REM at $4082, 2 RAND USR runs it', () => {
  const p = codeP([0x3e, 0x01, 0xc9]);
  assert.deepEqual([...p.subarray(PROGRAM - 0x4009, PROGRAM - 0x4009 + 9)], [0, 1, 5, 0, 0xea, 0x3e, 0x01, 0xc9, 0x76]);
  assert.match(detokenizeZx81(p), /2 RAND USR 16514/);
  assert.equal(word(p, 0x4029), PROGRAM + 9);                                // NXTLIN: line 2
  assert.throws(() => codeP([0xc9], 0x4000), /\$4082/);
  const r = assemble('a.asm', new Map([['a.asm', '!cpu z80\n*= $4082\n ret\n']]), { format: 'zx81' });
  assert.equal(r.ok, true);
  assert.equal(at(r.output, 0x4082), 0xc9);
});

test('the assembler: a TRS-80 /CMD file of load blocks and the entry', () => {
  const r = assemble('a.asm', new Map([['a.asm', '!cpu z80\n*= $7000\nstart: ld a, 1\n ret\n!run start\n']]), { format: 'trs80' });
  assert.equal(r.ok, true);
  assert.deepEqual([...r.output], [0x01, 0x05, 0x00, 0x70, 0x3e, 0x01, 0xc9, 0x02, 0x02, 0x00, 0x70]);
  // more than 252 bytes: blocks of 252
  const big = assemble('b.asm', new Map([['b.asm', '!cpu z80\n*= $7000\n!fill 300, 0\n']]), { format: 'trs80' }).output;
  assert.deepEqual([big[0], big[1], big[256], big[257], big[258], big[259]], [0x01, 254, 0x01, 50, 0xfc, 0x70]);
});

test('Level II and BBC BASIC: ASCII listings with CR', () => {
  const t = tokenize('10 print "hi" \' a remark\n20 goto 10', { dialect: 'trs80' });
  assert.equal(t.ok, true);
  assert.equal(new TextDecoder().decode(t.listing), '10 PRINT "hi" \' a remark\r20 GOTO 10\r');
  const b = tokenize('10 for i%=1 to 3:print \'"x";i%:next\n20 PROCmain', { dialect: 'bbc' });
  assert.equal(new TextDecoder().decode(b.listing), '10 FOR i%=1 TO 3:PRINT \'"x";i%:NEXT\r20 PROCmain\r');
  assert.equal(detokenize(b.listing, { dialect: 'bbc' }), '10 FOR i%=1 TO 3:PRINT \'"x";i%:NEXT\n20 PROCmain\n');
});

test('the starter programs assemble and tokenize, the memory maps name the ROMs', () => {
  for (const id of ['zx81', 'trs80', 'trs80m3', 'bbcb']) {
    const p = PLATFORMS.find(x => x.id === id);
    const r = assemble('main.asm', new Map([['main.asm', starterAsm(p)]]), { cpu: p.cpu });
    assert.equal(r.ok, true, `${id}: ${r.errors.map(e => e.msg).join(', ')}`);
    assert.equal(r.format, p.format);
    const b = tokenize(starterBasic(p, p.basic[0]), { dialect: p.basic[0] });
    assert.equal(b.ok, true, `${id} BASIC: ${b.errors.map(e => e.msg).join(', ')}`);
  }
  assert.equal(symbolsFor('zx81').at(0x4029).name, 'NXTLIN');
  assert.equal(symbolsFor('trs80').at(0x3c00 + 70).name, 'SCREEN_RAM');
  assert.equal(symbolsFor('bbcb').at(0xffee).name, 'OSWRCH');
});
