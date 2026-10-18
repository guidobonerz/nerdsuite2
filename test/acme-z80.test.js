import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assemble, disassemble } from '../public/js/acme/acme.js';
import { MNEMONICS, CPUS, PSEUDO_OPS } from '../public/js/acme/docs.js';

const asm = (src, opts = {}, extra = {}) => assemble('main.asm', new Map([['main.asm', src], ...Object.entries(extra)]), opts);
function z80(src, opts) {
  const r = asm('!cpu z80\n*= $4000\n' + src + '\n', { format: 'plain', ...opts });
  assert.deepEqual(r.errors, [], src);
  return Array.from(r.output);
}
const h = s => s.trim().split(/\s+/).map(x => parseInt(x, 16));

// [source, expected bytes] – written from the Zilog manual, independent of the implementation
const Z80_CASES = `
nop                 | 00
ld bc,$1234         | 01 34 12
ld (bc),a           | 02
inc bc              | 03
ld b,$12            | 06 12
ex af,af'           | 08
add hl,bc           | 09
ld a,(de)           | 1a
djnz *              | 10 fe
jr *                | 18 fe
jr nz,*             | 20 fe
jr c,*+4            | 38 02
ld hl,($1234)       | 2a 34 12
ld ($1234),hl       | 22 34 12
ld ($1234),a        | 32 34 12
ld a,($1234)        | 3a 34 12
ld sp,$c000         | 31 00 c0
ld a,(hl)           | 7e
ld (hl),b           | 70
ld (hl),$aa         | 36 aa
ld e,h              | 5c
halt                | 76
add a,b             | 80
adc a,$01           | ce 01
sub c               | 91
sbc a,(hl)          | 9e
and $0f             | e6 0f
xor a               | af
or e                | b3
cp (hl)             | be
cp $10              | fe 10
inc (hl)            | 34
dec a               | 3d
dec sp              | 3b
ret                 | c9
ret nz              | c0
ret m               | f8
pop af              | f1
push de             | d5
jp $1234            | c3 34 12
jp pe,$1234         | ea 34 12
call $1234          | cd 34 12
call z,$1234        | cc 34 12
rst $38             | ff
rst 0               | c7
ex de,hl            | eb
ex (sp),hl          | e3
jp (hl)             | e9
ld sp,hl            | f9
di                  | f3
ei                  | fb
exx                 | d9
daa                 | 27
cpl                 | 2f
scf                 | 37
ccf                 | 3f
rlca                | 07
rrca                | 0f
rla                 | 17
rra                 | 1f
out ($fe),a         | d3 fe
in a,($fe)          | db fe
rlc b               | cb 00
rrc c               | cb 09
rl (hl)             | cb 16
rr d                | cb 1a
sla e               | cb 23
sra h               | cb 2c
sll c               | cb 31
srl a               | cb 3f
bit 7,a             | cb 7f
bit 0,(hl)          | cb 46
res 0,(hl)          | cb 86
set 7,b             | cb f8
in b,(c)            | ed 40
in a,(c)            | ed 78
in (c)              | ed 70
out (c),a           | ed 79
out (c),0           | ed 71
sbc hl,de           | ed 52
adc hl,sp           | ed 7a
ld ($1234),de       | ed 53 34 12
ld sp,($1234)       | ed 7b 34 12
neg                 | ed 44
im 0                | ed 46
im 1                | ed 56
im 2                | ed 5e
ld a,i              | ed 57
ld a,r              | ed 5f
ld i,a              | ed 47
ld r,a              | ed 4f
rld                 | ed 6f
rrd                 | ed 67
reti                | ed 4d
retn                | ed 45
ldi                 | ed a0
ldir                | ed b0
ldd                 | ed a8
lddr                | ed b8
cpir                | ed b1
inir                | ed b2
otir                | ed b3
outd                | ed ab
ld ix,$1234         | dd 21 34 12
ld iy,($1234)       | fd 2a 34 12
ld ($1234),ix       | dd 22 34 12
ld (ix+5),a         | dd 77 05
ld (ix-1),$55       | dd 36 ff 55
ld a,(iy+$7f)       | fd 7e 7f
ld h,(ix+2)         | dd 66 02
add a,(ix+3)        | dd 86 03
or (ix+5)           | dd b6 05
inc (iy-128)        | fd 34 80
add ix,ix           | dd 29
add iy,bc           | fd 09
inc ix              | dd 23
push ix             | dd e5
pop iy              | fd e1
jp (ix)             | dd e9
jp (iy)             | fd e9
ex (sp),ix          | dd e3
ld sp,iy            | fd f9
set 3,(ix+2)        | dd cb 02 de
rl (iy+1)           | fd cb 01 16
bit 1,(ix+0)        | dd cb 00 4e
ld ixh,$12          | dd 26 12
ld b,ixl            | dd 45
ld ixh,ixl          | dd 65
inc iyh             | fd 24
sub iyl             | fd 95
`.trim().split('\n').map(l => l.split('|').map(s => s.trim()));

describe('z80 assembler', () => {
  test('documented and undocumented encodings', () => {
    for (const [src, exp] of Z80_CASES) assert.deepEqual(z80(' ' + src), h(exp), src);
  });

  test('case-insensitive, labels, macros, loops and expressions work as with 6502', () => {
    const src = `
!macro fill .val {
        ld a,.val
        ld (hl),a
}
start   LD HL,screen
        LD B,4
-       +fill <start
        INC HL
        DJNZ -
        jr .done
.done   ret
screen  !fill 2, $ff
!for n, 0, 1 { ld a,n }
`;
    assert.deepEqual(z80(src), h('21 0e 40 06 04 3e 00 77 23 10 fa 18 00 c9 ff ff 3e 00 3e 01'));
  });

  test('!align fills with z80 nop ($00)', () => {
    assert.deepEqual(z80(' ld a,1\n!align 3,0\n halt'), h('3e 01 00 00 76'));
  });

  test('errors', () => {
    const cases = [
      ['jr far\n!fill 200\nfar nop', /Target out of range/],
      ['djnz *-200', /Target out of range/],
      ['ld (hl),(hl)', /Illegal combination/],
      ['ld ixh,h', /Illegal combination/],
      ['ld ixh,(ix+1)', /Illegal combination/],
      ['jr po,*', /Illegal combination/],
      ['ld a,(ix+200)', /displacement out of range/],
      ['rst 3', /Illegal RST/],
      ['im 3', /Illegal interrupt mode/],
      ['bit 8,a', /Bit number/],
      ['ld a', /Illegal combination/],
      ['push sp', /Illegal combination/],
    ];
    for (const [src, re] of cases) {
      const r = asm('!cpu z80\n*= $4000\n ' + src + '\n');
      assert.equal(r.ok, false, src);
      assert.match(r.errors[0].msg, re, src);
      assert.equal(r.errors[0].line, 3, src);
    }
  });

  test('6502 mnemonics are not available in z80 mode and vice versa', () => {
    assert.equal(asm('!cpu z80\n*=$4000\n lda #1\n').ok, false);
    assert.equal(asm('*=$4000\n ld a,1\n').ok, false);
  });
});

describe('z80 disassembler', () => {
  test('examples', () => {
    const d = disassemble(Uint8Array.from(h('3e 05 dd 77 fd 18 fe 08 fd cb fe 7e ed 79 ed 00')), 0x4000, 'z80');
    assert.deepEqual(d.map(x => [x.addr, x.text]), [
      [0x4000, 'ld a,$05'], [0x4002, 'ld (ix-$03),a'], [0x4005, 'jr $4005'], [0x4007, "ex af,af'"],
      [0x4008, 'bit 7,(iy-$02)'], [0x400c, 'out (c),a'], [0x400e, '!byte $ed'], [0x400f, 'nop'],
    ]);
  });

  test('round trip: every decodable opcode re-assembles to identical bytes', () => {
    const prefixes = [[], [0xcb], [0xed], [0xdd], [0xfd], [0xdd, 0xcb, 0x05], [0xfd, 0xcb, 0xfb]];
    let n = 0;
    for (const pre of prefixes) {
      for (let op = 0; op < 256; op++) {
        const bytes = Uint8Array.from([...pre, op, 0x05, 0x12, 0x34]);
        const [d] = disassemble(bytes, 0x4000, 'z80');
        if (d.text.startsWith('!byte')) continue;
        const r = asm(`!cpu z80\n*= $4000\n ${d.text}\n`, { format: 'plain' });
        assert.deepEqual(r.errors, [], d.text);
        assert.deepEqual(Array.from(r.output), d.bytes, d.text);
        n++;
      }
    }
    // unprefixed + CB + documented ED + DD/FD (incl. ixh/ixl) + DDCB/FDCB forms
    assert.ok(n > 780, `only ${n} instructions round-tripped`);
  });
});

describe('output formats', () => {
  test('xex: segments, INITAD and RUNAD', () => {
    const src = `!to "game.xex", xex
*= $2000
start   lda #0
        rts
*= $3000
        !byte 1, 2
!init start
!run start
`;
    const r = asm(src);
    assert.deepEqual(r.errors, []);
    assert.equal(r.format, 'xex');
    assert.equal(r.exec, 0x2000);
    assert.deepEqual(Array.from(r.output), h(`ff ff 00 20 02 20 a9 00 60 00 30 01 30 01 02
      e2 02 e3 02 00 20 e0 02 e1 02 00 20`));
  });

  test('xex via opts.format / opts.run, no RUNAD without run address', () => {
    let r = asm('*= $0600\n rts\n', { format: 'xex' });
    assert.deepEqual(Array.from(r.output), h('ff ff 00 06 00 06 60'));
    r = asm('*= $0600\n rts\n', { format: 'xex', run: 0x0600 });
    assert.deepEqual(Array.from(r.output), h('ff ff 00 06 00 06 60 e0 02 e1 02 00 06'));
    assert.equal(r.exec, 0x0600);
  });

  test('amsdos header for a CPC program', () => {
    const src = `!cpu z80
!to "hello.bin", amsdos
*= $4000
        nop
start   ld a,1
        call $bb5a
        ret
!run start
`;
    const r = asm(src);
    assert.deepEqual(r.errors, []);
    assert.equal(r.format, 'amsdos');
    assert.equal(r.exec, 0x4001);
    const o = r.output;
    assert.equal(o.length, 128 + 7);
    assert.equal(o[0], 0);
    assert.equal(String.fromCharCode(...o.slice(1, 12)), 'HELLO   BIN');
    assert.equal(o[0x12], 2);
    assert.deepEqual(Array.from(o.slice(0x13, 0x17)), [7, 0, 0x00, 0x40]);
    assert.deepEqual(Array.from(o.slice(0x18, 0x1c)), [7, 0, 0x01, 0x40]);
    assert.deepEqual(Array.from(o.slice(0x40, 0x43)), [7, 0, 0]);
    let sum = 0;
    for (let i = 0; i <= 66; i++) sum += o[i];
    assert.equal(o[0x43] | (o[0x44] << 8), sum);
    assert.deepEqual(Array.from(o.slice(128)), h('00 3e 01 cd 5a bb c9'));
  });

  test('amsdos exec defaults to start, name from main file when no !to', () => {
    const r = assemble('src/game.asm', new Map([['src/game.asm', '!cpu z80\n*= $8000\n ret\n']]), { format: 'amsdos' });
    assert.equal(String.fromCharCode(...r.output.slice(1, 12)), 'GAME    ASM');
    assert.deepEqual(Array.from(r.output.slice(0x1a, 0x1c)), [0x00, 0x80]);
    assert.equal(r.exec, 0x8000);
  });

  test('unknown format is an error; cbm exec = start', () => {
    assert.match(asm('!to "x", tap\n').errors[0].msg, /Unknown output format/);
    assert.equal(asm('*= $c000\n rts\n').exec, 0xc000);
  });
});

describe('docs (z80 / formats)', () => {
  test('z80 completion data', () => {
    assert.ok(CPUS.find(c => c.name === 'z80').supported);
    const names = MNEMONICS.z80.map(m => m.name);
    for (const n of ['ld', 'jr', 'djnz', 'ex', 'exx', 'ldir', 'bit', 'im', 'in', 'out', 'rst', 'sll']) assert.ok(names.includes(n), n);
    for (const m of MNEMONICS.z80) assert.ok(m.desc && m.modes.length, m.name);
    assert.ok(PSEUDO_OPS.some(p => p.name === '!run') && PSEUDO_OPS.some(p => p.name === '!init'));
  });
});
