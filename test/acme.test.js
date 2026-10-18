import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assemble, disassemble, CPU_TABLES, MODE_LEN } from '../public/js/acme/acme.js';
import { MNEMONICS, PSEUDO_OPS, CPUS } from '../public/js/acme/docs.js';

// ---------------------------------------------------------------- helpers

function asm(src, opts = {}, extra = {}) {
  const files = new Map([['main.asm', src], ...Object.entries(extra)]);
  return assemble('main.asm', files, opts);
}
/** Assemble, assert success, return bytes without the cbm load address. */
function bytes(src, opts, extra) {
  const r = asm(src, opts, extra);
  assert.deepEqual(r.errors, [], 'unexpected errors');
  assert.ok(r.ok);
  return Array.from(r.output.slice(2));
}
const h = s => s.trim().split(/\s+/).map(x => parseInt(x, 16));

// ---------------------------------------------------------------- opcode tables

// Written independently of the assembler's tables.
const LEGAL = {
  adc: { imm: 0x69, zp: 0x65, zpx: 0x75, abs: 0x6d, absx: 0x7d, absy: 0x79, indx: 0x61, indy: 0x71 },
  and: { imm: 0x29, zp: 0x25, zpx: 0x35, abs: 0x2d, absx: 0x3d, absy: 0x39, indx: 0x21, indy: 0x31 },
  asl: { imp: 0x0a, zp: 0x06, zpx: 0x16, abs: 0x0e, absx: 0x1e },
  bcc: { rel: 0x90 }, bcs: { rel: 0xb0 }, beq: { rel: 0xf0 }, bmi: { rel: 0x30 },
  bne: { rel: 0xd0 }, bpl: { rel: 0x10 }, bvc: { rel: 0x50 }, bvs: { rel: 0x70 },
  bit: { zp: 0x24, abs: 0x2c },
  brk: { imp: 0x00 }, clc: { imp: 0x18 }, cld: { imp: 0xd8 }, cli: { imp: 0x58 }, clv: { imp: 0xb8 },
  cmp: { imm: 0xc9, zp: 0xc5, zpx: 0xd5, abs: 0xcd, absx: 0xdd, absy: 0xd9, indx: 0xc1, indy: 0xd1 },
  cpx: { imm: 0xe0, zp: 0xe4, abs: 0xec },
  cpy: { imm: 0xc0, zp: 0xc4, abs: 0xcc },
  dec: { zp: 0xc6, zpx: 0xd6, abs: 0xce, absx: 0xde },
  dex: { imp: 0xca }, dey: { imp: 0x88 },
  eor: { imm: 0x49, zp: 0x45, zpx: 0x55, abs: 0x4d, absx: 0x5d, absy: 0x59, indx: 0x41, indy: 0x51 },
  inc: { zp: 0xe6, zpx: 0xf6, abs: 0xee, absx: 0xfe },
  inx: { imp: 0xe8 }, iny: { imp: 0xc8 },
  jmp: { abs: 0x4c, ind: 0x6c },
  jsr: { abs: 0x20 },
  lda: { imm: 0xa9, zp: 0xa5, zpx: 0xb5, abs: 0xad, absx: 0xbd, absy: 0xb9, indx: 0xa1, indy: 0xb1 },
  ldx: { imm: 0xa2, zp: 0xa6, zpy: 0xb6, abs: 0xae, absy: 0xbe },
  ldy: { imm: 0xa0, zp: 0xa4, zpx: 0xb4, abs: 0xac, absx: 0xbc },
  lsr: { imp: 0x4a, zp: 0x46, zpx: 0x56, abs: 0x4e, absx: 0x5e },
  nop: { imp: 0xea },
  ora: { imm: 0x09, zp: 0x05, zpx: 0x15, abs: 0x0d, absx: 0x1d, absy: 0x19, indx: 0x01, indy: 0x11 },
  pha: { imp: 0x48 }, php: { imp: 0x08 }, pla: { imp: 0x68 }, plp: { imp: 0x28 },
  rol: { imp: 0x2a, zp: 0x26, zpx: 0x36, abs: 0x2e, absx: 0x3e },
  ror: { imp: 0x6a, zp: 0x66, zpx: 0x76, abs: 0x6e, absx: 0x7e },
  rti: { imp: 0x40 }, rts: { imp: 0x60 },
  sbc: { imm: 0xe9, zp: 0xe5, zpx: 0xf5, abs: 0xed, absx: 0xfd, absy: 0xf9, indx: 0xe1, indy: 0xf1 },
  sec: { imp: 0x38 }, sed: { imp: 0xf8 }, sei: { imp: 0x78 },
  sta: { zp: 0x85, zpx: 0x95, abs: 0x8d, absx: 0x9d, absy: 0x99, indx: 0x81, indy: 0x91 },
  stx: { zp: 0x86, zpy: 0x96, abs: 0x8e },
  sty: { zp: 0x84, zpx: 0x94, abs: 0x8c },
  tax: { imp: 0xaa }, tay: { imp: 0xa8 }, tsx: { imp: 0xba }, txa: { imp: 0x8a }, txs: { imp: 0x9a }, tya: { imp: 0x98 },
};

const OPERAND = {
  imp: ['', []], imm: ['#$12', [0x12]], zp: ['$12', [0x12]], zpx: ['$12,x', [0x12]], zpy: ['$12,y', [0x12]],
  abs: ['$1234', [0x34, 0x12]], absx: ['$1234,x', [0x34, 0x12]], absy: ['$1234,y', [0x34, 0x12]],
  ind: ['($1234)', [0x34, 0x12]], indx: ['($12,x)', [0x12]], indy: ['($12),y', [0x12]],
  izp: ['($12)', [0x12]], iax: ['($1234,x)', [0x34, 0x12]],
  rel: ['* + $12', [0x10]], zprel: ['$12, * + $13', [0x12, 0x10]],
  sr: ['$12,s', [0x12]], sry: ['($12,s),y', [0x12]], ildp: ['[$12]', [0x12]], ildpy: ['[$12],y', [0x12]],
  long: ['$123456', [0x56, 0x34, 0x12]], longx: ['$123456,x', [0x56, 0x34, 0x12]], ialong: ['[$1234]', [0x34, 0x12]],
  rell: ['* + $1234', [0x31, 0x12]], blk: ['$01, $02', [0x02, 0x01]],
};

describe('opcode encoding', () => {
  test('all 151 documented 6502 opcodes', () => {
    let count = 0;
    for (const [mn, modes] of Object.entries(LEGAL)) {
      for (const [mode, op] of Object.entries(modes)) {
        const [operand, tail] = OPERAND[mode];
        const got = bytes(`*= $1000\n ${mn} ${operand}\n`);
        assert.deepEqual(got, [op, ...tail], `${mn} ${operand}`);
        count++;
      }
    }
    assert.equal(count, 151);
  });

  test('assembler table matches independent table exactly', () => {
    assert.deepEqual(CPU_TABLES['6502'], LEGAL);
  });

  test('mnemonics are case-insensitive', () => {
    assert.deepEqual(bytes('*=$1000\n LDA #$01\n Sta $D020\n'), h('a9 01 8d 20 d0'));
  });

  test('undocumented NMOS opcodes (!cpu 6510 / nmos6502)', () => {
    const src = `*= $1000
!cpu 6510
  slo $12
  rla $1234,x
  sre ($12),y
  rra ($12,x)
  sax $12,y
  lax $1234,y
  dcp $12,x
  isc $1234
  anc #$01
  asr #$02
  arr #$03
  sbx #$04
  ane #$05
  lxa #$06
  sha $1234,y
  shx $1234,y
  shy $1234,x
  tas $1234,y
  las $1234,y
  dop #$07
  top $1234
  jam
  nop $12
`;
    assert.deepEqual(bytes(src), h(`07 12  3f 34 12  53 12  63 12  97 12  bf 34 12  d7 12  ef 34 12
      0b 01  4b 02  6b 03  cb 04  8b 05  ab 06  9f 34 12  9e 34 12  9c 34 12  9b 34 12  bb 34 12
      80 07  0c 34 12  02  04 12`));
  });

  test('undocumented opcodes are rejected on plain 6502', () => {
    const r = asm('*=$1000\n  lax $12\n');
    assert.equal(r.ok, false);
    assert.match(r.errors[0].msg, /not available for CPU "6502"/);
  });

  test('65c02 / r65c02 / w65c02 extensions', () => {
    const src = `*= $1000
!cpu 65c02 {
  phx
  ply
  stz $12
  stz $1234,x
  bra *
  lda ($12)
  jmp ($1234,x)
  inc
  bit #$01
  tsb $12
}
!cpu r65c02 {
  rmb3 $12
  smb7 $12
  bbr0 $12, *
  bbs7 $12, *
}
!cpu w65c02 { wai : stp }
`;
    assert.deepEqual(bytes(src), h(`da 7a 64 12 9e 34 12 80 fe b2 12 7c 34 12 1a 89 01 04 12
      37 12 f7 12 0f 12 fd ff 12 fd cb db`));
  });

  test('unsupported CPUs report an error', () => {
    const r = asm('!cpu 65ce02\n');
    assert.equal(r.ok, false);
    assert.match(r.errors[0].msg, /Unsupported CPU "65ce02"/);
    assert.equal(asm('*=$1000\n!al\n').ok, false);
    assert.equal(asm('*=$1000\nnop', { cpu: 'm65' }).ok, false);
  });

  test('size postfixes +1 / +2', () => {
    assert.deepEqual(bytes('*=$1000\n lda+2 $12\n lda+1 $12\n sta+2 $fe,x\n'), h('ad 12 00 a5 12 9d fe 00'));
    assert.equal(asm('*=$1000\n lda+1 $1234\n').ok, false);
  });

  test('indirect vs. parenthesized expressions', () => {
    assert.deepEqual(bytes('*=$1000\n lda (2+3)*4\n lda (2+3)*400,x\n jmp ($fffc)\n'), h('a5 14 bd d0 07 6c fc ff'));
  });

  test('jmp ($xxff) warns', () => {
    const r = asm('*=$1000\n jmp ($10ff)\n');
    assert.ok(r.ok);
    assert.match(r.warnings[0].msg, /buggy JMP/);
  });
});

// ---------------------------------------------------------------- symbols / passes

describe('symbols and passes', () => {
  test('forward references and zero page selection', () => {
    const src = `*= $1000
  lda fwd        ; forward ref -> absolute (like ACME)
  lda+1 fwd      ; forced zp
fwd = $fb
  lda fwd        ; symbol was undefined in pass 1 -> stays absolute
back = $fc
  lda back       ; known -> zero page
  lda $00fc      ; leading zeros force absolute
  jmp later
  ldx back,y
  stx back,y
  sta back,y     ; no zp,y for sta -> absolute
later rts
`;
    assert.deepEqual(bytes(src), h('ad fb 00 a5 fb ad fb 00 a5 fc ad fc 00 4c 17 10 b6 fc 96 fc 99 fc 00 60'));
  });

  test('labels with and without colon, multiple statements per line', () => {
    assert.deepEqual(bytes('*=$1000\na: nop : b nop\nc\n jmp a : jmp b : jmp c\n'),
      h('ea ea 4c 00 10 4c 01 10 4c 02 10'));
  });

  test('anonymous labels', () => {
    const src = `*= $1000
--  nop
-   dex
    bne -
    bne --
    beq +
    beq ++
+   nop
++  rts
`;
    assert.deepEqual(bytes(src), h('ea ca d0 fd d0 fa f0 02 f0 01 ea 60'));
  });

  test('zones and local symbols', () => {
    const src = `*= $1000
!zone a
.l  nop
    jmp .l
!zone b
.l  nop
    jmp .l
!zone c {
.l  rts
}
    jmp .l
!zn
    !byte <.l2
.l2
`;
    const r = asm(src);
    assert.ok(r.ok, JSON.stringify(r.errors));
    assert.deepEqual(Array.from(r.output.slice(2)), h('ea 4c 00 10 ea 4c 04 10 60 4c 04 10 0d'));
    const locals = r.symbols.filter(s => s.name === '.l').map(s => [s.zone, s.value]);
    assert.deepEqual(locals.sort(), [['a', 0x1000], ['b', 0x1004], ['c', 0x1008]]);
  });

  test('cheap locals are scoped between global labels', () => {
    const src = `*= $1000
first
@l  nop
    jmp @l
second
@l  nop
    jmp @l
`;
    assert.deepEqual(bytes(src), h('ea 4c 00 10 ea 4c 04 10'));
  });

  test('symbol already defined / !set may be redefined', () => {
    const r = asm('*=$1000\nfoo nop\nfoo nop\n');
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].msg, 'Symbol already defined.');
    assert.equal(r.errors[0].line, 3);
    assert.deepEqual(bytes('*=$1000\n!set x = 1\n!byte x\n!set x = x + 1\n!byte x\ny = 3\ny = 3\n!byte y'), [1, 2, 3]);
  });

  test('undefined symbol', () => {
    const r = asm('*=$1000\n nop\n lda missing\n');
    assert.equal(r.ok, false);
    assert.equal(r.output, null);
    assert.deepEqual(r.errors.map(e => [e.line, e.msg]), [[3, 'Symbol not defined (missing).']]);
  });

  test('defines option, !ifdef / !ifndef', () => {
    const src = '*=$1000\n!ifdef DEBUG { !byte DEBUG } else { !byte 0 }\n!ifndef DEBUG !byte $ff\n';
    assert.deepEqual(bytes(src, { defines: { DEBUG: 7 } }), [7]);
    assert.deepEqual(bytes(src), [0, 0xff]);
  });

  test('include guard with !ifndef works across passes', () => {
    const lib = '!ifndef LIB_A { LIB_A = 1\nlibfn rts\n}\n';
    const src = '*=$1000\n!src "lib.a"\n!src "lib.a"\n jsr libfn\n';
    assert.deepEqual(bytes(src, {}, { 'lib.a': lib }), h('60 20 00 10'));
  });

  test('symbols output', () => {
    const r = asm('*=$1000\nstart nop\nCONST = 5\n!zone z\n.loc rts\n');
    const by = Object.fromEntries(r.symbols.map(s => [s.name, s]));
    assert.deepEqual(by.start, { name: 'start', value: 0x1000, file: 'main.asm', line: 2, kind: 'label' });
    assert.deepEqual(by.CONST, { name: 'CONST', value: 5, file: 'main.asm', line: 3, kind: 'set' });
    assert.equal(by['.loc'].zone, 'z');
  });
});

// ---------------------------------------------------------------- expressions

describe('expressions', () => {
  test('numbers and operators with ACME precedence', () => {
    const src = `*=$1000
!byte <$1234+1, >$1234, ^$123456
!byte 2+3*4, 2^3, (-2^2) & $ff, 7 DIV 2, 7 % 3, 7 MOD 4, 1 << 3, $f0 >> 4, $80 >>> 7
!byte %..##, %0101, &17, 0x10, 0b11, 'A', "B", 10
!byte 3 = 3, 3 == 3, 3 != 4, 3 <> 3, 2 < 3, 3 <= 2, 4 > 3, 4 >= 5
!byte $0f XOR $ff, $0f EOR $f0, $f0 OR $0f, $f0 | 1, $f0 AND $3c, $f0 & $3c, NOT 0 & $ff, !$f0 & $ff
!byte 1 ASL 2, 8 LSR 1, 2 ** 3
!byte int(1.5 * 3), int(sin(0)), len([1,2,3]), len("abcd"), is_number(1), is_string("x"), is_list([1])
!byte [10, 20, 30][1], "xyz"[2]
!word int(1000.7), float(2) * 1.5
!byte *-$1000
`;
    assert.deepEqual(bytes(src), [
      0x35, 0x12, 0x12,
      14, 8, 0xfc, 3, 1, 3, 8, 0x0f, 1,
      3, 5, 15, 16, 3, 0x41, 0x42, 10,
      1, 1, 1, 0, 1, 0, 1, 0,
      0xf0, 0xff, 0xff, 0xf1, 0x30, 0x30, 0xff, 0x0f,
      4, 4, 8,
      4, 0, 3, 4, 1, 1, 1,
      20, 0x7a,
      0xe8, 0x03, 3, 0,
      52,
    ]);
  });

  test('lowbyte / highbyte of labels in immediate mode', () => {
    assert.deepEqual(bytes('*=$c000\n lda #<tab\n ldx #>tab\ntab !byte 0\n'), h('a9 04 a2 c0 00'));
  });

  test('division by zero is an error', () => {
    const r = asm('*=$1000\n!byte 1/0\n');
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].msg, 'Division by zero.');
  });
});

// ---------------------------------------------------------------- macros

describe('macros', () => {
  test('parameters, nesting, call-by-reference and local labels', () => {
    const src = `*= $1000
!macro poke .addr, .val {
    lda #.val
    sta .addr
}
!macro poke2 .a, .v {
    +poke .a, .v
    +poke .a + 1, .v
}
!macro setref ~.sym, .val {
    .sym = .val
}
!macro wait {
-   dex
    bne -
.l  bne .l
}
    +poke $d020, 0
    +poke2 $d020, 1
    +setref ~result, 42
    !byte result
    +wait
    +wait
`;
    assert.deepEqual(bytes(src), h(`a9 00 8d 20 d0  a9 01 8d 20 d0 a9 01 8d 21 d0  2a
      ca d0 fd d0 fe  ca d0 fd d0 fe`));
  });

  test('macro used before definition (multi-pass)', () => {
    assert.deepEqual(bytes('*=$1000\n +m 5\n jmp end\n!macro m .x { !byte .x }\nend rts\n'), h('05 4c 04 10 60'));
  });

  test('call-by-reference modifies caller symbol via !set', () => {
    assert.deepEqual(bytes('*=$1000\n!macro inc ~.v { !set .v = .v + 1 }\n!set n = 1\n+inc ~n\n+inc ~n\n!byte n\n'), [3]);
  });

  test('macro errors', () => {
    let r = asm('*=$1000\n+nothere\n');
    assert.equal(r.ok, false);
    assert.match(r.errors[0].msg, /Macro not defined/);
    r = asm('*=$1000\n!macro m .a { nop }\n+m\n');
    assert.match(r.errors[0].msg, /Wrong number of macro arguments/);
    r = asm('*=$1000\n!macro rec { +rec }\n+rec\n');
    assert.match(r.errors[0].msg, /Too deeply nested/);
  });
});

// ---------------------------------------------------------------- flow control

describe('flow control', () => {
  test('!for / !do / !while / !if', () => {
    const src = `*= $1000
!for i, 1, 4 { !byte i }
!for i, 3, 1 { !byte i }
!for v in [5, 6, 7] { !byte v }
!for c in "ab" { !byte c }
!set c = 0
!do { !byte c : !set c = c + 1 } while c < 3
!set c = 0
!do until c = 2 { !byte $10 + c : !set c = c + 1 }
!set c = 3
!while c > 0 { !byte c : !set c = c - 1 }
!if 1 { !byte $aa } else { !byte $bb }
!if 0 { !byte $aa } else if 1 { !byte $cc } else { !byte $bb }
!if 0 {
  !byte 1
} else if 0 {
  !byte 2
} else {
  !byte $dd
}
!ifdef UNDEFINED_X { !byte 1 } else { !byte 2 }
!ifndef UNDEFINED_X { !byte 3 }
`;
    assert.deepEqual(bytes(src), h('01 02 03 04 03 02 01 05 06 07 61 62 00 01 02 10 11 03 02 01 aa cc dd 02 03'));
  });

  test('!if on a forward-referenced symbol', () => {
    assert.deepEqual(bytes('*=$1000\n!if MODE = 2 { !byte 2 } else { !byte 1 }\nMODE = 2\n'), [2]);
  });

  test('!eof stops the file, !warn / !error / !serious', () => {
    assert.deepEqual(bytes('*=$1000\n!byte 1\n!eof\n!byte 2\n'), [1]);
    let r = asm('*=$1000\n!warn "value is ", 5\n');
    assert.ok(r.ok);
    assert.deepEqual(r.warnings, [{ file: 'main.asm', line: 2, col: 21, msg: 'value is 5' }]);
    r = asm('*=$1000\n!error "bad"\n!byte 1\n!error "worse"\n');
    assert.deepEqual(r.errors.map(e => [e.line, e.msg]), [[2, 'bad'], [4, 'worse']]);
    r = asm('*=$1000\n!serious "stop"\n!error "not reached"\n');
    assert.deepEqual(r.errors.map(e => e.msg), ['stop']);
  });
});

// ---------------------------------------------------------------- data / pseudo ops

describe('data pseudo opcodes', () => {
  test('byte/word/24/32 variants, hex, fill, skip, align, initmem', () => {
    const src = `*= $1000
!by 1 : !08 2 : !8 3
!wo $1234 : !16 $5678 : !le16 $9abc : !be16 $1234
!24 $123456 : !be24 $123456
!32 $12345678 : !be32 $12345678
!hex 01 02 ff
!h 0a0b
!fill 3, $aa
!fi 2
!skip 2
!byte $ee
!align 3, 0
!byte $01
`;
    assert.deepEqual(bytes(src), h(`01 02 03  34 12 78 56 bc 9a 12 34  56 34 12 12 34 56  78 56 34 12 12 34 56 78
      01 02 ff 0a 0b aa aa aa 00 00 00 00 ee ea ea 01`));
    assert.deepEqual(bytes('*=$1000\n!initmem $ff\n!byte 1\n!skip 2\n!byte 2\n'), h('01 ff ff 02'));
  });

  test('number out of range', () => {
    const r = asm('*=$1000\n!byte 256\n lda #$100\n!word $10000\n!byte -128, -129\n');
    assert.deepEqual(r.errors.map(e => [e.line, e.msg]), [
      [2, 'Number out of range.'], [3, 'Number out of range.'], [4, 'Number out of range.'], [5, 'Number out of range.'],
    ]);
  });

  test('!text / !pet / !raw / !scr / !scrxor / !convtab', () => {
    const src = `*= $1000
!text "AbC@", 13
!pet "AbC@z"
!raw "AbC"
!scr "AbC@[az"
!scrxor $80, "a@"
!ct scr { !tx "ab" : lda #'a' }
!ct pet
!tx "a"
lda #'a'
!ct raw
!tx "a"
!byte "AB"
!text "a\\"b\\\\"
`;
    assert.deepEqual(bytes(src), h(`41 62 43 40 0d  c1 42 c3 40 5a  41 62 43  41 02 43 00 1b 01 1a  81 80  01 02 a9 01
      41 a9 41  61  41 42  61 22 62 5c`));
  });

  test('!convtab from file', () => {
    const tab = new Uint8Array(256).map((_, i) => 255 - i);
    assert.deepEqual(bytes('*=$1000\n!ct "tab.bin" { !text "A" }\n!text "A"', {}, { 'tab.bin': tab }), [0xbe, 0x41]);
  });

  test('!xor', () => {
    assert.deepEqual(bytes('*=$1000\n!xor $ff { !byte 0, 1 }\n!byte 0\n!xor $0f\n!byte $f0\n'), h('ff fe 00 ff'));
  });

  test('!binary from the files map', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const src = '*=$1000\n!bin "data.bin"\n!binary "data.bin", 2, 1\n!bi "data.bin",,3\n!bin "data.bin", 7\n';
    assert.deepEqual(bytes(src, {}, { 'data.bin': data }), h('01 02 03 04 05  02 03  04 05  01 02 03 04 05 00 00'));
    const r = asm('*=$1000\n!bin "nope.bin"\n');
    assert.deepEqual(r.errors.map(e => [e.line, e.msg]), [[2, 'Cannot open input file "nope.bin".']]);
  });

  test('!source with relative paths, root fallback and <lib> paths', () => {
    const files = new Map([
      ['src/main.asm', '*= $1000\n!src "inc/a.asm"\n!source "common.asm"\n!src <std/macros.a>\n+m\n'],
      ['src/inc/a.asm', '!byte 1\n!src "b.asm"\n'],
      ['src/inc/b.asm', '!byte 2\n!bin "../data/x.bin"\n'],
      ['src/data/x.bin', new Uint8Array([9])],
      ['common.asm', '!byte 3\n'],
      ['lib/std/macros.a', '!macro m { !byte 4 }\n'],
    ]);
    const r = assemble('src/main.asm', files);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(Array.from(r.output.slice(2)), [1, 2, 9, 3, 4]);
    assert.deepEqual(r.lines.map(l => [l.file, l.line, l.addr]), [
      ['src/inc/a.asm', 1, 0x1000], ['src/inc/b.asm', 1, 0x1001], ['src/inc/b.asm', 2, 0x1002],
      ['common.asm', 1, 0x1003], ['lib/std/macros.a', 1, 0x1004, ], ['src/main.asm', 5, 0x1004],
    ].map(x => x.slice(0, 3)));
  });

  test('errors in included files report the included file', () => {
    const r = assemble('main.asm', new Map([['main.asm', '*=$1000\n!src "inc.asm"\n'], ['inc.asm', 'nop\n\n lda #\n']]));
    assert.equal(r.errors[0].file, 'inc.asm');
    assert.equal(r.errors[0].line, 3);
  });

  test('!pseudopc and !realpc', () => {
    const src = `*= $1000
    lda #0
!pseudopc $c000 {
reloc   jmp reloc
        nop
}
after   jmp after
!pseudopc $2000
x2      jmp x2
!realpc
x3      jmp x3
`;
    const r = asm(src);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(Array.from(r.output.slice(2)), h('a9 00 4c 00 c0 ea 4c 06 10 4c 00 20 4c 0c 10'));
    assert.equal(r.lines.find(l => l.line === 4).addr, 0xc000);
    assert.equal(r.start, 0x1000);
    assert.equal(r.end, 0x100f);
  });

  test('segments: overlapping *= warns', () => {
    const r = asm('*=$1000\n!fill 4\n*=$1002\n!byte 1\n');
    assert.ok(r.ok);
    assert.match(r.warnings[0].msg, /Segment starts inside another one/);
    assert.deepEqual(Array.from(r.output.slice(2)), [0, 0, 1, 0]);
  });
});

// ---------------------------------------------------------------- output

describe('output', () => {
  test('!to cbm adds load address; plain and apple formats', () => {
    let r = asm('!to "game.prg", cbm\n*= $c000\n rts\n');
    assert.equal(r.outputName, 'game.prg');
    assert.equal(r.format, 'cbm');
    assert.deepEqual(Array.from(r.output), [0x00, 0xc0, 0x60]);
    r = asm('!to "game.bin", plain\n*= $c000\n rts\n');
    assert.equal(r.format, 'plain');
    assert.deepEqual(Array.from(r.output), [0x60]);
    r = asm('!to "game", apple\n*= $0803\n rts : rts\n');
    assert.deepEqual(Array.from(r.output), [0x03, 0x08, 0x02, 0x00, 0x60, 0x60]);
    r = asm('*= $c000\n rts\n', { format: 'plain' });
    assert.equal(r.outputName, null);
    assert.deepEqual(Array.from(r.output), [0x60]);
    r = asm('!to "x.prg"\n*= $c000\n rts\n');
    assert.match(r.warnings[0].msg, /without file format/);
  });

  test('vicelabels text', () => {
    const r = asm('*= $1000\nstart  lda #CONST\nCONST = 5\nunused = 7\nloop  jmp loop\n');
    assert.equal(r.viceLabels, 'al C:0007 .unused\n\nal C:0005 .CONST\n\nal C:1002 .loop\nal C:1000 .start\n');
  });

  test('!sl / !svl names and symbol list', () => {
    const r = asm('!sl "syms.txt"\n!svl "labels.txt"\n*= $1000\nstart rts\nv = 3\n');
    assert.equal(r.symbolListName, 'syms.txt');
    assert.equal(r.viceLabelsName, 'labels.txt');
    assert.equal(r.symbolList, 'start\t= $1000\t; ?\nv\t= 3\t; ?\n');
  });

  test('lines mapping incl. macro expansion', () => {
    const src = `*= $1000
  lda #1
!macro m {
  nop
  nop
}
  +m
!for i, 0, 1 { !byte i }
`;
    const r = asm(src);
    assert.deepEqual(r.lines, [
      { file: 'main.asm', line: 2, addr: 0x1000, size: 2 },
      { file: 'main.asm', line: 4, addr: 0x1002, size: 1, macro: true },
      { file: 'main.asm', line: 5, addr: 0x1003, size: 1, macro: true },
      { file: 'main.asm', line: 7, addr: 0x1002, size: 2 },
      { file: 'main.asm', line: 8, addr: 0x1004, size: 2 },
    ]);
  });

  test('listing', () => {
    const r = asm('*= $1000\n  lda #1 ; comment\n');
    assert.equal(r.listing, '\n; ******** Source: main.asm\n     1                           *= $1000\n     2  1000 a901                  lda #1 ; comment\n');
  });
});

// ---------------------------------------------------------------- errors

describe('errors', () => {
  test('errors carry correct line numbers and assembly continues', () => {
    const src = `*= $1000
  nop
  lda #$100
  foo bar
  lda undefined_sym
  !byte 1,
  !unknownop
  sta
  lda (1,y)
  nop
`;
    const r = asm(src);
    assert.equal(r.ok, false);
    assert.deepEqual(r.errors.map(e => [e.line, e.msg]), [
      [3, 'Number out of range.'],
      [4, 'Garbage data at end of statement.'],
      [5, 'Symbol not defined (undefined_sym).'],
      [6, 'Value expected.'],
      [7, 'Unknown pseudo opcode.'],
      [8, 'Illegal combination of command and addressing mode.'],
      [9, 'Illegal combination of command and addressing mode.'],
    ]);
    for (const e of r.errors) assert.equal(e.file, 'main.asm');
  });

  test('branch out of range', () => {
    const r = asm('*= $1000\n  bne far\n  !fill 200\nfar rts\n  beq back\nback\n');
    assert.deepEqual(r.errors.map(e => [e.line, e.msg]), [[2, 'Target out of range (200; 73 too far).']]);
    // exact limits are fine
    assert.equal(asm('*=$1000\n bne *+129\n bne *-126\n').ok, true);
    assert.equal(asm('*=$1000\n bne *+130\n').ok, false);
  });

  test('block errors', () => {
    let r = asm('*=$1000\n!if 1 {\n nop\n');
    assert.deepEqual(r.errors.map(e => [e.line, e.msg]), [[2, "Found end-of-file instead of '}'."]]);
    r = asm('*=$1000\n nop\n}\n');
    assert.deepEqual(r.errors.map(e => [e.line, e.msg]), [[3, "Found '}' instead of end-of-file."]]);
  });

  test('program counter undefined, missing main file, never throws', () => {
    assert.equal(asm(' nop\n').errors[0].msg, 'Program counter undefined.');
    const r = assemble('nope.asm', new Map());
    assert.equal(r.ok, false);
    assert.match(r.errors[0].msg, /Cannot open input file/);
    for (const junk of ['"', '!for', '!macro', '+', '-', '*=', '((((', '!if {', '\u0000\u0001', '!byte [1,', '}}}{{{']) {
      const x = asm('*=$1000\n' + junk + '\n');
      assert.equal(typeof x.ok, 'boolean');
    }
  });

  test('implicit label warning', () => {
    const r = asm('*=$1000\n  foo\n  nop\n');
    assert.ok(r.ok);
    assert.match(r.warnings[0].msg, /Implicit label definition not in leftmost column/);
  });
});

// ---------------------------------------------------------------- disassembler

describe('disassemble', () => {
  const textFor = (mn, mode) => {
    const op = { imp: '', imm: '#$12', zp: '$12', zpx: '$12,x', zpy: '$12,y', abs: '$1234', absx: '$1234,x', absy: '$1234,y',
      ind: '($1234)', indx: '($12,x)', indy: '($12),y', izp: '($12)', iax: '($1234,x)', rel: '$1012', zprel: '$12,$1013',
      sr: '$12,s', sry: '($12,s),y', ildp: '[$12]', ildpy: '[$12],y', long: '$123456', longx: '$123456,x', ialong: '[$1234]', rell: '$2234', blk: '$01,$02' }[mode];
    return op ? `${mn} ${op}` : mn;
  };

  for (const cpu of Object.keys(CPU_TABLES)) {
    test(`round trip of every ${cpu} opcode`, () => {
      for (const [mn, modes] of Object.entries(CPU_TABLES[cpu])) {
        for (const [mode, op] of Object.entries(modes)) {
          const [operand] = OPERAND[mode];
          const r = asm(`!cpu ${cpu}\n*= $1000\n ${mn} ${operand}\n`);
          assert.deepEqual(r.errors, [], `${cpu} ${mn} ${operand}`);
          const code = r.output.slice(2);
          assert.equal(code.length, MODE_LEN[mode]);
          assert.equal(code[0], op);
          const d = disassemble(code, 0x1000, cpu);
          assert.equal(d.length, 1);
          assert.equal(d[0].addr, 0x1000);
          assert.deepEqual(d[0].bytes, Array.from(code));
          const [dmn] = d[0].text.split(' ');
          if (dmn === mn) assert.equal(d[0].text, textFor(mn, mode));
          // re-assemble the disassembly -> identical bytes
          const r2 = asm(`!cpu ${cpu}\n*= $1000\n ${d[0].text}\n`);
          assert.deepEqual(Array.from(r2.output.slice(2)), Array.from(code), d[0].text);
        }
      }
    });
  }

  test('65816: !al and !rl make the immediates 16 bits, rep and sep are followed', () => {
    const r = asm('!cpu 65816\n*= $8000\n rep #$30\n!al\n!rl\n lda #$1234\n ldx #$5678\n sep #$20\n!as\n lda #$12\n ldy #$9abc\n jsl $018000\n lda $7e0010,x\n mvn $7e, $7f\n brl * + 3\n');
    assert.deepEqual(r.errors, []);
    const code = r.output.slice(2);
    assert.deepEqual(Array.from(code), h('c2 30 a9 34 12 a2 78 56 e2 20 a9 12 a0 bc 9a 22 00 80 01 bf 10 00 7e 54 7f 7e 82 00 00'));
    assert.deepEqual(disassemble(code, 0x8000, '65816').map(x => x.text), ['rep #$30', 'lda #$1234', 'ldx #$5678', 'sep #$20', 'lda #$12', 'ldy #$9abc',
      'jsl $018000', 'lda $7e0010,x', 'mvn $7e,$7f', 'brl $801d']);
  });

  test('unknown opcodes and truncated instructions become !byte', () => {
    assert.deepEqual(disassemble([0x02, 0xad, 0x34], 0x2000), [
      { addr: 0x2000, bytes: [0x02], text: '!byte $02' },
      { addr: 0x2001, bytes: [0xad], text: '!byte $ad' },
      { addr: 0x2002, bytes: [0x34], text: '!byte $34' },
    ]);
    assert.equal(disassemble([0x02], 0, '6510')[0].text, 'jam');
  });
});

// ---------------------------------------------------------------- realistic program

describe('C64 program', () => {
  test('BASIC SYS stub + raster IRQ assembles to exact bytes', () => {
    const src = `; raster bar demo
!to "raster.prg", cbm
!cpu 6510

VIC_RASTER = $d012
BORDER     = $d020

*= $0801
        !byte $0b, $08, $0a, $00, $9e, $32, $30, $36, $31, $00, $00, $00   ; 10 SYS2061
*= $080d
start   sei
        lda #$7f
        sta $dc0d               ; disable CIA interrupts
        lda #$01
        sta $d01a               ; enable raster IRQ
        lda #<irq
        sta $0314
        lda #>irq
        sta $0315
        lda #$80
        sta VIC_RASTER
        lda $d011
        and #$7f
        sta $d011
        cli
-       jmp -

irq     inc $d019               ; acknowledge
        inc BORDER
        jmp $ea31
`;
    const r = asm(src);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.outputName, 'raster.prg');
    assert.equal(r.start, 0x0801);
    assert.equal(r.end, 0x083c);
    assert.deepEqual(Array.from(r.output), h(`01 08
      0b 08 0a 00 9e 32 30 36 31 00 00 00
      78 a9 7f 8d 0d dc a9 01 8d 1a d0 a9 33 8d 14 03 a9 08 8d 15 03
      a9 80 8d 12 d0 ad 11 d0 29 7f 8d 11 d0 58 4c 30 08
      ee 19 d0 ee 20 d0 4c 31 ea`));
    assert.ok(r.viceLabels.includes('al C:0833 .irq\n'));
    assert.ok(r.viceLabels.includes('al C:080d .start\n'));
  });

  test('polling raster loop with BASIC line built from expressions', () => {
    const src = `*= $0801
        !word next, 10
        !byte $9e
        !text "2061"
        !byte 0
next    !word 0
        ; main
        sei
loop    lda $d012
        cmp #$ff
        bne loop
        inc $d020
        jmp loop
`;
    assert.deepEqual(bytes(src), h(`0b 08 0a 00 9e 32 30 36 31 00 00 00
      78 ad 12 d0 c9 ff d0 f9 ee 20 d0 4c 0e 08`));
  });
});

// ---------------------------------------------------------------- docs

describe('docs.js', () => {
  test('completion data is complete', () => {
    for (const cpu of ['6502', '6510', 'nmos6502', '65c02', 'r65c02', 'w65c02']) {
      assert.ok(MNEMONICS[cpu].length > 0);
      for (const m of MNEMONICS[cpu]) {
        assert.ok(m.name && m.desc && m.desc !== m.name && Array.isArray(m.modes) && m.modes.length, m.name);
      }
    }
    assert.equal(MNEMONICS['6502'].length, 56);
    const names = new Set(PSEUDO_OPS.map(p => p.name));
    for (const n of ['!to', '!byte', '!by', '!08', '!wo', '!hex', '!h', '!fi', '!tx', '!pet', '!scr', '!scrxor', '!ct', '!bin',
      '!src', '!macro', '!if', '!ifdef', '!for', '!do', '!while', '!set', '!zn', '!sl', '!svl', '!pseudopc', '!realpc', '!cpu',
      '!initmem', '!xor', '!warn', '!error', '!serious', '!eof', '!endoffile', '!addr', '!address', '!align', '!skip']) {
      assert.ok(names.has(n), n);
    }
    // every documented pseudo op is accepted by the assembler (no "Unknown pseudo opcode.")
    for (const p of PSEUDO_OPS) {
      const r = asm(`*=$1000\n${p.name}\n`);
      assert.ok(!r.errors.some(e => e.msg === 'Unknown pseudo opcode.'), p.name);
    }
    assert.ok(CPUS.find(c => c.name === '6510').supported);
  });
});
