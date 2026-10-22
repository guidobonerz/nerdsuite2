// memmap.js - the addresses of the machines: the registers of their graphics, sound and I/O chips,
// the routines of their ROMs, their vectors and the areas of RAM that matter (the screen, the color
// RAM). The Disassembler names the operands by them, the Hex view the address at the cursor, and a
// new project gets them as an include file (hardware.inc).
//
// An entry: [address, name, description, size = 1, name when read]. A register that is another one
// when it is read (the TIA, GTIA, POKEY) has a name of its own for that; size > 1 is an area that
// is named with an offset (SCREEN_RAM+40). 'port' entries are Z80 I/O ports: in the include file only.

// --- the chips and ROMs, by group ------------------------------------------------------------------

const range = (base, names, chip, extra = {}) => names.map((n, k) => n && [base + k, n, `${chip}: ${extra[n] ?? n.toLowerCase().replace(/_/g, ' ')}`]).filter(Boolean);

const VIC2 = [
  ...[0, 1, 2, 3, 4, 5, 6, 7].flatMap(k => [[0xd000 + k * 2, `VIC_SPR${k}_X`, `VIC-II: sprite ${k} x position`], [0xd001 + k * 2, `VIC_SPR${k}_Y`, `VIC-II: sprite ${k} y position`]]),
  [0xd010, 'VIC_SPR_HI_X', 'VIC-II: bit 8 of the sprite x positions'],
  [0xd011, 'VIC_CTRL1', 'VIC-II: control 1 - y scroll, 25 rows, screen on, bitmap, ECM, raster bit 8'],
  [0xd012, 'VIC_RASTER', 'VIC-II: raster line (read) / raster IRQ line (write)'],
  [0xd013, 'VIC_LPEN_X', 'VIC-II: light pen x'], [0xd014, 'VIC_LPEN_Y', 'VIC-II: light pen y'],
  [0xd015, 'VIC_SPR_ENA', 'VIC-II: sprites on'],
  [0xd016, 'VIC_CTRL2', 'VIC-II: control 2 - x scroll, 40 columns, multicolor'],
  [0xd017, 'VIC_SPR_EXP_Y', 'VIC-II: sprites double height'],
  [0xd018, 'VIC_MEMORY', 'VIC-II: screen and charset / bitmap address'],
  [0xd019, 'VIC_IRQ', 'VIC-II: interrupt flags'], [0xd01a, 'VIC_IRQ_MASK', 'VIC-II: interrupts on'],
  [0xd01b, 'VIC_SPR_PRIO', 'VIC-II: sprites behind the background'],
  [0xd01c, 'VIC_SPR_MCOLOR', 'VIC-II: multicolor sprites'],
  [0xd01d, 'VIC_SPR_EXP_X', 'VIC-II: sprites double width'],
  [0xd01e, 'VIC_SPR_COLL', 'VIC-II: sprite-sprite collisions'], [0xd01f, 'VIC_SPR_BG_COLL', 'VIC-II: sprite-background collisions'],
  [0xd020, 'VIC_BORDER', 'VIC-II: border color'],
  [0xd021, 'VIC_BG_COLOR0', 'VIC-II: background color'], [0xd022, 'VIC_BG_COLOR1', 'VIC-II: background color 1 (multicolor, ECM)'],
  [0xd023, 'VIC_BG_COLOR2', 'VIC-II: background color 2 (multicolor, ECM)'], [0xd024, 'VIC_BG_COLOR3', 'VIC-II: background color 3 (ECM)'],
  [0xd025, 'VIC_SPR_MCOLOR0', 'VIC-II: sprite multicolor 0'], [0xd026, 'VIC_SPR_MCOLOR1', 'VIC-II: sprite multicolor 1'],
  ...[0, 1, 2, 3, 4, 5, 6, 7].map(k => [0xd027 + k, `VIC_SPR${k}_COLOR`, `VIC-II: sprite ${k} color`]),
];

const SID = [
  ...[1, 2, 3].flatMap(v => {
    const b = 0xd400 + (v - 1) * 7;
    return [[b, `SID_V${v}_FREQ_LO`, `SID: voice ${v} frequency low`], [b + 1, `SID_V${v}_FREQ_HI`, `SID: voice ${v} frequency high`],
      [b + 2, `SID_V${v}_PW_LO`, `SID: voice ${v} pulse width low`], [b + 3, `SID_V${v}_PW_HI`, `SID: voice ${v} pulse width high`],
      [b + 4, `SID_V${v}_CTRL`, `SID: voice ${v} control - waveform, gate, sync, ring`], [b + 5, `SID_V${v}_AD`, `SID: voice ${v} attack / decay`],
      [b + 6, `SID_V${v}_SR`, `SID: voice ${v} sustain / release`]];
  }),
  [0xd415, 'SID_FC_LO', 'SID: filter cutoff low'], [0xd416, 'SID_FC_HI', 'SID: filter cutoff high'],
  [0xd417, 'SID_RES_FILT', 'SID: filter resonance and routing'], [0xd418, 'SID_VOLUME', 'SID: volume and filter mode'],
  [0xd419, 'SID_POT_X', 'SID: paddle x'], [0xd41a, 'SID_POT_Y', 'SID: paddle y'],
  [0xd41b, 'SID_OSC3', 'SID: voice 3 oscillator (random numbers)'], [0xd41c, 'SID_ENV3', 'SID: voice 3 envelope'],
];

const CIA_REGS = ['PRA', 'PRB', 'DDRA', 'DDRB', 'TA_LO', 'TA_HI', 'TB_LO', 'TB_HI', 'TOD_10TH', 'TOD_SEC', 'TOD_MIN', 'TOD_HR', 'SDR', 'ICR', 'CRA', 'CRB'];
const CIA_DESC = { PRA: 'port A', PRB: 'port B', DDRA: 'data direction A', DDRB: 'data direction B', TA_LO: 'timer A low', TA_HI: 'timer A high', TB_LO: 'timer B low', TB_HI: 'timer B high',
  TOD_10TH: 'time of day 1/10 s', TOD_SEC: 'time of day seconds', TOD_MIN: 'time of day minutes', TOD_HR: 'time of day hours', SDR: 'serial data', ICR: 'interrupt control', CRA: 'control timer A', CRB: 'control timer B' };
const cia = (base, n, what) => CIA_REGS.map((r, k) => [base + k, `CIA${n}_${r}`, `CIA ${n}: ${CIA_DESC[r]}${k === 0 || k === 1 ? ` - ${what[k]}` : ''}`]);

const VIA_REGS = ['PRB', 'PRA', 'DDRB', 'DDRA', 'T1C_LO', 'T1C_HI', 'T1L_LO', 'T1L_HI', 'T2C_LO', 'T2C_HI', 'SR', 'ACR', 'PCR', 'IFR', 'IER', 'PRA_NH'];
const VIA_DESC = { PRB: 'port B', PRA: 'port A', DDRB: 'data direction B', DDRA: 'data direction A', T1C_LO: 'timer 1 counter low', T1C_HI: 'timer 1 counter high', T1L_LO: 'timer 1 latch low', T1L_HI: 'timer 1 latch high',
  T2C_LO: 'timer 2 low', T2C_HI: 'timer 2 high', SR: 'shift register', ACR: 'auxiliary control', PCR: 'peripheral control', IFR: 'interrupt flags', IER: 'interrupts on', PRA_NH: 'port A without handshake' };
const via = (base, name) => VIA_REGS.map((r, k) => [base + k, `${name}_${r}`, `${name.replace('_', ' ')}: ${VIA_DESC[r]}`]);

// the KERNAL jump table of the Commodore machines (from $ff81 on the C64, C128, Plus/4)
const KERNAL_JUMPS = [
  [0xff81, 'CINT', 'init the screen editor and VIC'], [0xff84, 'IOINIT', 'init the I/O'], [0xff87, 'RAMTAS', 'test and clear the RAM'],
  [0xff8a, 'RESTOR', 'restore the I/O vectors'], [0xff8d, 'VECTOR', 'read / set the I/O vectors'], [0xff90, 'SETMSG', 'KERNAL messages on / off'],
  [0xff93, 'SECOND', 'secondary address after LISTEN'], [0xff96, 'TKSA', 'secondary address after TALK'], [0xff99, 'MEMTOP', 'read / set the top of RAM'],
  [0xff9c, 'MEMBOT', 'read / set the bottom of RAM'], [0xff9f, 'SCNKEY', 'scan the keyboard'], [0xffa2, 'SETTMO', 'IEEE timeout'],
  [0xffa5, 'ACPTR', 'read a byte from the serial bus'], [0xffa8, 'CIOUT', 'write a byte to the serial bus'], [0xffab, 'UNTLK', 'UNTALK'],
  [0xffae, 'UNLSN', 'UNLISTEN'], [0xffb1, 'LISTEN', 'LISTEN a device'], [0xffb4, 'TALK', 'TALK a device'], [0xffb7, 'READST', 'read the I/O status'],
  [0xffba, 'SETLFS', 'set file, device, secondary address'], [0xffbd, 'SETNAM', 'set the file name'], [0xffc0, 'OPEN', 'open a file'],
  [0xffc3, 'CLOSE', 'close a file'], [0xffc6, 'CHKIN', 'input from a file'], [0xffc9, 'CHKOUT', 'output to a file'], [0xffcc, 'CLRCHN', 'default input and output'],
  [0xffcf, 'CHRIN', 'read a character'], [0xffd2, 'CHROUT', 'write the character in A'], [0xffd5, 'LOAD', 'load or verify'], [0xffd8, 'SAVE', 'save'],
  [0xffdb, 'SETTIM', 'set the clock'], [0xffde, 'RDTIM', 'read the clock'], [0xffe1, 'STOP', 'check the STOP key'], [0xffe4, 'GETIN', 'get a character from the keyboard buffer'],
  [0xffe7, 'CLALL', 'close all files'], [0xffea, 'UDTIM', 'tick the clock'], [0xffed, 'SCREEN', 'the size of the screen'], [0xfff0, 'PLOT', 'read / set the cursor'],
  [0xfff3, 'IOBASE', 'the address of the I/O'],
].map(([a, n, d]) => [a, n, `KERNAL: ${d}`]);

const VECTORS_6502 = [[0xfffa, 'NMI_VECTOR', 'CPU: NMI vector', 2], [0xfffc, 'RESET_VECTOR', 'CPU: reset vector', 2], [0xfffe, 'IRQ_VECTOR', 'CPU: IRQ / BRK vector', 2]];

const CBM_RAM_VECTORS = [
  [0x0314, 'CINV', 'RAM vector: IRQ', 2], [0x0316, 'CBINV', 'RAM vector: BRK', 2], [0x0318, 'NMINV', 'RAM vector: NMI', 2],
  [0x031a, 'IOPEN', 'RAM vector: OPEN', 2], [0x031c, 'ICLOSE', 'RAM vector: CLOSE', 2], [0x031e, 'ICHKIN', 'RAM vector: CHKIN', 2],
  [0x0320, 'ICKOUT', 'RAM vector: CHKOUT', 2], [0x0322, 'ICLRCH', 'RAM vector: CLRCHN', 2], [0x0324, 'IBASIN', 'RAM vector: CHRIN', 2],
  [0x0326, 'IBSOUT', 'RAM vector: CHROUT', 2], [0x0328, 'ISTOP', 'RAM vector: STOP', 2], [0x032a, 'IGETIN', 'RAM vector: GETIN', 2],
  [0x032c, 'ICLALL', 'RAM vector: CLALL', 2], [0x0330, 'ILOAD', 'RAM vector: LOAD', 2], [0x0332, 'ISAVE', 'RAM vector: SAVE', 2],
];

const C64 = [
  [0x00, 'CPU_DDR', '6510: data direction of the port'], [0x01, 'CPU_PORT', '6510: memory configuration and tape'],
  [0x90, 'STATUS', 'KERNAL: I/O status'], [0xa0, 'JIFFIES', 'KERNAL: the clock, 1/60 s', 3], [0xc5, 'LSTX', 'KERNAL: the last key pressed'],
  [0xc6, 'NDX', 'KERNAL: characters in the keyboard buffer'], [0xcb, 'SFDX', 'KERNAL: the key pressed now'], [0xcc, 'BLNSW', 'KERNAL: cursor blink off'],
  [0xd1, 'PNT', 'KERNAL: the address of the cursor line', 2], [0xd3, 'PNTR', 'KERNAL: the cursor column'], [0xd6, 'TBLX', 'KERNAL: the cursor row'],
  [0x0277, 'KEYD', 'KERNAL: keyboard buffer', 10], [0x0286, 'COLOR', 'KERNAL: the current text color'], [0x0288, 'HIBASE', 'KERNAL: the high byte of the screen'],
  [0x028d, 'SHFLAG', 'KERNAL: shift, C=, CTRL pressed'], [0x0291, 'MODE', 'KERNAL: shift + C= switches the charset'],
  ...CBM_RAM_VECTORS,
  [0x0400, 'SCREEN_RAM', 'the screen (default)', 1000], [0x07f8, 'SPRITE_PTRS', 'the sprite pointers of the default screen', 8],
  [0x0801, 'BASIC_START', 'the start of a BASIC program'],
  [0xa000, 'BASIC_ROM', 'BASIC ROM', 0x2000], [0xa000, 'BASIC_COLD', 'BASIC: cold start vector'],
  ...VIC2, ...SID,
  [0xd800, 'COLOR_RAM', 'the color RAM', 1000],
  ...cia(0xdc00, 1, ['keyboard columns, joystick 2', 'keyboard rows, joystick 1']),
  ...cia(0xdd00, 2, ['VIC bank, serial bus', 'user port']),
  [0xde00, 'IO1', 'I/O 1: cartridges', 256], [0xdf00, 'IO2', 'I/O 2: cartridges', 256],
  [0xea31, 'KERNAL_IRQ', 'KERNAL: the IRQ routine (keyboard, clock)'], [0xea81, 'KERNAL_IRQ_EXIT', 'KERNAL: the end of an IRQ (pulls Y, X, A, RTI)'],
  [0xe000, 'KERNAL_ROM', 'KERNAL ROM', 0x1f81],
  ...KERNAL_JUMPS, ...VECTORS_6502,
];

const C128_EXTRA = [
  [0xd02f, 'VIC_KEYS', 'VIC-II (C128): the extra keyboard lines'], [0xd030, 'VIC_CLOCK', 'VIC-II (C128): 2 MHz mode'],
  ...range(0xd500, ['MMU_CR', 'MMU_PCRA', 'MMU_PCRB', 'MMU_PCRC', 'MMU_PCRD', 'MMU_MCR', 'MMU_RCR', 'MMU_P0L', 'MMU_P0H', 'MMU_P1L', 'MMU_P1H', 'MMU_VR'], 'MMU', {
    MMU_CR: 'configuration', MMU_PCRA: 'preconfiguration A', MMU_PCRB: 'preconfiguration B', MMU_PCRC: 'preconfiguration C', MMU_PCRD: 'preconfiguration D',
    MMU_MCR: 'mode configuration (C64 mode, 40/80, fast serial)', MMU_RCR: 'RAM configuration (common RAM)', MMU_P0L: 'page 0 pointer low', MMU_P0H: 'page 0 pointer high',
    MMU_P1L: 'page 1 pointer low', MMU_P1H: 'page 1 pointer high', MMU_VR: 'version' }),
  [0xd600, 'VDC_ADDR', 'VDC: register select / status'], [0xd601, 'VDC_DATA', 'VDC: register data'],
  [0xff00, 'MMU_LCR', 'MMU: configuration (always visible)'],
  [0x1c01, 'BASIC_START', 'the start of a BASIC program'],
  ...[[0xff47, 'SPIN_SPOUT', 'fast serial input / output'], [0xff4a, 'CLOSE_ALL', 'close all files of a device'], [0xff4d, 'C64MODE', 'switch to C64 mode'],
    [0xff50, 'DMA_CALL', 'send a command to a DMA device'], [0xff53, 'BOOT_CALL', 'boot a disk'], [0xff56, 'PHOENIX', 'init the function ROMs'],
    [0xff59, 'LKUPLA', 'find a logical file'], [0xff5c, 'LKUPSA', 'find a secondary address'], [0xff5f, 'SWAPPER', 'switch 40 / 80 columns'],
    [0xff62, 'DLCHR', 'copy the charset to the VDC'], [0xff65, 'PFKEY', 'program a function key'], [0xff68, 'SETBNK', 'set the banks of LOAD / SAVE'],
    [0xff6b, 'GETCFG', 'the MMU value of a bank'], [0xff6e, 'JSRFAR', 'JSR into a bank'], [0xff71, 'JMPFAR', 'JMP into a bank'],
    [0xff74, 'INDFET', 'LDA (ZP),Y from a bank'], [0xff77, 'INDSTA', 'STA (ZP),Y into a bank'], [0xff7a, 'INDCMP', 'CMP (ZP),Y in a bank'],
    [0xff7d, 'PRIMM', 'print the text after the JSR']].map(([a, n, d]) => [a, n, `KERNAL: ${d}`]),
];
const C128 = [...C64.filter(e => !['BASIC_START', 'BASIC_ROM', 'BASIC_COLD', 'KERNAL_ROM', 'KERNAL_IRQ', 'KERNAL_IRQ_EXIT', 'SPRITE_PTRS', 'JIFFIES'].includes(e[1])), ...C128_EXTRA];

// the MEGA65: the C64's chips where the C64 has them, the VIC-III and VIC-IV (unlocked by writing $47, $53
// to VIC_KEY), four SIDs, the DMA controller, the math unit and the palette; BASIC 65 at $2001, the 80
// column screen at $0800
const VIC4 = [
  [0xd02f, 'VIC_KEY', 'VIC-IV: the knock register ($a5 $96 the VIC-III, $47 $53 the VIC-IV)'],
  [0xd030, 'VIC3_CTRLA', 'VIC-III: control A - ROM banks at $8000-$e000, the palette in RAM'],
  [0xd031, 'VIC3_CTRLB', 'VIC-III: control B - 80 columns, fast CPU, attributes, bitplanes, 400 lines, interlace'],
  [0xd054, 'VIC4_CTRLC', 'VIC-IV: control C - 16 bit chars, full colour chars, the speed of the CPU'],
  [0xd058, 'VIC4_LINESTEP', 'VIC-IV: the bytes of a screen row', 2],
  [0xd05e, 'VIC4_CHRCOUNT', 'VIC-IV: the characters of a screen row'],
  [0xd060, 'VIC4_SCRNPTR', 'VIC-IV: the address of the screen (28 bits)', 4],
  [0xd064, 'VIC4_COLPTR', 'VIC-IV: the offset of the colour RAM', 2],
  [0xd068, 'VIC4_CHARPTR', 'VIC-IV: the address of the character set (24 bits)', 3],
  [0xd06c, 'VIC4_SPRPTRADR', 'VIC-IV: the address of the sprite pointers', 3],
  [0xd070, 'VIC4_PALSEL', 'VIC-IV: the palette shown, the palette written, the palette of the sprites'],
  [0xd100, 'PALETTE_RED', 'VIC-IV: the red of the 256 palette entries', 256],
  [0xd200, 'PALETTE_GREEN', 'VIC-IV: the green of the 256 palette entries', 256],
  [0xd300, 'PALETTE_BLUE', 'VIC-IV: the blue of the 256 palette entries', 256],
];
const MEGA65 = [
  [0x00, 'CPU_DDR', '45GS02: data direction of the port'], [0x01, 'CPU_PORT', '45GS02: memory configuration (the C64 mode)'],
  ...CBM_RAM_VECTORS,
  [0x0800, 'SCREEN_RAM', 'the screen of BASIC 65 (80 x 25)', 2000],
  [0x2001, 'BASIC_START', 'the start of a BASIC 65 program'],
  ...VIC2, ...VIC4, ...SID,
  [0xd420, 'SID2', 'SID 2: its 29 registers as SID 1', 32], [0xd440, 'SID3', 'SID 3: its 29 registers as SID 1', 32], [0xd460, 'SID4', 'SID 4: its 29 registers as SID 1', 32],
  [0xd640, 'HYPERVISOR_TRAPS', 'Hypervisor: the traps (a write calls the Hypervisor)', 64],
  [0xd700, 'DMA_ADDRLSB', 'DMA: the low byte of the address of a job list - writing it starts the job'],
  [0xd701, 'DMA_ADDRMSB', 'DMA: the high byte of the address of a job list'], [0xd702, 'DMA_ADDRBANK', 'DMA: the bank of a job list'],
  [0xd703, 'DMA_EN018B', 'DMA: F018B job lists (bit 0)'], [0xd704, 'DMA_ADDRMB', 'DMA: the megabyte of a job list'],
  [0xd705, 'DMA_ETRIG', 'DMA: writing it starts an enhanced job list'],
  [0xd768, 'MATH_DIVOUT', 'Math unit: the quotient of MULTINA / MULTINB', 8],
  [0xd770, 'MATH_MULTINA', 'Math unit: the first factor, the dividend', 4], [0xd774, 'MATH_MULTINB', 'Math unit: the second factor, the divisor', 4],
  [0xd778, 'MATH_MULTOUT', 'Math unit: the product', 8],
  [0xd800, 'COLOR_RAM', 'the colour RAM (2K here, all 32K at $ff80000)', 2048],
  ...cia(0xdc00, 1, ['keyboard columns, joystick 2', 'keyboard rows, joystick 1']),
  ...cia(0xdd00, 2, ['VIC bank, serial bus', 'user port']),
  ...KERNAL_JUMPS, ...VECTORS_6502,
];

const VIC20 = [
  ...range(0x9000, ['VIC_HORIZ', 'VIC_VERT', 'VIC_COLUMNS', 'VIC_ROWS', 'VIC_RASTER', 'VIC_MEMORY', 'VIC_LPEN_X', 'VIC_LPEN_Y', 'VIC_POT_X', 'VIC_POT_Y',
    'VIC_BASS', 'VIC_ALTO', 'VIC_SOPRANO', 'VIC_NOISE', 'VIC_VOLUME', 'VIC_COLOR'], 'VIC', {
    VIC_HORIZ: 'interlace and the left of the screen', VIC_VERT: 'the top of the screen', VIC_COLUMNS: 'columns and bit 9 of the screen address',
    VIC_ROWS: 'rows, 8x16 chars, raster bit 0', VIC_RASTER: 'raster line', VIC_MEMORY: 'screen and charset address', VIC_LPEN_X: 'light pen x', VIC_LPEN_Y: 'light pen y',
    VIC_POT_X: 'paddle x', VIC_POT_Y: 'paddle y', VIC_BASS: 'voice 1 (bass)', VIC_ALTO: 'voice 2 (alto)', VIC_SOPRANO: 'voice 3 (soprano)', VIC_NOISE: 'noise',
    VIC_VOLUME: 'volume and auxiliary color', VIC_COLOR: 'screen and border color, reverse' }),
  ...via(0x9110, 'VIA1'), ...via(0x9120, 'VIA2'),
  [0x1001, 'BASIC_START', 'the start of a BASIC program (unexpanded)'],
  [0x1e00, 'SCREEN_RAM', 'the screen (unexpanded)', 506], [0x9600, 'COLOR_RAM', 'the color RAM (unexpanded)', 506],
  [0x8000, 'CHAR_ROM', 'the character ROM', 0x1000], [0xc000, 'BASIC_ROM', 'BASIC ROM', 0x2000], [0xe000, 'KERNAL_ROM', 'KERNAL ROM', 0x1f8a],
  [0x90, 'STATUS', 'KERNAL: I/O status'], [0xa0, 'JIFFIES', 'KERNAL: the clock, 1/60 s', 3], [0xc5, 'LSTX', 'KERNAL: the last key pressed'], [0xc6, 'NDX', 'KERNAL: characters in the keyboard buffer'],
  [0x0277, 'KEYD', 'KERNAL: keyboard buffer', 10], [0x0286, 'COLOR', 'KERNAL: the current text color'], [0x0288, 'HIBASE', 'KERNAL: the high byte of the screen'],
  ...CBM_RAM_VECTORS,
  [0xeabf, 'KERNAL_IRQ', 'KERNAL: the IRQ routine'],
  ...KERNAL_JUMPS.filter(e => e[0] >= 0xff8a), ...VECTORS_6502,
];

const TED = [
  ...range(0xff00, ['TED_T1_LO', 'TED_T1_HI', 'TED_T2_LO', 'TED_T2_HI', 'TED_T3_LO', 'TED_T3_HI', 'TED_CTRL1', 'TED_CTRL2', 'TED_KEYBOARD', 'TED_IRQ', 'TED_IRQ_MASK',
    'TED_RASTER_CMP', 'TED_CURSOR_HI', 'TED_CURSOR_LO', 'TED_V1_FREQ_LO', 'TED_V2_FREQ_LO', 'TED_V2_FREQ_HI', 'TED_SOUND', 'TED_BITMAP', 'TED_CHARSET', 'TED_VIDEO',
    'TED_BG_COLOR0', 'TED_BG_COLOR1', 'TED_BG_COLOR2', 'TED_BG_COLOR3', 'TED_BORDER', 'TED_CHARPOS_HI', 'TED_CHARPOS_LO', 'TED_RASTER_HI', 'TED_RASTER_LO', 'TED_HPOS', 'TED_BLINK'], 'TED', {
    TED_T1_LO: 'timer 1 low', TED_T1_HI: 'timer 1 high', TED_T2_LO: 'timer 2 low', TED_T2_HI: 'timer 2 high', TED_T3_LO: 'timer 3 low', TED_T3_HI: 'timer 3 high',
    TED_CTRL1: 'control 1 - y scroll, 25 rows, screen on, bitmap, ECM', TED_CTRL2: 'control 2 - x scroll, 40 columns, multicolor, reverse off',
    TED_KEYBOARD: 'keyboard latch', TED_IRQ: 'interrupt flags', TED_IRQ_MASK: 'interrupts on, raster bit 8', TED_RASTER_CMP: 'raster IRQ line',
    TED_CURSOR_HI: 'cursor position high', TED_CURSOR_LO: 'cursor position low', TED_V1_FREQ_LO: 'voice 1 frequency low', TED_V2_FREQ_LO: 'voice 2 frequency low',
    TED_V2_FREQ_HI: 'voice 2 frequency high', TED_SOUND: 'sound - volume, voices on, noise', TED_BITMAP: 'bitmap address, voice 1 frequency high',
    TED_CHARSET: 'charset address, single clock', TED_VIDEO: 'screen and color address', TED_BG_COLOR0: 'background color', TED_BG_COLOR1: 'background color 1',
    TED_BG_COLOR2: 'background color 2', TED_BG_COLOR3: 'background color 3', TED_BORDER: 'border color', TED_CHARPOS_HI: 'character position high',
    TED_CHARPOS_LO: 'character position low', TED_RASTER_HI: 'raster line high', TED_RASTER_LO: 'raster line low', TED_HPOS: 'horizontal position', TED_BLINK: 'flash counter, vertical sub address' }),
  [0xff3e, 'ROM_ON', 'TED: the ROMs on (write)'], [0xff3f, 'RAM_ON', 'TED: all RAM (write)'],
];
const PLUS4 = [
  [0x00, 'CPU_DDR', '7501: data direction of the port'], [0x01, 'CPU_PORT', '7501: serial bus, tape'],
  [0x90, 'STATUS', 'KERNAL: I/O status'], [0xa3, 'JIFFIES', 'KERNAL: the clock', 3], [0xc5, 'LSTX', 'KERNAL: the last key pressed'], [0xef, 'NDX', 'KERNAL: characters in the keyboard buffer'],
  [0x0314, 'CINV', 'RAM vector: IRQ', 2], [0x0316, 'CBINV', 'RAM vector: BRK', 2],
  [0x0527, 'KEYD', 'KERNAL: keyboard buffer', 10], [0x053b, 'COLOR', 'KERNAL: the current text color'],
  [0x0800, 'COLOR_RAM', 'the attributes: color and luminance', 1000], [0x0c00, 'SCREEN_RAM', 'the screen', 1000],
  [0x1001, 'BASIC_START', 'the start of a BASIC program'],
  [0x8000, 'BASIC_ROM', 'BASIC ROM', 0x4000], [0xc000, 'KERNAL_ROM', 'KERNAL ROM', 0x3c00],
  [0xfd00, 'ACIA_DATA', 'ACIA: data'], [0xfd01, 'ACIA_STATUS', 'ACIA: status'], [0xfd02, 'ACIA_COMMAND', 'ACIA: command'], [0xfd03, 'ACIA_CONTROL', 'ACIA: control'],
  [0xfd10, 'USER_PORT', 'the user port (6529)'], [0xfd30, 'KEYBOARD_PORT', 'the keyboard lines (6529)'],
  ...TED, ...KERNAL_JUMPS, ...VECTORS_6502,
];

const PET = [
  [0x0090, 'CINV', 'RAM vector: IRQ', 2], [0x0092, 'CBINV', 'RAM vector: BRK', 2], [0x0094, 'NMINV', 'RAM vector: NMI', 2],
  [0x0096, 'STATUS', 'KERNAL: I/O status'], [0x009e, 'NDX', 'KERNAL: characters in the keyboard buffer'], [0x008d, 'JIFFIES', 'KERNAL: the clock', 3],
  [0x026f, 'KEYD', 'KERNAL: keyboard buffer', 10],
  [0x0401, 'BASIC_START', 'the start of a BASIC program'],
  [0x8000, 'SCREEN_RAM', 'the screen', 1000],
  [0xb000, 'BASIC_ROM', 'BASIC ROM', 0x3000], [0xf000, 'KERNAL_ROM', 'KERNAL ROM', 0x1000],
  ...range(0xe810, ['PIA1_PA', 'PIA1_CRA', 'PIA1_PB', 'PIA1_CRB'], 'PIA 1', { PIA1_PA: 'port A - keyboard row select', PIA1_CRA: 'control A', PIA1_PB: 'port B - keyboard columns', PIA1_CRB: 'control B - the vertical blank IRQ' }),
  ...range(0xe820, ['PIA2_PA', 'PIA2_CRA', 'PIA2_PB', 'PIA2_CRB'], 'PIA 2', { PIA2_PA: 'port A - IEEE-488 data in', PIA2_CRA: 'control A', PIA2_PB: 'port B - IEEE-488 data out', PIA2_CRB: 'control B' }),
  ...via(0xe840, 'VIA'),
  [0xe880, 'CRTC_ADDR', 'CRTC: register select'], [0xe881, 'CRTC_DATA', 'CRTC: register data'],
  ...KERNAL_JUMPS.filter(e => e[0] >= 0xffc0), ...VECTORS_6502,
];

const ATARI8 = [
  [0x12, 'RTCLOK', 'OS: the clock, 1/50 or 1/60 s', 3], [0x4d, 'ATRACT', 'OS: attract mode'], [0x58, 'SAVMSC', 'OS: the address of the screen', 2],
  [0x0200, 'VDSLST', 'OS: display list interrupt vector', 2], [0x0222, 'VVBLKI', 'OS: immediate vertical blank vector', 2], [0x0224, 'VVBLKD', 'OS: deferred vertical blank vector', 2],
  [0x022f, 'SDMCTL', 'OS: shadow of DMACTL'], [0x0230, 'SDLSTL', 'OS: shadow of the display list address', 2], [0x026f, 'GPRIOR', 'OS: shadow of PRIOR'],
  [0x0270, 'PADDL0', 'OS: paddles', 8], [0x0278, 'STICK0', 'OS: joystick 0'], [0x0279, 'STICK1', 'OS: joystick 1'], [0x0284, 'STRIG0', 'OS: trigger 0'], [0x0285, 'STRIG1', 'OS: trigger 1'],
  [0x02c0, 'PCOLR0', 'OS: shadow of the player colors', 4], [0x02c4, 'COLOR0', 'OS: shadow of COLPF0'], [0x02c5, 'COLOR1', 'OS: shadow of COLPF1'],
  [0x02c6, 'COLOR2', 'OS: shadow of COLPF2'], [0x02c7, 'COLOR3', 'OS: shadow of COLPF3'], [0x02c8, 'COLOR4', 'OS: shadow of COLBK'],
  [0x02e0, 'RUNAD', 'DOS: run address', 2], [0x02e2, 'INITAD', 'DOS: init address', 2], [0x02e5, 'MEMTOP', 'OS: the top of free RAM', 2], [0x02e7, 'MEMLO', 'OS: the bottom of free RAM', 2],
  [0x02f4, 'CHBAS', 'OS: shadow of CHBASE'], [0x02fc, 'CH', 'OS: the last key pressed'],
  [0x0340, 'IOCB0', 'CIO: I/O control block 0 (16 bytes per block)', 0x80], [0x0342, 'ICCOM', 'CIO: command of IOCB 0'], [0x0344, 'ICBAL', 'CIO: buffer address', 2],
  [0x0348, 'ICBLL', 'CIO: buffer length', 2], [0x034a, 'ICAX1', 'CIO: auxiliary 1'], [0x034b, 'ICAX2', 'CIO: auxiliary 2'],
  // GTIA: written - and read, under a name of its own
  ...[['HPOSP0', 'M0PF'], ['HPOSP1', 'M1PF'], ['HPOSP2', 'M2PF'], ['HPOSP3', 'M3PF'], ['HPOSM0', 'P0PF'], ['HPOSM1', 'P1PF'], ['HPOSM2', 'P2PF'], ['HPOSM3', 'P3PF'],
    ['SIZEP0', 'M0PL'], ['SIZEP1', 'M1PL'], ['SIZEP2', 'M2PL'], ['SIZEP3', 'M3PL'], ['SIZEM', 'P0PL'], ['GRAFP0', 'P1PL'], ['GRAFP1', 'P2PL'], ['GRAFP2', 'P3PL'],
    ['GRAFP3', 'TRIG0'], ['GRAFM', 'TRIG1'], ['COLPM0', 'TRIG2'], ['COLPM1', 'TRIG3'], ['COLPM2', 'PAL'], ['COLPM3', null], ['COLPF0', null], ['COLPF1', null],
    ['COLPF2', null], ['COLPF3', null], ['COLBK', null], ['PRIOR', null], ['VDELAY', null], ['GRACTL', null], ['HITCLR', null], ['CONSOL', null]]
    .map(([w, r], k) => [0xd000 + k, w, `GTIA: ${w.toLowerCase()}${r ? ` (read: ${r.toLowerCase()})` : ''}${w === 'COLBK' ? ' - the background color' : w === 'CONSOL' ? ' - the console keys, speaker' : ''}`, 1, r]),
  ...[['AUDF1', 'POT0'], ['AUDC1', 'POT1'], ['AUDF2', 'POT2'], ['AUDC2', 'POT3'], ['AUDF3', 'POT4'], ['AUDC3', 'POT5'], ['AUDF4', 'POT6'], ['AUDC4', 'POT7'],
    ['AUDCTL', 'ALLPOT'], ['STIMER', 'KBCODE'], ['SKRES', 'RANDOM'], ['POTGO', null], [null, null], ['SEROUT', 'SERIN'], ['IRQEN', 'IRQST'], ['SKCTL', 'SKSTAT']]
    .map(([w, r], k) => w && [0xd200 + k, w, `POKEY: ${w.toLowerCase()}${r ? ` (read: ${r.toLowerCase()})` : ''}${/^AUDF/.test(w) ? ' - frequency' : /^AUDC/.test(w) ? ' - distortion and volume' : ''}`, 1, r]).filter(Boolean),
  [0xd300, 'PORTA', 'PIA: port A - joysticks'], [0xd301, 'PORTB', 'PIA: port B - memory configuration (XL/XE)'], [0xd302, 'PACTL', 'PIA: control A'], [0xd303, 'PBCTL', 'PIA: control B'],
  ...range(0xd400, ['DMACTL', 'CHACTL', 'DLISTL', 'DLISTH', 'HSCROL', 'VSCROL', null, 'PMBASE', null, 'CHBASE', 'WSYNC', 'VCOUNT', 'PENH', 'PENV', 'NMIEN', 'NMIRES'], 'ANTIC', {
    DMACTL: 'DMA control - playfield width, player DMA', CHACTL: 'character control', DLISTL: 'display list low', DLISTH: 'display list high', HSCROL: 'fine scroll x',
    VSCROL: 'fine scroll y', PMBASE: 'player-missile address', CHBASE: 'charset address', WSYNC: 'wait for the end of the scan line', VCOUNT: 'scan line / 2',
    PENH: 'light pen x', PENV: 'light pen y', NMIEN: 'NMIs on - DLI, VBI', NMIRES: 'NMI reset (read: NMIST, the NMI status)' }),
  [0xa000, 'BASIC_ROM', 'BASIC ROM / cartridge', 0x2000], [0xc000, 'OS_ROM', 'OS ROM', 0x1000], [0xe000, 'CHAR_ROM', 'the character ROM', 0x400],
  [0xe456, 'CIOV', 'OS: CIO - the central I/O'], [0xe459, 'SIOV', 'OS: SIO - serial I/O'], [0xe45c, 'SETVBV', 'OS: set the VBI vectors'],
  [0xe45f, 'SYSVBV', 'OS: the system VBI routine'], [0xe462, 'XITVBV', 'OS: the end of a VBI'], [0xe474, 'WARMSV', 'OS: warm start'], [0xe477, 'COLDSV', 'OS: cold start'],
  ...VECTORS_6502,
];

const VCS = [
  ...[['VSYNC', 'CXM0P'], ['VBLANK', 'CXM1P'], ['WSYNC', 'CXP0FB'], ['RSYNC', 'CXP1FB'], ['NUSIZ0', 'CXM0FB'], ['NUSIZ1', 'CXM1FB'], ['COLUP0', 'CXBLPF'], ['COLUP1', 'CXPPMM'],
    ['COLUPF', 'INPT0'], ['COLUBK', 'INPT1'], ['CTRLPF', 'INPT2'], ['REFP0', 'INPT3'], ['REFP1', 'INPT4'], ['PF0', 'INPT5'], ['PF1', null], ['PF2', null],
    ['RESP0', null], ['RESP1', null], ['RESM0', null], ['RESM1', null], ['RESBL', null], ['AUDC0', null], ['AUDC1', null], ['AUDF0', null], ['AUDF1', null], ['AUDV0', null],
    ['AUDV1', null], ['GRP0', null], ['GRP1', null], ['ENAM0', null], ['ENAM1', null], ['ENABL', null], ['HMP0', null], ['HMP1', null], ['HMM0', null], ['HMM1', null],
    ['HMBL', null], ['VDELP0', null], ['VDELP1', null], ['VDELBL', null], ['RESMP0', null], ['RESMP1', null], ['HMOVE', null], ['HMCLR', null], ['CXCLR', null]]
    .map(([w, r], k) => [k, w, `TIA: ${w.toLowerCase()}${r ? ` (read: ${r.toLowerCase()})` : ''}${{ VSYNC: ' - vertical sync', VBLANK: ' - vertical blank', WSYNC: ' - wait for the end of the line',
      COLUBK: ' - background color', COLUPF: ' - playfield color', CTRLPF: ' - playfield control', GRP0: ' - player 0 graphics', GRP1: ' - player 1 graphics', HMOVE: ' - apply the horizontal motion' }[w] ?? ''}`, 1, r]),
  [0x80, 'RAM', 'the RAM of the RIOT', 128],
  [0x280, 'SWCHA', 'RIOT: joysticks'], [0x281, 'SWACNT', 'RIOT: data direction A'], [0x282, 'SWCHB', 'RIOT: console switches'], [0x283, 'SWBCNT', 'RIOT: data direction B'],
  [0x284, 'INTIM', 'RIOT: timer'], [0x285, 'TIMINT', 'RIOT: timer interrupt'],
  [0x294, 'TIM1T', 'RIOT: timer, 1 cycle steps'], [0x295, 'TIM8T', 'RIOT: timer, 8 cycle steps'], [0x296, 'TIM64T', 'RIOT: timer, 64 cycle steps'], [0x297, 'T1024T', 'RIOT: timer, 1024 cycle steps'],
  ...VECTORS_6502,
];

const NES = [
  [0x0000, 'RAM', 'the internal RAM', 0x800],
  [0x2000, 'PPUCTRL', 'PPU: control - NMI, sprite size, pattern tables, nametable'], [0x2001, 'PPUMASK', 'PPU: mask - show background and sprites, color emphasis'],
  [0x2002, 'PPUSTATUS', 'PPU: status - vertical blank, sprite 0 hit'], [0x2003, 'OAMADDR', 'PPU: OAM address'], [0x2004, 'OAMDATA', 'PPU: OAM data'],
  [0x2005, 'PPUSCROLL', 'PPU: scroll x, then y'], [0x2006, 'PPUADDR', 'PPU: VRAM address, high then low'], [0x2007, 'PPUDATA', 'PPU: VRAM data'],
  [0x4000, 'SQ1_VOL', 'APU: pulse 1 duty and volume'], [0x4001, 'SQ1_SWEEP', 'APU: pulse 1 sweep'], [0x4002, 'SQ1_LO', 'APU: pulse 1 period low'], [0x4003, 'SQ1_HI', 'APU: pulse 1 period high, length'],
  [0x4004, 'SQ2_VOL', 'APU: pulse 2 duty and volume'], [0x4005, 'SQ2_SWEEP', 'APU: pulse 2 sweep'], [0x4006, 'SQ2_LO', 'APU: pulse 2 period low'], [0x4007, 'SQ2_HI', 'APU: pulse 2 period high, length'],
  [0x4008, 'TRI_LINEAR', 'APU: triangle linear counter'], [0x400a, 'TRI_LO', 'APU: triangle period low'], [0x400b, 'TRI_HI', 'APU: triangle period high, length'],
  [0x400c, 'NOISE_VOL', 'APU: noise volume'], [0x400e, 'NOISE_LO', 'APU: noise mode and period'], [0x400f, 'NOISE_HI', 'APU: noise length'],
  [0x4010, 'DMC_FREQ', 'APU: DMC IRQ, loop, rate'], [0x4011, 'DMC_RAW', 'APU: DMC direct load'], [0x4012, 'DMC_START', 'APU: DMC sample address'], [0x4013, 'DMC_LEN', 'APU: DMC sample length'],
  [0x4014, 'OAMDMA', 'PPU: sprite DMA from page N'], [0x4015, 'SND_CHN', 'APU: channels on / status'],
  [0x4016, 'JOY1', 'controller 1 (write: strobe both)'], [0x4017, 'JOY2', 'controller 2 (write: APU frame counter)'],
  [0x6000, 'PRG_RAM', 'the cartridge RAM (battery)', 0x2000], [0x8000, 'PRG_ROM', 'the cartridge ROM', 0x7ffa],
  ...VECTORS_6502,
];

// the CPC: the firmware jump block, the screen, and the ports of the hardware
const CPC = [
  ...[[0xbb00, 'KM_INITIALISE'], [0xbb03, 'KM_RESET'], [0xbb06, 'KM_WAIT_CHAR', 'wait for a character'], [0xbb09, 'KM_READ_CHAR', 'read a character, if any'],
    [0xbb0c, 'KM_CHAR_RETURN'], [0xbb18, 'KM_WAIT_KEY', 'wait for a key'], [0xbb1b, 'KM_READ_KEY', 'read a key, if any'], [0xbb1e, 'KM_TEST_KEY', 'is a key pressed'],
    [0xbb24, 'KM_GET_JOYSTICK', 'read the joysticks'], [0xbb4e, 'TXT_INITIALISE'], [0xbb51, 'TXT_RESET'], [0xbb5a, 'TXT_OUTPUT', 'print the character in A'],
    [0xbb5d, 'TXT_WR_CHAR', 'write a character'], [0xbb60, 'TXT_RD_CHAR', 'read the character at the cursor'], [0xbb6c, 'TXT_CLEAR_WINDOW', 'clear the window'],
    [0xbb6f, 'TXT_SET_COLUMN', 'set the cursor column'], [0xbb72, 'TXT_SET_ROW', 'set the cursor row'], [0xbb75, 'TXT_SET_CURSOR', 'set the cursor (H column, L row)'],
    [0xbb78, 'TXT_GET_CURSOR', 'get the cursor'], [0xbb7b, 'TXT_CUR_ENABLE'], [0xbb7e, 'TXT_CUR_DISABLE'], [0xbb81, 'TXT_CUR_ON'], [0xbb84, 'TXT_CUR_OFF'],
    [0xbb90, 'TXT_SET_PEN', 'set the text pen'], [0xbb96, 'TXT_SET_PAPER', 'set the text paper'], [0xbba5, 'TXT_GET_MATRIX', 'the matrix of a character'],
    [0xbbba, 'GRA_INITIALISE'], [0xbbc0, 'GRA_MOVE_ABSOLUTE', 'move the graphics cursor'], [0xbbc3, 'GRA_MOVE_RELATIVE'], [0xbbc6, 'GRA_ASK_CURSOR'],
    [0xbbdb, 'GRA_CLEAR_WINDOW', 'clear the graphics window'], [0xbbde, 'GRA_SET_PEN', 'set the graphics pen'], [0xbbe4, 'GRA_SET_PAPER', 'set the graphics paper'],
    [0xbbea, 'GRA_PLOT_ABSOLUTE', 'plot a point'], [0xbbed, 'GRA_PLOT_RELATIVE'], [0xbbf0, 'GRA_TEST_ABSOLUTE', 'the pen of a point'],
    [0xbbf6, 'GRA_LINE_ABSOLUTE', 'draw a line'], [0xbbf9, 'GRA_LINE_RELATIVE'], [0xbbfc, 'GRA_WR_CHAR', 'write a character at the graphics cursor'],
    [0xbc00, 'SCR_INITIALISE'], [0xbc02, 'SCR_RESET'], [0xbc0e, 'SCR_SET_MODE', 'set the screen mode in A'], [0xbc11, 'SCR_GET_MODE'], [0xbc14, 'SCR_CLEAR', 'clear the screen'],
    [0xbc1a, 'SCR_CHAR_POSITION'], [0xbc1d, 'SCR_DOT_POSITION'], [0xbc26, 'SCR_NEXT_LINE'], [0xbc29, 'SCR_PREV_LINE'],
    [0xbc32, 'SCR_SET_INK', 'set an ink (A ink, B and C colors)'], [0xbc35, 'SCR_GET_INK'], [0xbc38, 'SCR_SET_BORDER', 'set the border (B and C colors)'],
    [0xbc3b, 'SCR_GET_BORDER'], [0xbc3e, 'SCR_SET_FLASHING'], [0xbc4d, 'SCR_HW_ROLL'], [0xbc50, 'SCR_SW_ROLL'],
    [0xbc77, 'CAS_IN_OPEN', 'open a file for reading'], [0xbc7a, 'CAS_IN_CLOSE'], [0xbc80, 'CAS_IN_CHAR'], [0xbc83, 'CAS_IN_DIRECT', 'read a whole file'],
    [0xbc8c, 'CAS_OUT_OPEN', 'open a file for writing'], [0xbc8f, 'CAS_OUT_CLOSE'], [0xbc95, 'CAS_OUT_CHAR'], [0xbc98, 'CAS_OUT_DIRECT', 'write a whole file'],
    [0xbc9b, 'CAS_CATALOG'], [0xbca7, 'SOUND_RESET', 'reset the sound'], [0xbcaa, 'SOUND_QUEUE', 'queue a sound'], [0xbcad, 'SOUND_CHECK'], [0xbcb6, 'SOUND_HOLD'], [0xbcb9, 'SOUND_CONTINUE'],
    [0xbcd1, 'KL_LOG_EXT', 'log an RSX'], [0xbcd4, 'KL_FIND_COMMAND', 'find an RSX'], [0xbd0d, 'KL_TIME_PLEASE', 'the time'], [0xbd10, 'KL_TIME_SET'],
    [0xbd13, 'MC_BOOT_PROGRAM'], [0xbd16, 'MC_START_PROGRAM'], [0xbd19, 'MC_WAIT_FLYBACK', 'wait for the frame flyback'], [0xbd1c, 'MC_SET_MODE'],
    [0xbd1f, 'MC_SCREEN_OFFSET'], [0xbd22, 'MC_CLEAR_INKS'], [0xbd25, 'MC_SET_INKS'], [0xbd28, 'MC_RESET_PRINTER'], [0xbd2b, 'MC_PRINT_CHAR'], [0xbd34, 'MC_SOUND_REGISTER', 'write an AY register (A register, C value)']]
    .map(([a, n, d]) => [a, n, `firmware: ${d ?? n.toLowerCase().replace(/_/g, ' ')}`]),
  [0x0038, 'RST_INTERRUPT', 'the interrupt entry (RST 7)'],
  [0xc000, 'SCREEN_RAM', 'the screen', 0x4000],
  ['port', 0x7f00, 'GATE_ARRAY', 'port: Gate Array - pens, colors, mode, ROMs'], ['port', 0xbc00, 'CRTC_SELECT', 'port: CRTC register select'],
  ['port', 0xbd00, 'CRTC_DATA', 'port: CRTC register data'], ['port', 0xdf00, 'ROM_SELECT', 'port: upper ROM select'], ['port', 0xf400, 'PPI_A', 'port: PPI port A - AY data, keyboard'],
  ['port', 0xf500, 'PPI_B', 'port: PPI port B - frame flyback, tape'], ['port', 0xf600, 'PPI_C', 'port: PPI port C - AY control, keyboard row'], ['port', 0xf700, 'PPI_CTRL', 'port: PPI control'],
  ['port', 0xfa7e, 'FDC_MOTOR', 'port: disk motor'], ['port', 0xfb7e, 'FDC_STATUS', 'port: FDC status'], ['port', 0xfb7f, 'FDC_DATA', 'port: FDC data'],
];

// the SNES: the registers in bank $00 (and its mirrors), as the code of a LoROM reaches them
const SNES_PPU = ['INIDISP', 'OBSEL', 'OAMADDL', 'OAMADDH', 'OAMDATA', 'BGMODE', 'MOSAIC', 'BG1SC', 'BG2SC', 'BG3SC', 'BG4SC', 'BG12NBA', 'BG34NBA',
  'BG1HOFS', 'BG1VOFS', 'BG2HOFS', 'BG2VOFS', 'BG3HOFS', 'BG3VOFS', 'BG4HOFS', 'BG4VOFS', 'VMAIN', 'VMADDL', 'VMADDH', 'VMDATAL', 'VMDATAH',
  'M7SEL', 'M7A', 'M7B', 'M7C', 'M7D', 'M7X', 'M7Y', 'CGADD', 'CGDATA', 'W12SEL', 'W34SEL', 'WOBJSEL', 'WH0', 'WH1', 'WH2', 'WH3', 'WBGLOG', 'WOBJLOG',
  'TM', 'TS', 'TMW', 'TSW', 'CGWSEL', 'CGADSUB', 'COLDATA', 'SETINI', 'MPYL', 'MPYM', 'MPYH', 'SLHV', 'RDOAM', 'RDVRAML', 'RDVRAMH', 'RDCGRAM', 'OPHCT', 'OPVCT', 'STAT77', 'STAT78'];
const SNES_PPU_DESC = { INIDISP: 'screen on/off and brightness', OBSEL: 'sprite size and tiles', OAMADDL: 'OAM address low', OAMADDH: 'OAM address high', OAMDATA: 'OAM data',
  BGMODE: 'background mode and tile size', MOSAIC: 'mosaic', BG1SC: 'BG1 tilemap address and size', BG2SC: 'BG2 tilemap', BG3SC: 'BG3 tilemap', BG4SC: 'BG4 tilemap',
  BG12NBA: 'BG1 and BG2 tile addresses', BG34NBA: 'BG3 and BG4 tile addresses', VMAIN: 'VRAM address step', VMADDL: 'VRAM address low', VMADDH: 'VRAM address high',
  VMDATAL: 'VRAM data low', VMDATAH: 'VRAM data high', CGADD: 'palette (CGRAM) address', CGDATA: 'palette data, BGR555 low then high', TM: 'main screen layers',
  TS: 'sub screen layers', TMW: 'main screen windows', TSW: 'sub screen windows', CGWSEL: 'color math control', CGADSUB: 'color math layers', COLDATA: 'the fixed color',
  SETINI: 'interlace, overscan, pseudo hires', MPYL: 'multiply result low', MPYM: 'multiply result middle', MPYH: 'multiply result high', SLHV: 'latch the H/V counters',
  RDVRAML: 'VRAM read low', RDVRAMH: 'VRAM read high', RDCGRAM: 'palette read', OPHCT: 'H counter', OPVCT: 'V counter', STAT77: 'PPU1 status', STAT78: 'PPU2 status' };
const SNES_CPU = ['NMITIMEN', 'WRIO', 'WRMPYA', 'WRMPYB', 'WRDIVL', 'WRDIVH', 'WRDIVB', 'HTIMEL', 'HTIMEH', 'VTIMEL', 'VTIMEH', 'MDMAEN', 'HDMAEN', 'MEMSEL', null, null,
  'RDNMI', 'TIMEUP', 'HVBJOY', 'RDIO', 'RDDIVL', 'RDDIVH', 'RDMPYL', 'RDMPYH', 'JOY1L', 'JOY1H', 'JOY2L', 'JOY2H', 'JOY3L', 'JOY3H', 'JOY4L', 'JOY4H'];
const SNES_CPU_DESC = { NMITIMEN: 'NMI, IRQ and joypad reading on', WRIO: 'programmable I/O out', WRMPYA: 'multiplicand', WRMPYB: 'multiplier (starts)', WRDIVL: 'dividend low',
  WRDIVH: 'dividend high', WRDIVB: 'divisor (starts)', HTIMEL: 'H IRQ position low', HTIMEH: 'H IRQ position high', VTIMEL: 'V IRQ line low', VTIMEH: 'V IRQ line high',
  MDMAEN: 'start DMA channels', HDMAEN: 'HDMA channels on', MEMSEL: 'ROM speed', RDNMI: 'NMI flag and CPU version', TIMEUP: 'IRQ flag', HVBJOY: 'blank and joypad status',
  RDIO: 'programmable I/O in', RDDIVL: 'quotient low', RDDIVH: 'quotient high', RDMPYL: 'product or remainder low', RDMPYH: 'product or remainder high',
  JOY1L: 'joypad 1 low', JOY1H: 'joypad 1 high', JOY2L: 'joypad 2 low', JOY2H: 'joypad 2 high', JOY3L: 'joypad 3 low', JOY3H: 'joypad 3 high', JOY4L: 'joypad 4 low', JOY4H: 'joypad 4 high' };
const SNES_DMA = ['DMAP', 'BBAD', 'A1TL', 'A1TH', 'A1B', 'DASL', 'DASH', 'DASB', 'A2AL', 'A2AH', 'NTRL'];
const SNES_DMA_DESC = { DMAP: 'parameters', BBAD: 'B bus register ($21xx)', A1TL: 'A address low', A1TH: 'A address high', A1B: 'A bank', DASL: 'size low',
  DASH: 'size high', DASB: 'HDMA indirect bank', A2AL: 'HDMA table address low', A2AH: 'HDMA table address high', NTRL: 'HDMA line counter' };
const SNES = [
  [0x0000, 'LOWRAM', 'the first 8K of the work RAM ($7e0000)', 0x2000],
  ...SNES_PPU.map((n, k) => [0x2100 + k, n, `PPU: ${SNES_PPU_DESC[n] ?? n.toLowerCase()}`]),
  ...[0, 1, 2, 3].map(k => [0x2140 + k, `APUIO${k}`, `APU: port ${k} to the SPC700`]),
  [0x2180, 'WMDATA', 'WRAM: data'], [0x2181, 'WMADDL', 'WRAM: address low'], [0x2182, 'WMADDM', 'WRAM: address middle'], [0x2183, 'WMADDH', 'WRAM: address bank bit'],
  [0x4016, 'JOYSER0', 'joypad 1 serial (write: latch)'], [0x4017, 'JOYSER1', 'joypad 2 serial'],
  ...SNES_CPU.map((n, k) => n && [0x4200 + k, n, `CPU: ${SNES_CPU_DESC[n]}`]).filter(Boolean),
  ...[0, 1, 2, 3, 4, 5, 6, 7].flatMap(c => SNES_DMA.map((n, k) => [0x4300 + c * 16 + k, `${n}${c}`, `DMA ${c}: ${SNES_DMA_DESC[n]}`])),
  [0x8000, 'ROM', 'the ROM of the cartridge (LoROM bank)', 0x7fc0],
  [0xffc0, 'HEADER_TITLE', 'header: the title, 21 characters', 21], [0xffd5, 'HEADER_MAP', 'header: map mode ($20 LoROM, $21 HiROM, +$10 fast)'],
  [0xffd6, 'HEADER_TYPE', 'header: cartridge type'], [0xffd7, 'HEADER_ROM_SIZE', 'header: ROM size, 2^n KB'], [0xffd8, 'HEADER_RAM_SIZE', 'header: RAM size, 2^n KB'],
  [0xffd9, 'HEADER_REGION', 'header: country'], [0xffda, 'HEADER_DEVELOPER', 'header: developer'], [0xffdb, 'HEADER_VERSION', 'header: version'],
  [0xffdc, 'HEADER_CHECKSUM_INV', 'header: checksum complement', 2], [0xffde, 'HEADER_CHECKSUM', 'header: checksum', 2],
  [0xffe4, 'NATIVE_COP', 'CPU: native COP vector', 2], [0xffe6, 'NATIVE_BRK', 'CPU: native BRK vector', 2], [0xffe8, 'NATIVE_ABORT', 'CPU: native ABORT vector', 2],
  [0xffea, 'NATIVE_NMI', 'CPU: native NMI vector', 2], [0xffee, 'NATIVE_IRQ', 'CPU: native IRQ vector', 2],
  [0xfff4, 'EMU_COP', 'CPU: emulation COP vector', 2], [0xfff8, 'EMU_ABORT', 'CPU: emulation ABORT vector', 2], [0xfffa, 'EMU_NMI', 'CPU: emulation NMI vector', 2],
  [0xfffc, 'RESET_VECTOR', 'CPU: reset vector', 2], [0xfffe, 'EMU_IRQ', 'CPU: emulation IRQ / BRK vector', 2],
];

// the ZX81: its system variables and ROM routines
const ZX81 = [
  [0x0008, 'ERROR_1', 'ROM: RST 8, report an error (the code follows)'], [0x0010, 'PRINT_A', 'ROM: RST $10, print the character in A'],
  [0x02bb, 'KEYBOARD', 'ROM: scan the keyboard'], [0x07bd, 'DECODE', 'ROM: the character of a key'], [0x08f5, 'PRINT_AT', 'ROM: move the print position (B line, C column)'],
  [0x0a2a, 'CLS', 'ROM: clear the screen'], [0x0f23, 'FAST', 'ROM: fast mode'], [0x0f2b, 'SLOW', 'ROM: slow mode'],
  ...[[0x4009, 'VERSN', 1], [0x400a, 'E_PPC', 2], [0x400c, 'D_FILE', 2, 'the address of the display file'], [0x400e, 'DF_CC', 2], [0x4010, 'VARS', 2],
    [0x4012, 'DEST', 2], [0x4014, 'E_LINE', 2], [0x4016, 'CH_ADD', 2], [0x4018, 'X_PTR', 2], [0x401a, 'STKBOT', 2], [0x401c, 'STKEND', 2],
    [0x401e, 'BERG', 1], [0x401f, 'MEM', 2], [0x4022, 'DF_SZ', 1], [0x4023, 'S_TOP', 2], [0x4025, 'LAST_K', 2, 'the keys pressed'], [0x4027, 'DB_ST', 1],
    [0x4028, 'MARGIN', 1], [0x4029, 'NXTLIN', 2, 'the next line to run'], [0x402b, 'OLDPPC', 2], [0x402d, 'FLAGX', 1], [0x402e, 'STRLEN', 2],
    [0x4030, 'T_ADDR', 2], [0x4032, 'SEED', 2, 'the seed of RND'], [0x4034, 'FRAMES', 2, 'counts the frames down'], [0x4036, 'COORDS', 2],
    [0x4038, 'PR_CC', 1], [0x4039, 'S_POSN', 2, 'the print position (column, line)'], [0x403b, 'CDFLAG', 1, 'bit 6: slow mode'],
    [0x403c, 'PRBUFF', 33, 'the printer buffer'], [0x405d, 'MEMBOT', 30, 'the memory of the calculator']]
    .map(([a, n, s, d]) => [a, n, `system variable${d ? `: ${d}` : ''}`, s]),
  [0x407d, 'PROGRAM', 'the BASIC program (1 REM: machine code at $4082)'],
];

// the TRS-80 Model I and III: the screen, the keyboard matrix and the Level II ROM
const TRS80 = [
  [0x002b, 'KBCHAR', 'ROM: the key pressed, if any (A)'], [0x0033, 'VDCHAR', 'ROM: print the character in A'], [0x0049, 'KBWAIT', 'ROM: wait for a key (A)'],
  [0x0038, 'RST_INTERRUPT', 'the interrupt entry (RST 7)'], [0x003b, 'PRCHAR', 'ROM: print the character in A on the printer'],
  [0x0040, 'KBLINE', 'ROM: input a line (HL the buffer, B its length)'], [0x0060, 'DELAY', 'ROM: wait BC * 14.66 µs'], [0x0066, 'NMI', 'the NMI entry (RESET)'],
  [0x01c9, 'CLS', 'ROM: clear the screen'], [0x01f8, 'CSOFF', 'ROM: the cassette motor off'], [0x0212, 'DEFCAS', 'ROM: select the cassette (A 0)'],
  [0x0235, 'CSIN', 'ROM: read a byte from the cassette'], [0x0264, 'CSOUT', 'ROM: write a byte to the cassette'],
  [0x0287, 'WRLDR', 'ROM: write the leader and sync byte'], [0x0296, 'RDLDR', 'ROM: read the leader and sync byte'],
  [0x4020, 'CURSOR', 'the address of the cursor on the screen', 2], [0x40a4, 'TXTTAB', 'the start of the BASIC program', 2], [0x40b1, 'MEMSIZ', 'the top of the memory of BASIC', 2],
  [0x3800, 'KEYBOARD', 'the keyboard matrix (read)', 0x100], [0x3c00, 'SCREEN_RAM', 'the screen: 16 lines of 64 characters', 0x400],
  ['port', 0xff, 'CASSETTE', 'port: the cassette, the 32/64 column mode'],
];

// the BBC Micro: the MOS calls, its vectors and SHEILA ($FExx)
const BBC = [
  ...[[0x0200, 'USERV'], [0x0202, 'BRKV'], [0x0204, 'IRQ1V'], [0x0206, 'IRQ2V'], [0x0208, 'CLIV'], [0x020a, 'BYTEV'], [0x020c, 'WORDV'], [0x020e, 'WRCHV'],
    [0x0210, 'RDCHV'], [0x0212, 'FILEV'], [0x0214, 'ARGSV'], [0x0216, 'BGETV'], [0x0218, 'BPUTV'], [0x021a, 'GBPBV'], [0x021c, 'FINDV'], [0x021e, 'FSCV'], [0x0220, 'EVNTV']]
    .map(([a, n]) => [a, n, `MOS: the vector of ${n.slice(0, -1)}`, 2]),
  [0x7c00, 'MODE7_SCREEN', 'the screen of MODE 7 (teletext)', 0x400],
  [0xfe00, 'CRTC_ADDR', '6845: register select'], [0xfe01, 'CRTC_DATA', '6845: register data'], [0xfe08, 'ACIA_CTRL', '6850: control / status'], [0xfe09, 'ACIA_DATA', '6850: data'],
  [0xfe10, 'SERIAL_ULA', 'serial ULA: baud rates'], [0xfe20, 'VIDEO_ULA_CTRL', 'video ULA: control'], [0xfe21, 'VIDEO_ULA_PALETTE', 'video ULA: palette'],
  [0xfe30, 'ROMSEL', 'the paged ROM'],
  ...range(0xfe40, ['SYSVIA_ORB', 'SYSVIA_ORA', 'SYSVIA_DDRB', 'SYSVIA_DDRA', 'SYSVIA_T1CL', 'SYSVIA_T1CH', 'SYSVIA_T1LL', 'SYSVIA_T1LH', 'SYSVIA_T2CL', 'SYSVIA_T2CH', 'SYSVIA_SR', 'SYSVIA_ACR', 'SYSVIA_PCR', 'SYSVIA_IFR', 'SYSVIA_IER', 'SYSVIA_ORA_NH'], 'system VIA'),
  ...range(0xfe60, ['USRVIA_ORB', 'USRVIA_ORA', 'USRVIA_DDRB', 'USRVIA_DDRA', 'USRVIA_T1CL', 'USRVIA_T1CH', 'USRVIA_T1LL', 'USRVIA_T1LH', 'USRVIA_T2CL', 'USRVIA_T2CH', 'USRVIA_SR', 'USRVIA_ACR', 'USRVIA_PCR', 'USRVIA_IFR', 'USRVIA_IER', 'USRVIA_ORA_NH'], 'user VIA'),
  [0xfe80, 'FDC', '8271: the disc controller', 8], [0xfec0, 'ADC', 'uPD7002: the analogue inputs', 4],
  ...[[0xffce, 'OSFIND', 'open or close a file'], [0xffd1, 'OSGBPB', 'read or write bytes of a file'], [0xffd4, 'OSBPUT', 'write a byte to a file'], [0xffd7, 'OSBGET', 'read a byte of a file'],
    [0xffda, 'OSARGS', 'the arguments of a file'], [0xffdd, 'OSFILE', 'load or save a file'], [0xffe0, 'OSRDCH', 'read a character'], [0xffe3, 'OSASCI', 'print a character, CR as a new line'],
    [0xffe7, 'OSNEWL', 'print a new line'], [0xffee, 'OSWRCH', 'print the character in A'], [0xfff1, 'OSWORD', 'an OSWORD call (A, XY: the block)'], [0xfff4, 'OSBYTE', 'an OSBYTE call (A, X, Y)'],
    [0xfff7, 'OSCLI', 'run a * command (XY: the text)']].map(([a, n, d]) => [a, n, `MOS: ${d}`]),
];

// the Amiga 500 (OCS): the custom chips at $dff000 (word registers), the two CIAs, the memory
const CUSTOM = (off, name, desc) => [0xdff000 + off, name, `Custom: ${desc}`];
const AMIGA = [
  [0x000000, 'CHIP_RAM', 'the chip RAM (512K): the custom chips read it', 0x80000],
  [0x000004, 'EXEC_BASE', 'Exec: the pointer to ExecBase (a long)'],
  [0xc00000, 'SLOW_RAM', 'the trapdoor RAM (512K, "slow")', 0x80000],
  [0xf80000, 'KICKSTART', 'the Kickstart ROM', 0x80000],
  [0xbfe001, 'CIAA_PRA', 'CIA-A: port A - the fire buttons (bits 6, 7), the LED (bit 1), the ROM overlay (bit 0)'],
  [0xbfe101, 'CIAA_PRB', 'CIA-A: port B - the parallel port'],
  [0xbfe401, 'CIAA_TALO', 'CIA-A: timer A low'], [0xbfe501, 'CIAA_TAHI', 'CIA-A: timer A high'],
  [0xbfe601, 'CIAA_TBLO', 'CIA-A: timer B low'], [0xbfe701, 'CIAA_TBHI', 'CIA-A: timer B high'],
  [0xbfe801, 'CIAA_TODLO', 'CIA-A: the vertical blank counter, low'], [0xbfec01, 'CIAA_SDR', 'CIA-A: the keyboard data'],
  [0xbfed01, 'CIAA_ICR', 'CIA-A: interrupt control'], [0xbfee01, 'CIAA_CRA', 'CIA-A: control A'], [0xbfef01, 'CIAA_CRB', 'CIA-A: control B'],
  [0xbfd000, 'CIAB_PRA', 'CIA-B: port A - the serial and parallel lines'], [0xbfd100, 'CIAB_PRB', 'CIA-B: port B - the disk drives (motor, select, side, direction, step)'],
  [0xbfd400, 'CIAB_TALO', 'CIA-B: timer A low'], [0xbfd500, 'CIAB_TAHI', 'CIA-B: timer A high'],
  [0xbfd600, 'CIAB_TBLO', 'CIA-B: timer B low'], [0xbfd700, 'CIAB_TBHI', 'CIA-B: timer B high'],
  [0xbfd800, 'CIAB_TODLO', 'CIA-B: the horizontal sync counter, low'], [0xbfdd00, 'CIAB_ICR', 'CIA-B: interrupt control'],
  [0xbfde00, 'CIAB_CRA', 'CIA-B: control A'], [0xbfdf00, 'CIAB_CRB', 'CIA-B: control B'],
  CUSTOM(0x002, 'DMACONR', 'DMA control (read)'), CUSTOM(0x004, 'VPOSR', 'the beam: long frame, bit 8 of the line'),
  CUSTOM(0x006, 'VHPOSR', 'the beam: line (high byte) and position (low byte)'),
  CUSTOM(0x00a, 'JOY0DAT', 'port 0: mouse or joystick counters'), CUSTOM(0x00c, 'JOY1DAT', 'port 1: joystick or mouse counters'),
  CUSTOM(0x010, 'ADKCONR', 'audio and disk control (read)'), CUSTOM(0x016, 'POTGOR', 'the pot pins: the right mouse button (bit 10)'),
  CUSTOM(0x01a, 'DSKBYTR', 'the disk data byte'), CUSTOM(0x01c, 'INTENAR', 'interrupts on (read)'), CUSTOM(0x01e, 'INTREQR', 'interrupt requests (read)'),
  CUSTOM(0x020, 'DSKPTH', 'the disk DMA pointer (a long)'), CUSTOM(0x024, 'DSKLEN', 'the disk DMA length'), CUSTOM(0x02a, 'VPOSW', 'the beam (write)'),
  CUSTOM(0x02e, 'COPCON', 'the Copper may write the blitter'), CUSTOM(0x034, 'POTGO', 'the pot pins (write)'),
  CUSTOM(0x040, 'BLTCON0', 'blitter: shift A, channels, minterms'), CUSTOM(0x042, 'BLTCON1', 'blitter: shift B, line mode, fill'),
  CUSTOM(0x044, 'BLTAFWM', 'blitter: the mask of the first word of A'), CUSTOM(0x046, 'BLTALWM', 'blitter: the mask of the last word of A'),
  CUSTOM(0x048, 'BLTCPTH', 'blitter: the pointer of C (a long)'), CUSTOM(0x04c, 'BLTBPTH', 'blitter: the pointer of B (a long)'),
  CUSTOM(0x050, 'BLTAPTH', 'blitter: the pointer of A (a long)'), CUSTOM(0x054, 'BLTDPTH', 'blitter: the pointer of D (a long)'),
  CUSTOM(0x058, 'BLTSIZE', 'blitter: height and width - starts the blit'),
  CUSTOM(0x060, 'BLTCMOD', 'blitter: the modulo of C'), CUSTOM(0x062, 'BLTBMOD', 'blitter: the modulo of B'),
  CUSTOM(0x064, 'BLTAMOD', 'blitter: the modulo of A'), CUSTOM(0x066, 'BLTDMOD', 'blitter: the modulo of D'),
  CUSTOM(0x070, 'BLTCDAT', 'blitter: the data of C'), CUSTOM(0x072, 'BLTBDAT', 'blitter: the data of B'), CUSTOM(0x074, 'BLTADAT', 'blitter: the data of A'),
  CUSTOM(0x07e, 'DSKSYNC', 'the disk sync word'),
  CUSTOM(0x080, 'COP1LC', 'the first Copper list (a long)'), CUSTOM(0x084, 'COP2LC', 'the second Copper list (a long)'),
  CUSTOM(0x088, 'COPJMP1', 'restart the Copper at COP1LC (a strobe)'), CUSTOM(0x08a, 'COPJMP2', 'restart the Copper at COP2LC (a strobe)'),
  CUSTOM(0x08e, 'DIWSTRT', 'the display window: start'), CUSTOM(0x090, 'DIWSTOP', 'the display window: stop'),
  CUSTOM(0x092, 'DDFSTRT', 'the bitplane fetch: start'), CUSTOM(0x094, 'DDFSTOP', 'the bitplane fetch: stop'),
  CUSTOM(0x096, 'DMACON', 'DMA control: bit 15 set or clear, bitplanes, Copper, blitter, sprites, disk, audio'),
  CUSTOM(0x098, 'CLXCON', 'collision control'), CUSTOM(0x09a, 'INTENA', 'interrupts on: bit 15 set or clear, bit 14 the master'),
  CUSTOM(0x09c, 'INTREQ', 'interrupt requests: bit 15 set or clear'), CUSTOM(0x09e, 'ADKCON', 'audio and disk control'),
  ...[0, 1, 2, 3].flatMap(k => [CUSTOM(0x0a0 + k * 16, `AUD${k}LC`, `audio ${k}: the sample (a long)`), CUSTOM(0x0a4 + k * 16, `AUD${k}LEN`, `audio ${k}: the length in words`),
    CUSTOM(0x0a6 + k * 16, `AUD${k}PER`, `audio ${k}: the period`), CUSTOM(0x0a8 + k * 16, `AUD${k}VOL`, `audio ${k}: the volume (0 to 64)`)]),
  ...[1, 2, 3, 4, 5, 6].map(k => CUSTOM(0x0e0 + (k - 1) * 4, `BPL${k}PT`, `the pointer of bitplane ${k} (a long)`)),
  CUSTOM(0x100, 'BPLCON0', 'bitplanes: their number, hires, HAM, dual playfield, color'), CUSTOM(0x102, 'BPLCON1', 'bitplanes: the scroll of the playfields'),
  CUSTOM(0x104, 'BPLCON2', 'bitplanes: the priorities'), CUSTOM(0x108, 'BPL1MOD', 'the modulo of the odd bitplanes'), CUSTOM(0x10a, 'BPL2MOD', 'the modulo of the even bitplanes'),
  ...[0, 1, 2, 3, 4, 5, 6, 7].map(k => CUSTOM(0x120 + k * 4, `SPR${k}PT`, `the pointer of sprite ${k} (a long)`)),
  ...Array.from({ length: 32 }, (_, k) => CUSTOM(0x180 + k * 2, `COLOR${String(k).padStart(2, '0')}`, `color ${k} ($0RGB)${k === 0 ? ' - the background' : ''}`)),
];

const MAPS = { c64: C64, c128: C128, vic20: VIC20, plus4: PLUS4, c16: PLUS4, pet: PET, atari8: ATARI8, vcs: VCS, nes: NES, snes: SNES, cpc464: CPC, cpc6128: CPC,
  zx81: ZX81, trs80: TRS80, trs80m3: TRS80, bbcb: BBC, mega65: MEGA65, amiga500: AMIGA };

// --- lookups ---------------------------------------------------------------------------------------

const cache = new Map();
// the symbols of a machine: { list: [{ addr, name, desc, size, read, port }], at(addr, read) -> { name, desc, offset } | null }
export function symbolsFor(machine) {
  if (cache.has(machine)) return cache.get(machine);
  const list = (MAPS[machine] ?? []).map(e => (e[0] === 'port'
    ? { addr: e[1], name: e[2], desc: e[3], size: 1, port: true }
    : { addr: e[0], name: e[1], desc: e[2], size: e[3] ?? 1, read: e[4] ?? null }));
  const exact = new Map(), areas = [];
  for (const s of list) {
    if (s.port) continue;
    if (s.size > 1) areas.push(s);
    if (!exact.has(s.addr) || exact.get(s.addr).size > s.size) exact.set(s.addr, s);     // a register wins over an area
  }
  areas.sort((a, b) => a.size - b.size);                                                    // the smallest area that holds it
  const at = (addr, read = false) => {
    const s = exact.get(addr);
    if (s) return { name: read && s.read ? s.read : s.name, desc: s.desc, offset: 0, sym: s };
    const a = areas.find(x => addr > x.addr && addr < x.addr + x.size);
    return a ? { name: a.name, desc: a.desc, offset: addr - a.addr, sym: a } : null;
  };
  const r = { list, at };
  cache.set(machine, r);
  return r;
}

// the machines that have a memory map
export const hasMemoryMap = machine => !!MAPS[machine];

// the include file of a machine: every name as an ACME constant, by area
export function includeSource(machine, title = machine) {
  const { list } = symbolsFor(machine);
  const seen = new Set(), out = [`; hardware.inc - the addresses of the ${title}: chips, ROM routines, vectors, RAM areas`,
    '; made by nerdsuite - include it with !source "hardware.inc"', ''];
  let group = null;
  const sorted = [...list].sort((a, b) => (a.port - b.port) || a.addr - b.addr);
  for (const s of sorted) {
    for (const [name, desc] of [[s.name, s.desc], ...(s.read ? [[s.read, `${s.desc.split(':')[0]}: read at ${s.name}`]] : [])]) {
      if (seen.has(name)) continue;
      seen.add(name);
      const g = desc.split(':')[0];
      if (g !== group && desc.includes(':')) { out.push('', `; ${g}`); group = g; }
      out.push(`${name.padEnd(20)}= $${s.addr.toString(16).padStart(s.addr < 0x100 && !s.port ? 2 : 4, '0')}${' '.repeat(4)}; ${desc.replace(/^[^:]*:\s*/, '')}${s.size > 1 ? ` (${s.size} bytes)` : ''}`);
      if (name === s.name) for (const b of describeBits(machine, name)) out.push(`${''.padEnd(28)};   ${b.where.padEnd(9)} ${b.what}`);
    }
  }
  return out.join('\n') + '\n';
}

// --- the bits of the registers ----------------------------------------------------------------------
//
// A register's fields: [high bit, low bit, label, values] - values: { value: text }, an array, a function
// of the field, 'colors' (the color names of the machine), 'mask' (each bit one thing: 'sprite' gives
// sprites 0, 3; 'BG1, BG2' names the bits). A one bit field without values shows its label when set.

const C64_COLORS = ['black', 'white', 'red', 'cyan', 'purple', 'green', 'blue', 'yellow', 'orange', 'brown', 'light red', 'dark grey', 'grey', 'light green', 'light blue', 'light grey'];
const TED_COLORS = ['black', 'white', 'red', 'cyan', 'purple', 'green', 'blue', 'yellow', 'orange', 'brown', 'yellow-green', 'pink', 'blue-green', 'light blue', 'dark blue', 'light green'];
const VIC20_COLORS = C64_COLORS.slice(0, 8).concat(['orange', 'light orange', 'pink', 'light cyan', 'light purple', 'light green', 'light blue', 'light yellow']);
const ATARI_HUES = ['grey', 'gold', 'orange', 'red-orange', 'pink', 'purple', 'blue-purple', 'blue', 'blue', 'light blue', 'turquoise', 'green-blue', 'green', 'yellow-green', 'orange-green', 'light orange'];
const hexOf = n => '$' + n.toString(16).padStart(4, '0');
const at = step => v => hexOf(v * step);
const ON = { 0: 'off', 1: 'on' };

const COLOR16 = [[3, 0, 'color', 'colors']];
const SPRITE_MASK = [[7, 0, 'sprite', 'mask']];
const CIA_ICR = [[0, 0, 'timer A'], [1, 1, 'timer B'], [2, 2, 'TOD alarm'], [3, 3, 'serial'], [4, 4, 'FLAG line'], [7, 7, 'set (write) / IRQ (read)']];
const CIA_CRA = [[0, 0, 'start'], [1, 1, 'output on PB6'], [2, 2, 'toggle'], [3, 3, 'one shot'], [4, 4, 'load the latch'], [5, 5, 'count CNT'], [6, 6, 'serial out'], [7, 7, 'TOD 50 Hz']];
const CIA_CRB = [[0, 0, 'start'], [1, 1, 'output on PB7'], [2, 2, 'toggle'], [3, 3, 'one shot'], [4, 4, 'load the latch'], [6, 5, 'counts', { 0: 'cycles', 1: 'CNT', 2: 'timer A', 3: 'timer A with CNT' }], [7, 7, 'set the alarm']];
const VIA_IER = [[0, 0, 'CA2'], [1, 1, 'CA1'], [2, 2, 'shift register'], [3, 3, 'CB2'], [4, 4, 'CB1'], [5, 5, 'timer 2'], [6, 6, 'timer 1'], [7, 7, 'set (write) / IRQ (read)']];
const ATARI_COLOR = [[3, 1, 'luminance'], [7, 4, 'hue', ATARI_HUES]];
const AUDC = [[3, 0, 'volume'], [4, 4, 'volume only'], [7, 5, 'distortion']];
const DMACTL = [[1, 0, 'playfield', { 0: 'off', 1: 'narrow', 2: 'normal', 3: 'wide' }], [2, 2, 'missile DMA'], [3, 3, 'player DMA'], [4, 4, 'single line players'], [5, 5, 'display list DMA']];
const PRIOR = [[3, 0, 'priority'], [4, 4, 'fifth player'], [5, 5, 'multicolor players'], [7, 6, 'GTIA mode', { 0: 'normal', 1: '16 luminances', 2: '9 colors', 3: '16 hues' }]];
const VCS_COLOR = [[3, 1, 'luminance'], [7, 4, 'hue']];
const NUSIZ = [[2, 0, 'player', { 0: 'one copy', 1: 'two close', 2: 'two medium', 3: 'three close', 4: 'two wide', 5: 'double size', 6: 'three medium', 7: 'quad size' }], [5, 4, 'missile width', { 0: '1', 1: '2', 2: '4', 3: '8' }]];
const SQ_VOL = [[3, 0, 'volume'], [4, 4, 'constant volume'], [5, 5, 'loop / halt'], [7, 6, 'duty', { 0: '12.5%', 1: '25%', 2: '50%', 3: '75%' }]];
const SQ_SWEEP = [[2, 0, 'shift'], [3, 3, 'negate'], [6, 4, 'period'], [7, 7, 'sweep on']];
const SNES_LAYERS = [[4, 0, 'BG1, BG2, BG3, BG4, sprites', 'mask']];
const SNES_SC = [[1, 0, 'size', { 0: '32x32', 1: '64x32', 2: '32x64', 3: '64x64' }], [7, 2, 'tilemap at word', at(0x400)]];
const VOICE = [[6, 0, 'frequency'], [7, 7, 'on']];
const TED_COLOR = [[3, 0, 'color', 'colors'], [6, 4, 'luminance']];

const C64_BITS = {
  CPU_PORT: [[2, 0, 'memory', { 0: 'all RAM', 1: 'char ROM', 2: 'char ROM, KERNAL', 3: 'char ROM, BASIC, KERNAL', 4: 'all RAM', 5: 'I/O', 6: 'I/O, KERNAL', 7: 'I/O, BASIC, KERNAL' }],
    [3, 3, 'tape out'], [4, 4, 'tape button up'], [5, 5, 'tape motor off']],
  VIC_CTRL1: [[2, 0, 'y scroll'], [3, 3, 'rows', { 0: '24', 1: '25' }], [4, 4, 'screen', ON], [5, 5, 'bitmap'], [6, 6, 'extended color'], [7, 7, 'raster bit 8']],
  VIC_CTRL2: [[2, 0, 'x scroll'], [3, 3, 'columns', { 0: '38', 1: '40' }], [4, 4, 'multicolor'], [5, 5, 'reset']],
  VIC_MEMORY: [[3, 1, 'chars / bitmap at', v => `${hexOf(v * 0x800)} in the bank`], [7, 4, 'screen at', v => `${hexOf(v * 0x400)} in the bank`]],
  VIC_IRQ: [[0, 0, 'raster'], [1, 1, 'sprite-background'], [2, 2, 'sprite-sprite'], [3, 3, 'light pen'], [7, 7, 'IRQ']],
  VIC_IRQ_MASK: [[0, 0, 'raster'], [1, 1, 'sprite-background'], [2, 2, 'sprite-sprite'], [3, 3, 'light pen']],
  ...Object.fromEntries(['VIC_SPR_HI_X', 'VIC_SPR_ENA', 'VIC_SPR_EXP_Y', 'VIC_SPR_PRIO', 'VIC_SPR_MCOLOR', 'VIC_SPR_EXP_X', 'VIC_SPR_COLL', 'VIC_SPR_BG_COLL'].map(n => [n, SPRITE_MASK])),
  ...Object.fromEntries(['VIC_BORDER', 'VIC_BG_COLOR0', 'VIC_BG_COLOR1', 'VIC_BG_COLOR2', 'VIC_BG_COLOR3', 'VIC_SPR_MCOLOR0', 'VIC_SPR_MCOLOR1', 'COLOR',
    ...[0, 1, 2, 3, 4, 5, 6, 7].map(k => `VIC_SPR${k}_COLOR`)].map(n => [n, COLOR16])),
  ...Object.fromEntries([1, 2, 3].flatMap(v => [
    [`SID_V${v}_CTRL`, [[0, 0, 'gate'], [1, 1, 'sync'], [2, 2, 'ring'], [3, 3, 'test'], [4, 4, 'triangle'], [5, 5, 'saw'], [6, 6, 'pulse'], [7, 7, 'noise']]],
    [`SID_V${v}_AD`, [[3, 0, 'decay'], [7, 4, 'attack']]], [`SID_V${v}_SR`, [[3, 0, 'release'], [7, 4, 'sustain']]],
    [`SID_V${v}_PW_HI`, [[3, 0, 'pulse width bits 8-11']]]])),
  SID_RES_FILT: [[0, 0, 'filter voice 1'], [1, 1, 'filter voice 2'], [2, 2, 'filter voice 3'], [3, 3, 'filter external'], [7, 4, 'resonance']],
  SID_VOLUME: [[3, 0, 'volume'], [4, 4, 'low pass'], [5, 5, 'band pass'], [6, 6, 'high pass'], [7, 7, 'voice 3 off']],
  CIA1_ICR: CIA_ICR, CIA2_ICR: CIA_ICR, CIA1_CRA: CIA_CRA, CIA2_CRA: CIA_CRA, CIA1_CRB: CIA_CRB, CIA2_CRB: CIA_CRB,
  CIA2_PRA: [[1, 0, 'VIC bank', { 0: '$c000', 1: '$8000', 2: '$4000', 3: '$0000' }], [2, 2, 'RS-232 out'], [3, 3, 'ATN out'], [4, 4, 'CLOCK out'], [5, 5, 'DATA out'], [6, 6, 'CLOCK in'], [7, 7, 'DATA in']],
  CIA1_PRB: [[0, 0, 'joystick 1 up (0)'], [1, 1, 'down (0)'], [2, 2, 'left (0)'], [3, 3, 'right (0)'], [4, 4, 'fire (0)']],
  CIA1_PRA: [[0, 0, 'joystick 2 up (0)'], [1, 1, 'down (0)'], [2, 2, 'left (0)'], [3, 3, 'right (0)'], [4, 4, 'fire (0)']],
};
const MMU_CR = [[0, 0, '$d000', { 0: 'I/O', 1: 'RAM or ROM' }], [1, 1, '$4000-$7fff', { 0: 'BASIC ROM', 1: 'RAM' }],
  [3, 2, '$8000-$bfff', { 0: 'BASIC ROM', 1: 'internal function ROM', 2: 'external function ROM', 3: 'RAM' }],
  [5, 4, '$c000-$ffff', { 0: 'KERNAL', 1: 'internal function ROM', 2: 'external function ROM', 3: 'RAM' }], [7, 6, 'RAM bank']];
const C128_BITS = { ...C64_BITS, MMU_CR, MMU_LCR: MMU_CR, VIC_CLOCK: [[0, 0, '2 MHz'], [1, 1, 'test']],
  MMU_MCR: [[0, 0, 'Z80 off (8502 on)'], [3, 3, 'fast serial out'], [4, 4, 'GAME in'], [5, 5, 'EXROM in'], [6, 6, 'C64 mode'], [7, 7, '40/80 key up (40)']] };

const VIC20_BITS = {
  VIC_HORIZ: [[6, 0, 'left of the screen'], [7, 7, 'interlace']], VIC_COLUMNS: [[6, 0, 'columns'], [7, 7, 'screen address bit 9']],
  VIC_ROWS: [[0, 0, '8x16 chars'], [6, 1, 'rows'], [7, 7, 'raster bit 0']],
  VIC_MEMORY: [[3, 0, 'chars at', { 0: '$8000 (ROM)', 1: '$8400', 2: '$8800', 3: '$8c00', 8: '$0000', 12: '$1000', 13: '$1400', 14: '$1800', 15: '$1c00' }], [7, 4, 'screen address bits 10-13']],
  VIC_BASS: VOICE, VIC_ALTO: VOICE, VIC_SOPRANO: VOICE, VIC_NOISE: VOICE,
  VIC_VOLUME: [[3, 0, 'volume'], [7, 4, 'auxiliary color', 'colors']],
  VIC_COLOR: [[2, 0, 'border', 'colors'], [3, 3, 'normal (not reverse)'], [7, 4, 'screen', 'colors']],
  VIA1_IER: VIA_IER, VIA2_IER: VIA_IER, VIA1_IFR: VIA_IER, VIA2_IFR: VIA_IER, COLOR: [[2, 0, 'color', 'colors']],
};

const PLUS4_BITS = {
  TED_CTRL1: [[2, 0, 'y scroll'], [3, 3, 'rows', { 0: '24', 1: '25' }], [4, 4, 'screen', ON], [5, 5, 'bitmap'], [6, 6, 'extended color'], [7, 7, 'test']],
  TED_CTRL2: [[2, 0, 'x scroll'], [3, 3, 'columns', { 0: '38', 1: '40' }], [4, 4, 'multicolor'], [5, 5, 'freeze'], [6, 6, 'NTSC'], [7, 7, 'reverse off']],
  TED_IRQ: [[1, 1, 'raster'], [2, 2, 'light pen'], [3, 3, 'timer 1'], [4, 4, 'timer 2'], [6, 6, 'timer 3'], [7, 7, 'IRQ']],
  TED_IRQ_MASK: [[0, 0, 'raster bit 8'], [1, 1, 'raster'], [2, 2, 'light pen'], [3, 3, 'timer 1'], [4, 4, 'timer 2'], [6, 6, 'timer 3']],
  TED_SOUND: [[3, 0, 'volume'], [4, 4, 'voice 1'], [5, 5, 'voice 2'], [6, 6, 'voice 2 noise'], [7, 7, 'D/A mode']],
  TED_BITMAP: [[1, 0, 'voice 1 frequency bits 8-9'], [2, 2, 'chars from ROM'], [5, 3, 'bitmap at', at(0x2000)]],
  TED_CHARSET: [[0, 0, 'ROM (read)'], [1, 1, 'single clock'], [7, 2, 'chars at', at(0x400)]],
  TED_VIDEO: [[7, 3, 'attributes and screen at', at(0x800)]],
  ...Object.fromEntries(['TED_BG_COLOR0', 'TED_BG_COLOR1', 'TED_BG_COLOR2', 'TED_BG_COLOR3', 'TED_BORDER', 'COLOR'].map(n => [n, TED_COLOR])),
};

const ATARI8_BITS = {
  DMACTL, SDMCTL: DMACTL, PRIOR, GPRIOR: PRIOR,
  NMIEN: [[5, 5, 'RESET key'], [6, 6, 'vertical blank'], [7, 7, 'display list interrupt']],
  CHACTL: [[0, 0, 'blank reverse chars'], [1, 1, 'reverse'], [2, 2, 'upside down']],
  GRACTL: [[0, 0, 'missiles'], [1, 1, 'players'], [2, 2, 'latch the triggers']],
  CONSOL: [[0, 0, 'START up'], [1, 1, 'SELECT up'], [2, 2, 'OPTION up'], [3, 3, 'speaker']],
  AUDCTL: [[0, 0, '15 kHz'], [1, 1, 'high pass 2 by 4'], [2, 2, 'high pass 1 by 3'], [3, 3, 'join 3 and 4'], [4, 4, 'join 1 and 2'], [5, 5, '3 at 1.79 MHz'], [6, 6, '1 at 1.79 MHz'], [7, 7, '9 bit noise']],
  AUDC1: AUDC, AUDC2: AUDC, AUDC3: AUDC, AUDC4: AUDC,
  PORTB: [[0, 0, 'OS ROM'], [1, 1, 'BASIC off'], [3, 2, 'XE bank'], [4, 4, 'CPU extended RAM off'], [5, 5, 'ANTIC extended RAM off'], [7, 7, 'self test off']],
  ...Object.fromEntries(['COLPM0', 'COLPM1', 'COLPM2', 'COLPM3', 'COLPF0', 'COLPF1', 'COLPF2', 'COLPF3', 'COLBK', 'COLOR0', 'COLOR1', 'COLOR2', 'COLOR3', 'COLOR4', 'PCOLR0'].map(n => [n, ATARI_COLOR])),
  SIZEP0: [[1, 0, 'width', { 0: 'normal', 1: 'double', 2: 'normal', 3: 'quadruple' }]],
};

const VCS_BITS = {
  VSYNC: [[1, 1, 'vertical sync']], VBLANK: [[1, 1, 'vertical blank'], [6, 6, 'latch the triggers'], [7, 7, 'ground the paddles']],
  CTRLPF: [[0, 0, 'reflect'], [1, 1, 'score colors'], [2, 2, 'playfield in front'], [5, 4, 'ball width', { 0: '1', 1: '2', 2: '4', 3: '8' }]],
  NUSIZ0: NUSIZ, NUSIZ1: NUSIZ,
  ...Object.fromEntries(['COLUP0', 'COLUP1', 'COLUPF', 'COLUBK'].map(n => [n, VCS_COLOR])),
  AUDC0: [[3, 0, 'distortion']], AUDC1: [[3, 0, 'distortion']], AUDV0: [[3, 0, 'volume']], AUDV1: [[3, 0, 'volume']],
  AUDF0: [[4, 0, 'frequency divider']], AUDF1: [[4, 0, 'frequency divider']],
  REFP0: [[3, 3, 'reflect']], REFP1: [[3, 3, 'reflect']], ENAM0: [[1, 1, 'missile on']], ENAM1: [[1, 1, 'missile on']], ENABL: [[1, 1, 'ball on']],
  VDELP0: [[0, 0, 'delay']], VDELP1: [[0, 0, 'delay']], VDELBL: [[0, 0, 'delay']], RESMP0: [[1, 1, 'missile on the player']], RESMP1: [[1, 1, 'missile on the player']],
  HMP0: [[7, 4, 'motion']], HMP1: [[7, 4, 'motion']], HMM0: [[7, 4, 'motion']], HMM1: [[7, 4, 'motion']], HMBL: [[7, 4, 'motion']],
  SWCHA: [[0, 0, 'P1 up (0)'], [1, 1, 'P1 down (0)'], [2, 2, 'P1 left (0)'], [3, 3, 'P1 right (0)'], [4, 4, 'P0 up (0)'], [5, 5, 'P0 down (0)'], [6, 6, 'P0 left (0)'], [7, 7, 'P0 right (0)']],
  SWCHB: [[0, 0, 'RESET up'], [1, 1, 'SELECT up'], [3, 3, 'color'], [6, 6, 'P0 difficulty A'], [7, 7, 'P1 difficulty A']],
};

const NES_BITS = {
  PPUCTRL: [[1, 0, 'nametable', { 0: '$2000', 1: '$2400', 2: '$2800', 3: '$2c00' }], [2, 2, 'VRAM step', { 0: '+1', 1: '+32' }], [3, 3, 'sprite tiles', { 0: '$0000', 1: '$1000' }],
    [4, 4, 'background tiles', { 0: '$0000', 1: '$1000' }], [5, 5, 'sprites', { 0: '8x8', 1: '8x16' }], [6, 6, 'PPU slave'], [7, 7, 'NMI at the vertical blank']],
  PPUMASK: [[0, 0, 'greyscale'], [1, 1, 'background in the left 8'], [2, 2, 'sprites in the left 8'], [3, 3, 'background'], [4, 4, 'sprites'], [5, 5, 'more red'], [6, 6, 'more green'], [7, 7, 'more blue']],
  PPUSTATUS: [[5, 5, 'sprite overflow'], [6, 6, 'sprite 0 hit'], [7, 7, 'vertical blank']],
  SQ1_VOL: SQ_VOL, SQ2_VOL: SQ_VOL, SQ1_SWEEP: SQ_SWEEP, SQ2_SWEEP: SQ_SWEEP,
  SQ1_HI: [[2, 0, 'period bits 8-10'], [7, 3, 'length']], SQ2_HI: [[2, 0, 'period bits 8-10'], [7, 3, 'length']], TRI_HI: [[2, 0, 'period bits 8-10'], [7, 3, 'length']],
  TRI_LINEAR: [[6, 0, 'linear counter'], [7, 7, 'control / halt']],
  NOISE_VOL: [[3, 0, 'volume'], [4, 4, 'constant volume'], [5, 5, 'loop / halt']], NOISE_LO: [[3, 0, 'period'], [7, 7, 'short noise']], NOISE_HI: [[7, 3, 'length']],
  DMC_FREQ: [[3, 0, 'rate'], [6, 6, 'loop'], [7, 7, 'IRQ']],
  SND_CHN: [[0, 0, 'pulse 1'], [1, 1, 'pulse 2'], [2, 2, 'triangle'], [3, 3, 'noise'], [4, 4, 'DMC'], [6, 6, 'frame IRQ (read)'], [7, 7, 'DMC IRQ (read)']],
  JOY1: [[0, 0, 'strobe (write) / button (read)']], JOY2: [[0, 0, 'button (read)'], [6, 6, 'frame IRQ off (write)'], [7, 7, '5 step sequence (write)']],
};

const DMAP = [[2, 0, 'transfer', { 0: '1 byte', 1: '2 bytes to 2 registers', 2: '2 bytes to 1 register', 3: '4 bytes to 2 registers', 4: '4 bytes to 4 registers' }],
  [4, 3, 'A address', { 0: '+1', 1: 'fixed', 2: '-1', 3: 'fixed' }], [6, 6, 'indirect (HDMA)'], [7, 7, 'from B to A']];
const SNES_BITS = {
  INIDISP: [[3, 0, 'brightness'], [7, 7, 'forced blank']],
  OBSEL: [[2, 0, 'sprite tiles at word', at(0x2000)], [4, 3, 'gap'], [7, 5, 'sprite sizes', { 0: '8/16', 1: '8/32', 2: '8/64', 3: '16/32', 4: '16/64', 5: '32/64', 6: '16x32/32x64', 7: '16x32/32x32' }]],
  BGMODE: [[2, 0, 'mode'], [3, 3, 'BG3 in front'], [4, 4, '16x16 BG1'], [5, 5, '16x16 BG2'], [6, 6, '16x16 BG3'], [7, 7, '16x16 BG4']],
  MOSAIC: [[3, 0, 'BG1, BG2, BG3, BG4', 'mask'], [7, 4, 'size']],
  BG1SC: SNES_SC, BG2SC: SNES_SC, BG3SC: SNES_SC, BG4SC: SNES_SC,
  BG12NBA: [[3, 0, 'BG1 tiles at word', at(0x1000)], [7, 4, 'BG2 tiles at word', at(0x1000)]], BG34NBA: [[3, 0, 'BG3 tiles at word', at(0x1000)], [7, 4, 'BG4 tiles at word', at(0x1000)]],
  VMAIN: [[1, 0, 'step', { 0: '1', 1: '32', 2: '128', 3: '128' }], [3, 2, 'address remap'], [7, 7, 'step after the high byte']],
  TM: SNES_LAYERS, TS: SNES_LAYERS, TMW: SNES_LAYERS, TSW: SNES_LAYERS,
  CGADSUB: [[5, 0, 'BG1, BG2, BG3, BG4, sprites, backdrop', 'mask'], [6, 6, 'half'], [7, 7, 'subtract']],
  SETINI: [[0, 0, 'screen interlace'], [1, 1, 'sprite interlace'], [2, 2, '239 lines'], [3, 3, 'pseudo hires'], [6, 6, 'mode 7 EXTBG'], [7, 7, 'external sync']],
  NMITIMEN: [[0, 0, 'read the joypads'], [5, 4, 'IRQ', { 0: 'off', 1: 'H', 2: 'V', 3: 'H and V' }], [7, 7, 'NMI']],
  MDMAEN: [[7, 0, 'channel', 'mask']], HDMAEN: [[7, 0, 'channel', 'mask']], MEMSEL: [[0, 0, 'fast ROM']],
  RDNMI: [[3, 0, 'CPU version'], [7, 7, 'NMI']], TIMEUP: [[7, 7, 'IRQ']], HVBJOY: [[0, 0, 'reading the joypads'], [6, 6, 'horizontal blank'], [7, 7, 'vertical blank']],
  ...Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7].map(k => [`DMAP${k}`, DMAP])),
};

const MEGA65_BITS = { ...C64_BITS,
  VIC3_CTRLB: [[0, 0, 'interlace'], [1, 1, 'monochrome'], [2, 2, '1280 pixels'], [3, 3, '400 lines'], [4, 4, 'bitplanes'], [5, 5, 'attributes'], [6, 6, 'fast CPU'], [7, 7, '80 columns']],
};
const BITS = { mega65: MEGA65_BITS, c64: C64_BITS, c128: C128_BITS, vic20: VIC20_BITS, plus4: PLUS4_BITS, c16: PLUS4_BITS, atari8: ATARI8_BITS, vcs: VCS_BITS, nes: NES_BITS, snes: SNES_BITS };
const COLOR_NAMES = { mega65: C64_COLORS, c64: C64_COLORS, c128: C64_COLORS, vic20: VIC20_COLORS, plus4: TED_COLORS, c16: TED_COLORS };

// the fields of a register of a machine, or null
export const bitsOf = (machine, name) => BITS[machine]?.[name] ?? null;

// a value of a register in words: 'y scroll 3 · 25 rows · screen on'
export function decodeBits(machine, name, value) {
  const fields = bitsOf(machine, name);
  if (!fields) return null;
  const parts = [];
  for (const [hi, lo, label, values] of fields) {
    const v = (value >> lo) & ((1 << (hi - lo + 1)) - 1);
    if (values === 'mask') {
      const set = [];
      for (let k = 0; k <= hi - lo; k++) if (v >> k & 1) set.push(k);
      const names = label.split(', ');
      parts.push(names.length > 1 ? (set.length ? set.map(k => names[k]).join(', ') : 'none') : `${label}s ${set.length ? set.join(', ') : 'none'}`);
    } else if (values === 'colors') parts.push(`${label} ${(COLOR_NAMES[machine] ?? C64_COLORS)[v] ?? v}`);
    else if (typeof values === 'function') parts.push(`${label} ${values(v)}`);
    else if (values) parts.push(`${label} ${values[v] ?? v}`);
    else if (hi === lo) { if (v) parts.push(label); }
    else parts.push(`${label} ${v}`);
  }
  return parts.join(' · ') || 'all bits clear';
}

// the fields as rows: { where: 'bits 2-0', what: 'y scroll' }
export function describeBits(machine, name) {
  return (bitsOf(machine, name) ?? []).map(([hi, lo, label, values]) => {
    let what = label;
    if (values === 'colors') what += ': a color';
    else if (values === 'mask') what += ': a bit each';
    else if (Array.isArray(values)) what += `: ${values.map((t, k) => `${k} ${t}`).join(', ')}`;
    else if (values && typeof values === 'object') what += `: ${Object.entries(values).map(([k, t]) => `${k} ${t}`).join(', ')}`;
    return { where: hi === lo ? `bit ${hi}` : `bits ${hi}-${lo}`, what };
  });
}
