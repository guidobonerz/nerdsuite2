// platforms.js - the machines nerdsuite makes programs for: their CPU, their BASIC, the file the
// assembler writes, where a program starts, and the emulator that runs it.
//
//   family     the group in the project wizard
//   cpu        the CPU of the assembler (!cpu); cpus: the ones offered for the machine
//   basic      the BASIC dialects of the machine (basic/dialects.js), the first is the default
//   format     the output of the assembler: cbm (a .prg with its load address), xex (an Atari binary
//              load file), amsdos (a CPC binary with its header), plain (a cartridge image: the .a26 of
//              the VCS, the .nes of the NES with its iNES header, the LoROM .sfc of the SNES; the code
//              of the BBC Micro, *RUN from a disc), zx81 (a .p file: the code in a REM line, zx81.js),
//              trs80 (a TRS-80 /CMD file)
//   start      where a new assembler program starts; basicStart: the BASIC area (a SYS line)
//   emulator   { kind: 'vice', machine } - run and debug in VICE (the binary monitor);
//              { kind: 'emu', platform }  - run in Altirra, WinAPE, Stella, Xemu … (backend/emu)
//   commodore  the graphics editors (VIC-II and SID) make data for it as it is
//   basicLine  the longest BASIC line the screen editor of the machine takes as typed in (with its line number):
//              the logical line of the screen (C64 2 x 40, VIC-20 4 x 22, C128 4 x 40 ...); a build warns
//              of longer ones (the Settings may set another, platformprefs.js)

export const FAMILIES = [
  { id: 'commodore', name: 'Commodore', desc: '6502/6510, 45GS02 · VIC-II, VIC, TED, VIC-IV · BASIC 2 to 7, BASIC 65 · run and debug in VICE, the MEGA65 in Xemu' },
  { id: 'atari', name: 'Atari', desc: '6502 · ANTIC/GTIA, TIA · Atari BASIC · run in Altirra or Stella' },
  { id: 'amstrad', name: 'Amstrad / Schneider', desc: 'Z80 · Gate Array · Locomotive BASIC · run in WinAPE' },
  { id: 'nintendo', name: 'Nintendo', desc: '6502 (2A03) and 65816 · PPU, APU · run in Mesen, FCEUX, bsnes or Snes9x' },
  { id: 'sinclair', name: 'Sinclair', desc: 'Z80 · ZX81 BASIC · .p files · run in EightyOne or ZEsarUX' },
  { id: 'tandy', name: 'Tandy / Radio Shack', desc: 'Z80 · Level II BASIC · /CMD files · run in trs80gp or MAME' },
  { id: 'acorn', name: 'Acorn', desc: '6502 · BBC BASIC · .ssd discs · run in BeebEm, b2 or MAME' },
];

export const PLATFORMS = [
  { id: 'c64', family: 'commodore', name: 'Commodore 64', short: 'C64', cpu: '6510', cpus: ['6510', '6502'], basic: ['v2', 'simons'], format: 'cbm', ext: 'prg',
    start: 0x0810, basicStart: 0x0801, screen: 0x0400, border: 0xd020, emulator: { kind: 'vice', machine: 'c64' }, commodore: true, basicLine: 80 },
  { id: 'c128', family: 'commodore', name: 'Commodore 128', short: 'C128', cpu: '6502', cpus: ['6502', '6510'], basic: ['v7'], format: 'cbm', ext: 'prg',
    start: 0x1c10, basicStart: 0x1c01, screen: 0x0400, border: 0xd020, emulator: { kind: 'vice', machine: 'c128' }, commodore: true, basicLine: 160 },
  { id: 'vic20', family: 'commodore', name: 'VIC-20', short: 'VIC-20', cpu: '6502', cpus: ['6502'], basic: ['v2'], format: 'cbm', ext: 'prg',
    start: 0x1010, basicStart: 0x1001, screen: 0x1e00, border: 0x900f, emulator: { kind: 'vice', machine: 'vic20' }, commodore: true, basicLine: 88 },
  { id: 'plus4', family: 'commodore', name: 'Plus/4', short: 'Plus/4', cpu: '6502', cpus: ['6502'], basic: ['v35'], format: 'cbm', ext: 'prg',
    start: 0x1010, basicStart: 0x1001, screen: 0x0c00, border: 0xff19, emulator: { kind: 'vice', machine: 'plus4' }, commodore: true, basicLine: 88 },
  { id: 'c16', family: 'commodore', name: 'Commodore 16', short: 'C16', cpu: '6502', cpus: ['6502'], basic: ['v35'], format: 'cbm', ext: 'prg',
    start: 0x1010, basicStart: 0x1001, screen: 0x0c00, border: 0xff19, emulator: { kind: 'vice', machine: 'plus4', args: ['-model', 'c16'] }, commodore: true, basicLine: 88 },
  { id: 'pet', family: 'commodore', name: 'PET / CBM 4032', short: 'PET', cpu: '6502', cpus: ['6502'], basic: ['v4', 'v2'], format: 'cbm', ext: 'prg',
    start: 0x0410, basicStart: 0x0401, screen: 0x8000, border: null, emulator: { kind: 'vice', machine: 'pet' }, commodore: true, basicLine: 80 },
  { id: 'mega65', family: 'commodore', name: 'MEGA65', short: 'MEGA65', cpu: 'm65', cpus: ['m65', '4502', '65ce02', '6502'], basic: ['v65'], format: 'cbm', ext: 'prg',
    start: 0x2010, basicStart: 0x2001, screen: 0x0800, border: 0xd020, emulator: { kind: 'emu', platform: 'mega65' }, commodore: true, basicLine: 160 },
  { id: 'atari8', family: 'atari', name: 'Atari 800 XL / 130 XE', short: 'Atari XL', cpu: '6502', cpus: ['6502'], basic: ['atari', 'turbo'], format: 'xex', ext: 'xex',
    start: 0x2000, basicStart: null, screen: null, border: 0xd01a, emulator: { kind: 'emu', platform: 'atari' }, basicLine: 120 },
  { id: 'vcs', family: 'atari', name: 'Atari 2600 (VCS)', short: 'VCS', cpu: '6502', cpus: ['6502'], basic: [], format: 'plain', ext: 'a26',
    start: 0xf000, basicStart: null, screen: null, border: null, emulator: { kind: 'emu', platform: 'vcs' } },
  { id: 'cpc464', family: 'amstrad', name: 'Amstrad / Schneider CPC 464', short: 'CPC 464', cpu: 'z80', cpus: ['z80'], basic: ['loco'], format: 'amsdos', ext: 'bin',
    start: 0x4000, basicStart: null, screen: 0xc000, border: null, emulator: { kind: 'emu', platform: 'cpc', model: '464' }, basicLine: 255 },
  { id: 'cpc6128', family: 'amstrad', name: 'Amstrad / Schneider CPC 6128', short: 'CPC 6128', cpu: 'z80', cpus: ['z80'], basic: ['loco'], format: 'amsdos', ext: 'bin',
    start: 0x4000, basicStart: null, screen: 0xc000, border: null, emulator: { kind: 'emu', platform: 'cpc', model: '6128' }, basicLine: 255 },
  { id: 'nes', family: 'nintendo', name: 'Nintendo Entertainment System (NES)', short: 'NES', cpu: '6502', cpus: ['6502'], basic: [], format: 'plain', ext: 'nes',
    start: 0xc000, basicStart: null, screen: null, border: null, emulator: { kind: 'emu', platform: 'nes' } },
  { id: 'snes', family: 'nintendo', name: 'Super Nintendo (SNES)', short: 'SNES', cpu: '65816', cpus: ['65816'], basic: [], format: 'plain', ext: 'sfc',
    start: 0x8000, basicStart: null, screen: null, border: null, emulator: { kind: 'emu', platform: 'snes' } },
  { id: 'zx81', family: 'sinclair', name: 'Sinclair ZX81 (16K)', short: 'ZX81', cpu: 'z80', cpus: ['z80'], basic: ['zx81'], format: 'zx81', ext: 'p',
    start: 0x4082, basicStart: null, screen: null, border: null, emulator: { kind: 'emu', platform: 'zx81' }, basicLine: 0 },
  { id: 'trs80', family: 'tandy', name: 'TRS-80 Model I (Level II, 48K)', short: 'TRS-80', cpu: 'z80', cpus: ['z80'], basic: ['trs80'], format: 'trs80', ext: 'cmd',
    start: 0x7000, basicStart: null, screen: 0x3c00, border: null, emulator: { kind: 'emu', platform: 'trs80', model: '1' }, basicLine: 240 },
  { id: 'trs80m3', family: 'tandy', name: 'TRS-80 Model III (48K)', short: 'TRS-80 M3', cpu: 'z80', cpus: ['z80'], basic: ['trs80'], format: 'trs80', ext: 'cmd',
    start: 0x7000, basicStart: null, screen: 0x3c00, border: null, emulator: { kind: 'emu', platform: 'trs80', model: '3' }, basicLine: 240 },
  { id: 'bbcb', family: 'acorn', name: 'BBC Micro Model B', short: 'BBC B', cpu: '6502', cpus: ['6502'], basic: ['bbc'], format: 'plain', ext: 'bin',
    start: 0x2000, basicStart: null, screen: 0x7c00, border: null, emulator: { kind: 'emu', platform: 'bbc', model: 'bbcb' }, basicLine: 238 },
];

export const platformOf = id => PLATFORMS.find(p => p.id === id) ?? PLATFORMS[0];
export const canDebug = p => p.emulator.kind === 'vice';
// the name of a CPU as the machine's papers write it (m65 is ACME's name of the MEGA65's 45GS02)
export const cpuName = cpu => ({ m65: '45GS02' }[cpu] ?? cpu.toUpperCase());

const hex = n => '$' + n.toString(16).padStart(4, '0');

// the first assembler program of a new project: something that shows it runs
export function starterAsm(p, name = 'main') {
  const head = `; ${name}.asm - a program for the ${p.name}, assembled with the ACME compatible assembler of nerdsuite
; Build: Ctrl+B · Run: F5${canDebug(p) ? ' · Debug: F6 (click a line number for a breakpoint)' : ''}
!cpu ${p.cpu}
!to "${name}.${p.ext}", ${p.format}
`;
  if (p.family === 'commodore') {
    const sys = p.start, next = p.basicStart + 0x0a;
    return `${head}
*= ${hex(p.basicStart)}
        ; 10 SYS ${sys}
        !word ${hex(next)}                      ; the next BASIC line
        !word 10                                ; line number 10
        !byte $9e                               ; SYS
        !text "${sys}"
        !byte 0
        !word 0                                 ; the end of the program

*= ${hex(p.start)}
start:
${p.border ? `        lda #0
        sta ${hex(p.border)}                       ; the border
loop:
        inc ${hex(p.border)}
        jmp loop
` : `        ldx #0
loop:   txa
        sta ${hex(p.screen)},x                     ; the characters on the screen
        inx
        jmp loop
`}`;
  }
  if (p.id === 'atari8') {
    return `${head}
COLBK = $d01a                           ; the background color (GTIA)

*= ${hex(p.start)}
start:
        lda #0
loop:   sta COLBK                       ; a color a scan line
        clc
        adc #2
        jmp loop

!run start                              ; the RUNAD segment: DOS starts the program here
`;
  }
  if (p.id === 'vcs') {
    return `${head}
VSYNC = $00
VBLANK = $01
WSYNC = $02
COLUBK = $09

*= $f000
start:
        sei
        cld
        ldx #$ff
        txs
        lda #0
-       sta 0,x                         ; clear the TIA and the RAM
        dex
        bne -
frame:
        lda #2
        sta VSYNC                       ; three lines of vertical sync
        sta WSYNC
        sta WSYNC
        sta WSYNC
        lda #0
        sta VSYNC
        ldx #37
-       sta WSYNC                       ; the vertical blank
        dex
        bne -
        stx VBLANK
        ldx #192
-       stx COLUBK                      ; a color a scan line
        sta WSYNC
        dex
        bne -
        lda #2
        sta VBLANK
        ldx #30
-       sta WSYNC                       ; the overscan
        dex
        bne -
        jmp frame

*= $fffc
        !word start                     ; the reset vector
        !word start
`;
  }
  if (p.id === 'nes') {
    return `${head}
PPUCTRL   = $2000
PPUMASK   = $2001
PPUSTATUS = $2002
PPUSCROLL = $2005
PPUADDR   = $2006
PPUDATA   = $2007
DMC_FREQ  = $4010
JOY2      = $4017                       ; written: the frame counter of the APU
ticks     = $00                         ; a frame counter in the zero page

*= $0000
        ; the iNES header: 16 bytes before the cartridge
        !text "NES", $1a
        !byte 1                         ; 1 x 16K PRG ROM
        !byte 1                         ; 1 x 8K CHR ROM
        !byte %00000001                 ; mapper 0 (NROM), vertical mirroring
        !byte 0, 0, 0, 0, 0, 0, 0, 0, 0

!pseudopc ${hex(p.start)} {
reset:
        sei
        cld
        ldx #$40
        stx JOY2                        ; no frame IRQ
        ldx #$ff
        txs
        inx
        stx PPUCTRL                     ; no NMI
        stx PPUMASK                     ; rendering off
        stx DMC_FREQ                    ; no DMC IRQ
        stx ticks
        bit PPUSTATUS
-       bit PPUSTATUS                   ; two vertical blanks: the PPU is ready
        bpl -
-       bit PPUSTATUS
        bpl -
frame:
-       bit PPUSTATUS                   ; wait for the vertical blank
        bpl -
        inc ticks
        lda ticks
        and #7
        bne frame                       ; a new color every 8 frames
        lda #$3f
        sta PPUADDR
        lda #$00
        sta PPUADDR                     ; the palette at $3f00: the backdrop color
        inx
        txa
        and #$3f
        sta PPUDATA
        lda #0
        sta PPUSCROLL
        sta PPUSCROLL
        lda #%00001010
        sta PPUMASK                     ; the background on
        jmp frame

nmi:
irq:    rti

        !fill $fffa - *, $ff
        !word nmi, reset, irq           ; the vectors
}
        ; the CHR ROM: 8K of tiles, all empty - the backdrop shows
        !fill $2000, 0
`;
  }
  if (p.id === 'snes') {
    return `${head}
INIDISP  = $2100
CGADD    = $2121
CGDATA   = $2122
TM       = $212c
NMITIMEN = $4200
HVBJOY   = $4212

*= ${hex(p.start)}
reset:
        sei
        clc
        xce                             ; native mode
        rep #$38                        ; 16 bit A, X and Y, binary arithmetic
        !al
        !rl
        ldx #$1fff
        txs                             ; the stack at the top of the low RAM
        lda #$0000
        tcd                             ; the direct page at $0000
        sep #$20                        ; 8 bit A
        !as
        lda #$80
        sta INIDISP                     ; forced blank
        stz NMITIMEN                    ; no NMI, no IRQ
        stz TM                          ; no layers: the backdrop color shows
        lda #$0f
        sta INIDISP                     ; screen on, full brightness
        ldx #0                          ; the color, BGR555 (X is 16 bits)
frame:
-       lda HVBJOY
        bpl -                           ; wait for the vertical blank
        stz CGADD                       ; color 0: the backdrop
        rep #$20
        !al
        txa
        sep #$20
        !as
        sta CGDATA                      ; the low byte
        xba
        sta CGDATA                      ; the high byte
        inx
        inx
-       lda HVBJOY
        bmi -                           ; wait for the end of the vertical blank
        bra frame

nmi:
irq:    rti

        !fill $ffc0 - *, 0
        ; the header of the cartridge
        !text "NERDSUITE DEMO       "   ; the title, 21 characters
        !byte $20                       ; LoROM, slow ROM
        !byte $00                       ; ROM only
        !byte $05                       ; 2^5 = 32K of ROM
        !byte $00                       ; no RAM
        !byte $01                       ; North America
        !byte $00                       ; developer
        !byte $00                       ; version
        !word $ffff, $0000              ; checksum complement and checksum (not computed)
        ; the vectors in native mode: -, -, COP, BRK, ABORT, NMI, -, IRQ
        !word 0, 0, irq, irq, irq, nmi, 0, irq
        ; in emulation mode: -, -, COP, -, ABORT, NMI, RESET, IRQ / BRK
        !word 0, 0, irq, 0, irq, nmi, reset, irq
`;
  }
  if (p.id === 'zx81') {
    return `${head}
; the code is in the line 1 REM of the .p file, 2 RAND USR ${p.start} starts it
PRINT_A = $10                           ; RST $10: print the character in A (the ZX81 character set)

*= ${hex(p.start)}
start:
        ld b, 64
        xor a
loop:   push af
        push bc
        rst PRINT_A                     ; the 64 characters of the ZX81
        pop bc
        pop af
        inc a
        djnz loop
        ret                             ; back to BASIC

!run start
`;
  }
  if (p.family === 'tandy') {
    return `${head}
SCREEN = ${hex(p.screen)}                       ; the screen: 16 lines of 64 characters

*= ${hex(p.start)}
start:
        ld hl, SCREEN
        ld de, SCREEN + 1
        ld bc, 1023
        ld (hl), ' '
        ldir                            ; clear the screen
        ld hl, text
        ld de, SCREEN + 7 * 64 + 21
copy:   ld a, (hl)
        or a
        jr z, done
        ld (de), a
        inc hl
        inc de
        jr copy
done:   jr done

text:   !text "HELLO FROM NERDSUITE!", 0

!run start                              ; the entry of the /CMD file
`;
  }
  if (p.family === 'acorn') {
    return `${head}
; *RUN from the disc the build makes (!BOOT runs it)
OSWRCH = $ffee                          ; the MOS: print the character in A
OSNEWL = $ffe7                          ; a new line

*= ${hex(p.start)}
start:
        ldx #0
loop:   lda text,x
        beq done
        jsr OSWRCH
        inx
        bne loop
done:   jsr OSNEWL
        rts                             ; back to BASIC

text:   !text "Hello from nerdsuite!", 0

!run start
`;
  }
  // the CPC: CALL &4000 from BASIC, or RUN"MAIN with the exec address of the header
  return `${head}
TXT_OUTPUT = $bb5a                      ; the firmware: print the character in A
SCR_SET_BORDER = $bc38                  ; the border colors in B and C

*= ${hex(p.start)}
start:
        ld hl, text
print:  ld a, (hl)
        or a
        jr z, border
        call TXT_OUTPUT
        inc hl
        jr print
border: ld b, 0
loop:   ld c, b
        push bc
        call SCR_SET_BORDER
        pop bc
        inc b
        ld a, b
        and 31
        ld b, a
        jr loop

text:   !text "Hello from nerdsuite!", 13, 10, 0

!run start
`;
}

// the first BASIC program of a new project in a dialect
export function starterBasic(p, dialect) {
  switch (dialect) {
    case 'atari': case 'turbo': return '10 REM NERDSUITE DEMO IN ATARI BASIC\n20 GRAPHICS 0\n30 PRINT "HELLO FROM NERDSUITE!"\n40 FOR I=0 TO 255:SETCOLOR 2,I/16,I-INT(I/16)*16:NEXT I\n50 GOTO 40\n';
    case 'zx81': return '10 REM NERDSUITE DEMO IN ZX81 BASIC\n20 PRINT "HELLO FROM NERDSUITE"\n30 FOR I=0 TO 63\n40 PLOT I,21+20*SIN (I/10)\n50 NEXT I\n';
    case 'trs80': return '10 REM NERDSUITE DEMO IN LEVEL II BASIC\n20 CLS\n30 PRINT @ 448, "HELLO FROM NERDSUITE!"\n40 FOR X=0 TO 127:SET(X,30+10*SIN(X/10)):NEXT\n50 GOTO 50\n';
    case 'bbc': return '10 REM nerdsuite demo in BBC BASIC\n20 MODE 2\n30 PRINT "Hello from nerdsuite!"\n40 FOR C%=1 TO 7:GCOL 0,C%:MOVE 640,512:DRAW 640+400*COS(C%*PI/4),512+400*SIN(C%*PI/4):NEXT\n50 END\n';
    case 'loco': return '10 REM nerdsuite demo in Locomotive BASIC\n20 MODE 1\n30 PRINT "Hello from nerdsuite!"\n40 FOR i=0 TO 26:BORDER i:FOR d=1 TO 50:NEXT:NEXT\n50 GOTO 40\n';
    case 'v65': return '10 rem nerdsuite demo in basic 65\n20 background 0:border 0:print "{clr}hello from nerdsuite!"\n30 play "o4 qcdefgab"\n40 for i=0 to 15:border i:for d=1 to 2000:next:next\n50 goto 40\n';
    case 'v7': return '10 rem nerdsuite demo in basic 7.0\n20 color 0,1:color 4,1\n30 print "{clr}hello from nerdsuite!"\n40 for i=1 to 16:color 4,i:sleep 1:next\n50 goto 40\n';
    case 'v35': return '10 rem nerdsuite demo in basic 3.5\n20 print "{clr}hello from nerdsuite!"\n30 for i=1 to 16:color 4,i,3:for d=1 to 200:next:next\n40 goto 30\n';
    case 'v4': return '10 rem nerdsuite demo in basic 4.0\n20 print "{clr}hello from nerdsuite!"\n30 goto 30\n';
    default: return `10 rem nerdsuite demo in basic v2\n20 print "{clr}hello from nerdsuite!"\n${p.border ? `30 for i=0 to 15:poke ${p.border},i:for d=1 to 100:next:next\n40 goto 30\n` : '30 goto 30\n'}`;
  }
}

// the first KickAssembler program of a Commodore machine (KickAssembler writes .prg files)
export function starterKick(p, name = 'main') {
  const basic = { c64: '', c128: '.const BASIC = $1c01\n', vic20: '.const BASIC = $1001\n', plus4: '.const BASIC = $1001\n', c16: '.const BASIC = $1001\n', pet: '.const BASIC = $0401\n', mega65: '.const BASIC = $2001\n' }[p.id] ?? '';
  const upstart = p.id === 'c64' ? 'BasicUpstart2(start)              // 10 SYS start, at $0801' : `*= BASIC "Basic"\n:BasicUpstart(start)               // 10 SYS start`;
  return `// ${name}.asm - a program for the ${p.name}, assembled with KickAssembler
// Build: Ctrl+B · Run: F5 · Debug: F6 (click a line number for a breakpoint)
${basic}${upstart}

*= ${hex(p.start)} "Main"
start:
${p.border ? `        lda #0
        sta ${hex(p.border)}                  // the border
!loop:
        inc ${hex(p.border)}
        jmp !loop-
` : `        ldx #0
!loop:  txa
        sta ${hex(p.screen)},x                // the characters on the screen
        inx
        jmp !loop-
`}`;
}
