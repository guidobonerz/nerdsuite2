import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, detokenize } from '../public/js/basic/basic.js';
import { DIALECTS } from '../public/js/basic/dialects.js';
import { CONTROL_CODES, lookupControlCode, controlCodesFor } from '../public/js/basic/petscii.js';

const PRG_DIALECTS = ['v2', 'v4', 'v35', 'v7', 'simons'];
const bytes = (...a) => Uint8Array.from(a.flat());
/** tokenized content of the first line (without link, line number and terminator) */
const body = (src, opts) => {
  const r = tokenize(src, opts);
  assert.ok(r.ok, JSON.stringify(r.errors));
  return Array.from(r.prg.subarray(6, r.prg.length - 3));
};

test('exact bytes of a known C64 program', () => {
  const r = tokenize('10 print "{clr}hello":goto 10');
  assert.equal(r.ok, true);
  assert.equal(r.start, 0x0801);
  assert.deepEqual(r.prg, bytes(
    0x01, 0x08, // load address
    0x15, 0x08, 0x0a, 0x00, // link -> $0815, line 10
    0x99, 0x20, 0x22, 0x93, 0x48, 0x45, 0x4c, 0x4c, 0x4f, 0x22, 0x3a, 0x89, 0x20, 0x31, 0x30, 0x00,
    0x00, 0x00, // end of program
  ));
  assert.deepEqual(r.lines, [{ src: 1, number: 10, addr: 0x0801 }]);
});

test('multi-line link pointers and lines[]', () => {
  const r = tokenize('10 a=1\n\n20 ?a\n');
  assert.ok(r.ok);
  assert.deepEqual(r.prg, bytes(
    0x01, 0x08,
    0x09, 0x08, 0x0a, 0x00, 0x41, 0xb2, 0x31, 0x00,
    0x10, 0x08, 0x14, 0x00, 0x99, 0x41, 0x00,
    0x00, 0x00,
  ));
  assert.deepEqual(r.lines, [{ src: 1, number: 10, addr: 0x0801 }, { src: 3, number: 20, addr: 0x0809 }]);
});

test('load addresses per dialect and machine', () => {
  const start = (o) => tokenize('10 end', o).start;
  assert.equal(start({}), 0x0801);
  assert.equal(start({ machine: 'vic20' }), 0x1001);
  assert.equal(start({ machine: 'vic20+3k' }), 0x0401);
  assert.equal(start({ machine: 'vic20+8k' }), 0x1201);
  assert.equal(start({ dialect: 'v4' }), 0x0401);
  assert.equal(start({ dialect: 'v35' }), 0x1001);
  assert.equal(start({ dialect: 'v7' }), 0x1c01);
  assert.equal(start({ dialect: 'simons' }), 0x0801);
  assert.equal(start({ start: 0x4001 }), 0x4001);
  const r = tokenize('10 end', { machine: 'vic20' });
  assert.deepEqual(Array.from(r.prg.subarray(0, 4)), [0x01, 0x10, 0x07, 0x10]);
});

test('operators, functions, uppercase input, ? = print', () => {
  assert.deepEqual(body('10 IF A<>B THEN PRINT CHR$(65)+"X"'),
    [0x8b, 0x20, 0x41, 0xb3, 0xb1, 0x42, 0x20, 0xa7, 0x20, 0x99, 0x20, 0xc7, 0x28, 0x36, 0x35, 0x29, 0xaa, 0x22, 0xd8, 0x22]);
  assert.deepEqual(body('10 ?"a"'), [0x99, 0x22, 0x41, 0x22]);
  assert.deepEqual(body('10 x=~*2'), [0x58, 0xb2, 0xff, 0xac, 0x32]);
  // keywords are tokenized everywhere outside strings (like the C64): "fort" -> FOR T
  assert.deepEqual(body('10 fort=1to2'), [0x81, 0x54, 0xb2, 0x31, 0xa4, 0x32]);
  assert.deepEqual(body('10 go to 10'), [0xcb, 0x20, 0xa4, 0x20, 0x31, 0x30]);
});

test('strings, REM and DATA are not tokenized', () => {
  assert.deepEqual(body('10 rem print goto'), [0x8f, 0x20, 0x50, 0x52, 0x49, 0x4e, 0x54, 0x20, 0x47, 0x4f, 0x54, 0x4f]);
  assert.deepEqual(body('10 print "print"'), [0x99, 0x20, 0x22, 0x50, 0x52, 0x49, 0x4e, 0x54, 0x22]);
  // DATA ends at ':' outside quotes
  assert.deepEqual(body('10 data to,"a:to":to'), [0x83, 0x20, 0x54, 0x4f, 0x2c, 0x22, 0x41, 0x3a, 0x54, 0x4f, 0x22, 0x3a, 0xa4]);
  // ? stays literal in strings/REM
  assert.deepEqual(body('10 rem ?'), [0x8f, 0x20, 0x3f]);
  // shifted letters inside strings/REM (petcat: uppercase ASCII -> $C1-$DA)
  assert.deepEqual(body('10 rem Ab'), [0x8f, 0x20, 0xc1, 0x42]);
});

test('control codes', () => {
  assert.deepEqual(body('10 print "{clr}{home}{down}{rvs on}{wht}{f1}{$ff}{147}{shift-a}{cbm-a}{rvof}"'),
    [0x99, 0x20, 0x22, 0x93, 0x13, 0x11, 0x12, 0x05, 0x85, 0xff, 0x93, 0xc1, 0xb0, 0x92, 0x22]);
  assert.deepEqual(body('10 print "{3 down}{right*2}{2left}"'), [0x99, 0x20, 0x22, 0x11, 0x11, 0x11, 0x1d, 0x1d, 0x9d, 0x9d, 0x22]);
  assert.deepEqual(body('10 rem {CLR}{Red}'), [0x8f, 0x20, 0x93, 0x1c]);
  assert.deepEqual(body('10 {p}r{i}nt'), [0x50, 0x52, 0x49, 0x4e, 0x54]);
  assert.equal(lookupControlCode('blu', 'v2'), 0x1f);
  assert.equal(lookupControlCode('flon', 'v35'), 0x82);
  assert.equal(lookupControlCode('flon', 'v2'), -1);
  assert.ok(CONTROL_CODES.find((c) => c.name === 'clr' && c.code === 0x93));
  for (const d of PRG_DIALECTS) {
    for (const c of controlCodesFor(d)) assert.equal(lookupControlCode(c.name, d), c.code, `${d} ${c.name}`);
  }
  const r = tokenize('10 print "{nosuchcode}"');
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].line, 1);
  assert.match(r.errors[0].msg, /unknown control code/);
});

test('error lines', () => {
  const r = tokenize('10 print\nprint "x"\n20 a\n20 b\n15 c\n70000 d\n30 {clr\n40\n50 ok');
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.map((e) => e.line), [2, 4, 5, 6, 7, 8]);
  assert.match(r.errors[0].msg, /missing line number/);
  assert.match(r.errors[1].msg, /duplicate/);
  assert.match(r.errors[2].msg, /not greater/);
  assert.match(r.errors[3].msg, /out of range/);
  assert.match(r.errors[4].msg, /unterminated/);
  // valid lines are still emitted
  assert.deepEqual(r.lines.map((l) => l.number), [10, 20, 50]);
  const long = tokenize('10 rem ' + 'x'.repeat(300));
  assert.equal(long.ok, false);
  assert.match(long.errors[0].msg, /too long/);
  assert.equal(tokenize('63999 end').ok, true);
  assert.equal(tokenize('64000 end').ok, false);
});

test('BASIC 4.0 tokens', () => {
  assert.deepEqual(body('10 dopen#1,"x":directory:concat', { dialect: 'v4' }),
    [0xcd, 0x23, 0x31, 0x2c, 0x22, 0x58, 0x22, 0x3a, 0xda, 0x3a, 0xcc]);
  // not keywords in plain V2
  assert.deepEqual(body('10 directory').slice(0, 3), [0x44, 0x49, 0x52]);
});

test('BASIC 3.5 tokens', () => {
  assert.deepEqual(body('10 graphic 1:color 0,1:x=rlum(1):do:loop until x', { dialect: 'v35' }),
    [0xde, 0x20, 0x31, 0x3a, 0xe7, 0x20, 0x30, 0x2c, 0x31, 0x3a, 0x58, 0xb2, 0xce, 0x28, 0x31, 0x29, 0x3a, 0xeb, 0x3a, 0xec, 0x20, 0xfc, 0x20, 0x58]);
});

test('BASIC 7.0 two-byte tokens', () => {
  assert.deepEqual(body('10 bank 15:fast:slow:x=pot(1)+xor(1,2):sprite 1,1:dopen#1,"a":do', { dialect: 'v7' }),
    [0xfe, 0x02, 0x20, 0x31, 0x35, 0x3a, 0xfe, 0x25, 0x3a, 0xfe, 0x26, 0x3a, 0x58, 0xb2, 0xce, 0x02, 0x28, 0x31, 0x29, 0xaa,
      0xce, 0x08, 0x28, 0x31, 0x2c, 0x32, 0x29, 0x3a, 0xfe, 0x07, 0x20, 0x31, 0x2c, 0x31, 0x3a, 0xfe, 0x0d, 0x23, 0x31, 0x2c, 0x22, 0x41, 0x22, 0x3a, 0xeb]);
  assert.deepEqual(body('10 stash:fetch:swap:pointer(a)', { dialect: 'v7' }),
    [0xfe, 0x1f, 0x3a, 0xfe, 0x21, 0x3a, 0xfe, 0x23, 0x3a, 0xce, 0x0a, 0x28, 0x41, 0x29]);
  // rlum is not a 7.0 keyword ($CE is the prefix there)
  assert.deepEqual(body('10 rlum', { dialect: 'v7' }), [0x52, 0x4c, 0x55, 0x4d]);
  assert.equal(detokenize(bytes(0x01, 0x1c, 0x08, 0x1c, 0x0a, 0x00, 0xfe, 0x17, 0x00, 0x00, 0x00), { dialect: 'v7' }), '10 collision\n');
});

test("Simons' BASIC tokens", () => {
  assert.deepEqual(body('10 hires 0,1:plot 1,2,1:hi col:end proc:print', { dialect: 'simons' }),
    [0x64, 0x01, 0x20, 0x30, 0x2c, 0x31, 0x3a, 0x64, 0x02, 0x20, 0x31, 0x2c, 0x32, 0x2c, 0x31, 0x3a, 0x64, 0x0c, 0x3a, 0x64, 0x34, 0x3a, 0x99]);
  // Simons' keywords take precedence over V2 ones ("on error" vs "on", "end proc" vs "end")
  assert.deepEqual(body('10 on error:goto 9', { dialect: 'simons' }).slice(0, 2), [0x64, 0x43]);
  assert.deepEqual(body('10 print at(1,2)"x"', { dialect: 'simons' }).slice(0, 4), [0x99, 0x20, 0x64, 0x28]);
  assert.deepEqual(body('10 hires'), [0x48, 0x49, 0x52, 0x45, 0x53]);
});

const SAMPLES = {
  v2: `10 print "{clr}{wht}hello world{$a0}{rvs on}x{rvof}":goto 10
20 for i=1 to 10 step 2:a$=left$("abc",2)+chr$(13):next i
30 if a>=1 and not b<>2 then poke 53280,peek(53281)or 1
40 data 1,2,"x:y",abc: rem trailing ? stuff {cbm-a}{shift-z}
50 open 1,8,15,"i0":print#1,"x":close 1:x=~*2-3/4^5
60 rem Shifted Text in REM and "{cbm-*}"
70 def fn f(x)=x*2:print fn f(3);tab(5);spc(2);pos(0)
80 get a$:input "name";n$:sys 64738:wait 198,1
90 a=rnd(-ti):b=sqr(abs(int(sgn(-2))))
100 on x goto 10,20:on y gosub 30:return:stop:end
`,
  v4: `10 dopen#1,"data",d0,w:print#1,"x":dclose#1
20 directory:catalog d1:header "disk",d0,i01
30 scratch "old":rename "a" to "b":copy "x" to "y":concat "a" to "b"
40 dsave "prog":dload "prog":append#2,"log":record#2,5
50 collect:backup d0 to d1:print "{clr}ok"
`,
  v35: `10 graphic 1,1:color 1,2,5:draw 1,0,0 to 159,99
20 circle 1,80,50,20:box 1,10,10,40,40:paint 1,15,15
30 char 1,0,0,"hello":scnclr:sound 1,500,60:vol 8
40 do:get a$:loop until a$<>"":x=joy(1):y=rlum(2):z=rclr(1)
50 trap 100:print hex$(dec("ff"));err$(1);instr("abc","b")
60 key 1,"list"+chr$(13):pudef " ":print using "##.#";1.5
70 if x then print "a":else print "b"
80 print "{flon}{help}{dblu}{pink}{blgn}"
90 restore 10:monitor:renumber:delete 10-20:auto 10
100 resume next
`,
  v7: `10 graphic 1,1:color 1,2:draw 1,0,0 to 319,199
20 sprite 1,1,2:movspr 1,100,100:sprcolor 3,4:collision 1,100
30 bank 15:fast:slow:x=pot(1)+bump(1)+pen(0)+xor(1,2)
40 play "cdefg":tempo 10:envelope 1,5,5,5,5,1:filter 1000,1
50 dopen#1,"x",w:print#1,"a":dclose#1:bload "spr",b0,p3584
60 if a then begin
70 print "x":bend:sleep 1:window 0,0,39,24
80 stash 100,4096,0,0:fetch 100,4096,0,0:swap 100,4096,0,0
90 x=rsppos(1,0)+rsprite(1,1)+rspcolor(1)+rwindow(2):p=pointer(a)
100 do while x<10:x=x+1:loop:print rgr(0);rclr(1);rdot(0)
110 boot "x":sprdef:sprsav 1,a$:rreg a,x,y,s:dclear:dverify "x"
120 catalog:append#1,"y":record#1,1:concat "a" to "b":width 2
`,
  simons: `10 hires 0,1:plot 10,10,1:line 0,0,319,199,1:rec 10,10,50,50,1
20 circle 160,100,50,50,1:paint 160,100,1:block 1,1,5,5,1
30 colour 0,0:print at(5,5)"hello":centre "title"
40 proc start:exec start:end proc:call start
50 repeat:x=x+1:until x>10:loop:exit if x>20:end loop
60 on error:goto 100:no error:on key "abc":goto 200
70 print mod(10,3);div(10,3);frac(1.5);exor(5,3);dup("ab",3)
80 mob set 1,13,2,0,0:mmob 1,100,100,0,0:mob off 1:low col 1,2,3:hi col
90 music 5,"a":play 1:vol 15:wave 1,32:envelope 1,0,0,15,0
100 print inkey;lin;penx;peny;pot(1):x=joy:print insert("a","b",1)
110 rem secure 0 is not tokenized here
120 disapa:secure 0:trace 1:retrace:dump:find print:option 10
`,
};

for (const [dialect, src] of Object.entries(SAMPLES)) {
  test(`round-trip tokenize -> detokenize -> tokenize (${dialect})`, () => {
    const a = tokenize(src, { dialect });
    assert.ok(a.ok, JSON.stringify(a.errors));
    const text = detokenize(a.prg, { dialect });
    const b = tokenize(text, { dialect });
    assert.ok(b.ok, JSON.stringify(b.errors));
    assert.deepEqual(b.prg, a.prg, text);
    // the text is stable as well
    assert.equal(detokenize(b.prg, { dialect }), text);
  });
}

test('detokenize output format (petcat style)', () => {
  const src = '10 print "{clr}hello":goto 10\n20 rem Abc\n';
  assert.equal(detokenize(tokenize(src).prg), src);
  assert.equal(detokenize(tokenize('10 rem  x  ').prg), '10 rem  x{$20}{$20}\n');
  assert.equal(detokenize(tokenize('10 {$20}x').prg), '10 {$20}x\n');
});

test('detokenize escapes text that would otherwise be re-tokenized', () => {
  // untokenized "print", "+" and "?" in program text ($C1 outside strings is the ATN token)
  const prg = bytes(0x01, 0x08, 0x0e, 0x08, 0x0a, 0x00, 0x50, 0x52, 0x49, 0x4e, 0x54, 0x2b, 0x3f, 0xc1, 0x00, 0x00, 0x00);
  const text = detokenize(prg);
  assert.equal(text, '10 {p}r{i}nt{+}{$3f}atn\n');
  assert.deepEqual(tokenize(text).prg, prg);
});

test('detokenize never produces text that re-tokenizes differently', () => {
  // GO + "SUB" would become GOSUB, "I" + FRE would become IF + "RE"
  const goSub = bytes(0x01, 0x08, 0x0a, 0x08, 0x0a, 0x00, 0xcb, 0x53, 0x55, 0x42, 0x00, 0x00, 0x00);
  assert.equal(detokenize(goSub), '10 {$cb}sub\n');
  const iFre = bytes(0x01, 0x08, 0x08, 0x08, 0x0a, 0x00, 0x49, 0xb8, 0x00, 0x00, 0x00);
  assert.equal(detokenize(iFre), '10 {i}fre\n');
  // deterministic fuzz over random token/char soup
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const pool = [0x20, 0x22, 0x3a, 0x8f, 0x83, 0xfe, 0xce, 0x64, 0x99, 0xcb, 0xa4];
  for (const dialect of PRG_DIALECTS) {
    for (let n = 0; n < 500; n++) {
      const len = 1 + rnd(50);
      const b = [];
      for (let i = 0; i < len; i++) {
        const r = rnd(10);
        b.push(r < 3 ? pool[rnd(pool.length)] : r < 6 ? 0x41 + rnd(26) : 1 + rnd(255));
      }
      const next = 0x0801 + len + 5;
      const prg = bytes(0x01, 0x08, next & 0xff, next >> 8, 0x0a, 0x00, b, 0x00, 0x00, 0x00);
      const text = detokenize(prg, { dialect });
      const r = tokenize(text, { dialect, start: 0x0801 });
      assert.ok(r.ok, `${dialect}: ${text} ${JSON.stringify(r.errors)}`);
      assert.deepEqual(r.prg, prg, `${dialect}: ${text}`);
    }
  }
});

test('detokenize: unknown tokens become {$xx}, stops at end marker', () => {
  const prg = bytes(0x01, 0x08, 0x07, 0x08, 0x0a, 0x00, 0xcc, 0x00, 0x00, 0x00, 0xea, 0xea);
  assert.equal(detokenize(prg), '10 {$cc}\n');
  assert.deepEqual(tokenize(detokenize(prg)).prg, prg.subarray(0, 10));
  assert.equal(detokenize(bytes(0x01, 0x08, 0x00, 0x00)), '');
  // simons placeholder token ">>" ($64 $22) is kept byte-exact
  const s = bytes(0x01, 0x08, 0x08, 0x08, 0x0a, 0x00, 0x64, 0x22, 0x00, 0x00, 0x00);
  assert.equal(detokenize(s, { dialect: 'simons' }), '10 {$64}{$22}\n');
  assert.deepEqual(tokenize(detokenize(s, { dialect: 'simons' }), { dialect: 'simons' }).prg, s);
});

test('dialect tables are well-formed', () => {
  for (const id of PRG_DIALECTS) {
    const d = DIALECTS[id];
    assert.equal(d.output, 'prg', id);
    assert.ok(d.name && d.machine && d.start && d.machines[d.machine], id);
    const seen = new Set();
    for (const kw of d.keywords) {
      assert.ok(kw.name && kw.syntax && kw.desc, `${id} ${kw.name}`);
      const key = String(kw.token);
      assert.ok(!seen.has(key), `${id}: duplicate token ${key}`);
      seen.add(key);
    }
  }
  assert.equal(DIALECTS.v2.keywords.length, 77);
  assert.equal(DIALECTS.v7.keywords.filter((k) => Array.isArray(k.token)).length, 9 + 35);
  assert.equal(DIALECTS.simons.keywords.filter((k) => Array.isArray(k.token)).length, 116); // 127 slots minus 11 unused ">>" placeholders
});
