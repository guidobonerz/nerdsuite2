import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assemble, disassemble } from '../public/js/acme/acme.js';

const asm = (src, opts = {}) => assemble('main.asm', new Map([['main.asm', src]]), opts);
function m68k(src) {
  const r = asm('!cpu 68000\n*= $40000\n' + src + '\n', { format: 'plain' });
  assert.deepEqual(r.errors, [], src);
  return Array.from(r.output);
}
const h = s => s.trim().split(/\s+/).flatMap(x => x.match(/../g).map(b => parseInt(b, 16)));

// [source, expected words] - from the M68000 Programmer's Reference Manual, independent of the implementation
const CASES = `
nop                           | 4e71
rts                           | 4e75
rte                           | 4e73
illegal                       | 4afc
moveq #1,d0                   | 7001
moveq #-1,d7                  | 7eff
move.l d0,d1                  | 2200
move.l (a0)+,(a1)+            | 22d8
move.b d0,-(a7)               | 1f00
move.w #$7fff,$dff09a         | 33fc 7fff 00df f09a
move.l 4.w,a6                 | 2c78 0004
move.l (4).w,a6               | 2c78 0004
move.l ($4).l,a6              | 2c79 0000 0004
move.l 8(a0,d1.w),d0          | 2030 1008
move.l (8,a0,d1.l),d0         | 2030 1808
move.w -2(a1),d2              | 3429 fffe
move.w (a0),sr                | 46d0
move.w d0,ccr                 | 44c0
move sr,d0                    | 40c0
move.l a0,usp                 | 4e60
move.l usp,a1                 | 4e69
movea.w d0,a0                 | 3040
move.l #$12345678,d0          | 203c 1234 5678
lea $dff000,a6                | 4df9 00df f000
lea 4(a0),a1                  | 43e8 0004
lea *(pc),a0                  | 41fa fffe
pea (a0)                      | 4850
movem.l d0-d7/a0-a6,-(sp)     | 48e7 fffe
movem.l (sp)+,d0-d7/a0-a6     | 4cdf 7fff
movem.w d0/a1,(a0)            | 4890 0201
addq.w #1,d0                  | 5240
subq.l #8,a0                  | 5188
dbra d0,*                     | 51c8 fffe
dbne d1,*                     | 56c9 fffe
bra.s *+4                     | 6002
bne *                         | 6600 fffe
bsr.w *+$100                  | 6100 00fe
beq.s *-4                     | 67fa
jmp (a0)                      | 4ed0
jsr -$c6(a6)                  | 4eae ff3a
btst #6,$bfe001               | 0839 0006 00bf e001
btst d1,d0                    | 0300
bset d0,(a0)                  | 01d0
bclr #7,d2                    | 0882 0007
cmp.b #$ff,d0                 | 0c00 00ff
cmpi.w #1,(a0)                | 0c50 0001
cmp.l d1,d0                   | b081
cmpa.l a1,a0                  | b1c9
cmp.w (a0),a1                 | b2d0
cmpm.b (a0)+,(a1)+            | b308
add.l d1,d0                   | d081
add.w d0,(a0)                 | d150
add.w #5,d0                   | d07c 0005
add.l #$10,(a0)               | 0690 0000 0010
adda.l #$10,a0                | d1fc 0000 0010
sub.w #1,a0                   | 90fc 0001
addx.l d0,d1                  | d380
subx.w -(a0),-(a1)            | 9348
abcd d0,d1                    | c300
sbcd -(a1),-(a2)              | 8509
and.w #$ff,d0                 | c07c 00ff
and.l d0,(a1)                 | c191
andi #$fe,ccr                 | 023c 00fe
ori #$700,sr                  | 007c 0700
or.b (a0),d1                  | 8210
eor.w d0,d1                   | b141
eor.b #1,(a0)                 | 0a10 0001
not.l d0                      | 4680
neg.w (a0)                    | 4450
negx.b d1                     | 4001
clr.l d0                      | 4280
tst.w (a0)                    | 4a50
tas (a0)                      | 4ad0
nbcd d0                       | 4800
swap d0                       | 4840
ext.w d1                      | 4881
ext.l d0                      | 48c0
exg d0,d1                     | c141
exg a0,a1                     | c149
exg d0,a1                     | c189
exg a1,d0                     | c189
mulu d1,d0                    | c0c1
muls.w #-2,d3                 | c7fc fffe
divu #10,d0                   | 80fc 000a
divs (a0),d1                  | 83d0
chk (a1),d0                   | 4191
lsl.w #2,d0                   | e548
lsr.l d1,d0                   | e2a8
asr.b #8,d3                   | e003
rol.w d0                      | e358
roxr.l #1,d2                  | e292
asl (a0)                      | e1d0
lsr.w 2(a1)                   | e2e9 0002
st d0                         | 50c0
sne (a0)                      | 56d0
trap #15                      | 4e4f
link a6,#-4                   | 4e56 fffc
unlk a6                       | 4e5e
stop #$2700                   | 4e72 2700
movep.w d0,2(a1)              | 0189 0002
movep.l 0(a0),d1              | 0348 0000
`.trim().split('\n').map(l => l.split('|').map(s => s.trim()));

describe('68000', () => {
  for (const [src, want] of CASES) test(src, () => assert.deepEqual(m68k(src), h(want), src));

  test('the disassembler writes what the assembler reads', () => {
    for (const [src] of CASES) {
      const bytes = m68k(src);
      const out = disassemble(Uint8Array.from(bytes), 0x40000, '68000');
      assert.equal(out.length, 1, `${src}: ${out.map(o => o.text).join(' / ')}`);
      assert.deepEqual(m68k(out[0].text), bytes, `${src} -> ${out[0].text}`);
    }
  });

  test('dc, ds and even; data is big endian', () => {
    assert.deepEqual(m68k('dc.b "AB",0\neven\ndc.w $1234\ndc.l $deadbeef\nds.w 1\ndc.b 1'), [0x41, 0x42, 0, 0, 0x12, 0x34, 0xde, 0xad, 0xbe, 0xef, 0, 0, 1]);
  });

  test('absolute addresses: .w when they fit, labels above 32K are .l', () => {
    assert.deepEqual(m68k('move.l 4,a6'), h('2c78 0004'));
    assert.deepEqual(m68k('jmp next\nnext: nop'), h('4ef9 0004 0006 4e71'));
  });

  test('forward branches and labels in 24 bits', () => {
    const r = asm('!cpu 68000\n*= $70000\nstart: bra.s next\n nop\nnext: lea start(pc),a0\n bra start\n', { format: 'plain' });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(Array.from(r.output), h('6002 4e71 41fa fffa 6000 fff6'));
    assert.equal(r.symbols.find(s => s.name === 'next').value, 0x70004);
    assert.deepEqual(r.lines.map(l => l.addr), [0x70000, 0x70002, 0x70004, 0x70008]);
  });

  test('errors', () => {
    const bad = src => asm('!cpu 68000\n*= $1000\n' + src + '\n', { format: 'plain' }).errors.map(e => e.msg);
    assert.match(bad('move.b a0,d0')[0], /address register/);
    assert.match(bad('moveq #200,d0')[0] ?? '', /^$/);
    assert.match(bad('moveq #300,d0')[0], /moveq/);
    assert.match(bad('addq #9,d0')[0], /addq/);
    assert.match(bad('bra.s *+2')[0], /short branch/);
    assert.match(bad('lea d0,a0')[0], /Illegal/);
    assert.match(bad('dc.b 1\nnop')[0], /odd address/);
    assert.match(bad('move.w 70000(a0),d0')[0], /Displacement/);
  });
});

describe('ADF', () => {
  test('a bootable disk: DOS, the checksum, the code from byte 12, a root block', () => {
    const r = asm('!cpu 68000\n!to "demo.adf", adf\n*= $40000\nloop: bra.s loop\n');
    assert.deepEqual(r.errors, []);
    const d = r.output, v = new DataView(d.buffer);
    assert.equal(d.length, 901120);
    assert.deepEqual([...d.slice(0, 4)], [0x44, 0x4f, 0x53, 0]);
    assert.equal(v.getUint32(8), 880);
    assert.deepEqual([...d.slice(12, 14)], [0x60, 0xfe]);
    let sum = 0;
    for (let i = 0; i < 1024; i += 4) { sum += v.getUint32(i); if (sum > 0xffffffff) sum -= 0xffffffff; }
    assert.equal(sum, 0xffffffff);
    const blockSum = at => { let s = 0; for (let i = 0; i < 512; i += 4) s = (s + v.getUint32(at + i)) >>> 0; return s; };
    assert.equal(blockSum(880 * 512), 0);
    assert.equal(blockSum(881 * 512), 0);
    assert.equal(String.fromCharCode(...d.slice(880 * 512 + 433, 880 * 512 + 437)), 'demo');
    // the bitmap: blocks 2 .. 1759 free but the root (880) and the bitmap (881)
    const free = b => (v.getUint32(881 * 512 + 4 + ((b - 2) >> 5) * 4) >>> ((b - 2) & 31)) & 1;
    assert.equal(free(2), 1);
    assert.equal(free(879), 1);
    assert.equal(free(880), 0);
    assert.equal(free(881), 0);
    assert.equal(free(1759), 1);
  });

  test('more code than the boot block holds: a warning', () => {
    const r = asm('!cpu 68000\n!to "big.adf", adf\n*= $40000\nds.b 1100\n');
    assert.deepEqual(r.errors, []);
    assert.match(r.warnings[0].msg, /1012 bytes/);
  });
});

describe('the Amiga 500 project', () => {
  test('the starter program builds a bootable disk that copies itself to its start', async () => {
    const { platformOf, starterAsm } = await import('../public/js/platforms.js');
    const p = platformOf('amiga500');
    assert.equal(p.mimic.machine, 'amiga');
    assert.equal(platformOf('amiga').id, 'amiga500', 'a project with the mimic name of the machine');
    const r = asm(starterAsm(p), { cpu: p.cpu });
    assert.deepEqual(r.errors, []);
    assert.equal(r.outputName, 'main.adf');
    assert.equal(r.output.length, 901120);
    assert.equal(r.start, p.start);
    // lea boot(pc),a0 at the start of the code: the address Kickstart loaded it to
    assert.deepEqual([...r.output.slice(12, 16)], [0x41, 0xfa, 0xff, 0xfe]);
  });

  test('dc, ds and even are data lines, instructions are code', async () => {
    const { isCodeLine } = await import('../public/js/nsbuild.js');
    assert.equal(isCodeLine('        dc.w $1234'), false);
    assert.equal(isCodeLine('table:  dc.l 1,2'), false);
    assert.equal(isCodeLine('        even'), false);
    assert.equal(isCodeLine('        move.l d0,d1'), true);
  });
});
