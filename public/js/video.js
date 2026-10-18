// video.js - the graphics of each machine: which editors it has (the views of the nav rail), its
// colours, its multicolor modes and the size of its screen. The editors work in the machine of the
// project (setVideoMachine, app.js); a machine without hardware sprites, a bitmap or characters of
// its own does not show that editor.
//
//   editors   screen, sprites, chars, tiles, bitmap: true when the machine has them
//   palette   { name, colors: ['#rrggbb', ...], note } - the colours an emulator shows: VICE 3.10 (the VIC-20,
//             the TED, the PET), Altirra (the Atari 8-bit), Stella (the 2600); the CPC and the BBC by their
//             rules, the NES a common 2C02 table
//   cells     the colours of a character cell: 'vic2' (C64: 16), 'vic' (VIC-20: 8 of 16), 'ted' (121, a
//             hue and a luminance), 'mono' (PET: one colour) - and their multicolor mode:
//               vic2  colour bit 3 makes a cell multicolor: 00 background, 01 mc1 ($d022), 10 mc2 ($d023),
//                     11 the colour & 7
//               vic   bit 3 too: 00 background, 01 the border, 10 the colour & 7, 11 the auxiliary colour
//                     ($900e) - the place's two multicolors are the border and the auxiliary colour
//               ted   bit 3 too: 00 background ($ff15), 01 $ff16, 10 $ff17, 11 the colour & $77 (hue 0-7,
//                     any luminance)
//               atari the Atari's ANTIC modes: no colour of a cell - the five colour registers COLOR0-4 of the
//                     screen (atariRegs) and bit 7 of a char: ANTIC 2 (GRAPHICS 0) 8 x 8 pixels in the luminance
//                     of COLOR1 on COLOR2, bit 7 inverse; ANTIC 4 (multicolor) 4 x 8 pixels, 00 COLOR4, 01
//                     COLOR0, 10 COLOR1, 11 COLOR2 - COLOR3 with bit 7
//   ecm       the extended colour mode (C64, TED)
//   bitmap    'koala' (C64: per 8x8 cell 3 colours + 1 shared), 'ted' (Plus/4: per cell 2 + 2 shared), 'atari'
//             (GRAPHICS 8 and 15: the colour registers of the whole picture, 192 rows - ataribitmap.js)
//   sprite    { cols, rows, block } of a sprite: the C64's 24 x 21 (64 bytes) unless it says, an Atari player 8 x 16
//   screen    { cols, rows } of the text screen (the NES and SNES: the tile map)

const hex = (r, g, b) => '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

// the C64 (the colours of yopaca's editors, c64.js)
export const VIC2_COLORS = ['#000000', '#ffffff', '#880000', '#aaffee', '#cc44cc', '#00cc55', '#0000aa', '#eeee77',
  '#dd8855', '#664400', '#ff7777', '#333333', '#777777', '#aaff66', '#0088ff', '#bbbbbb'];

// the VIC-20 (6561): 16 colours, as VICE 3.10 shows them (a screenshot of xvic)
const VIC = ['#000000', '#ffffff', '#c13c0e', '#80ffff', '#e747e6', '#68ff90', '#6532f3', '#ffff4e',
  '#e49200', '#ffdfd8', '#ffc3f6', '#e0ffff', '#ffceff', '#e9ffb8', '#c8cbff', '#ffffdf'];

// the TED (Plus/4, C16): luminance in bits 4-6, hue in bits 0-3 - 128 entries, hue 0 is black at every
// luminance: 121 colours. As VICE 3.10 shows them (a screenshot of xplus4)
const TED = ['#000000', '#202020', '#5e0700', '#003940', '#56006c', '#004a00', '#150aae', '#2b3600', '#541600', '#422600', '#124300', '#5f0038', '#004508', '#001a9a', '#2e00ac', '#004a00',
  '#000000', '#303030', '#6e1710', '#004950', '#66067c', '#005a00', '#251abe', '#3b4600', '#642600', '#523600', '#225300', '#6f0b48', '#005518', '#0e2aaa', '#3e0dbc', '#0b5a00',
  '#000000', '#404040', '#7e2720', '#025960', '#76168c', '#0a6a00', '#352ace', '#4b5600', '#743600', '#624600', '#326300', '#7f1b58', '#016528', '#1e3aba', '#4e1dcc', '#1b6a00',
  '#000000', '#505050', '#8e3730', '#126970', '#86269c', '#1a7a04', '#453ade', '#5b6600', '#844600', '#725600', '#427300', '#8f2b68', '#117538', '#2e4aca', '#5e2ddc', '#2b7a00',
  '#000000', '#787878', '#b65f58', '#3a9198', '#ae4ec4', '#42a22c', '#6d62ff', '#838e00', '#ac6e25', '#9a7e00', '#6a9b00', '#b75390', '#399d60', '#5672f2', '#8655ff', '#53a203',
  '#000000', '#909090', '#ce7770', '#52a9b0', '#c666dc', '#5aba44', '#857aff', '#9ba602', '#c4863d', '#b29616', '#82b304', '#cf6ba8', '#51b578', '#6e8aff', '#9e6dff', '#6bba1b',
  '#000000', '#c0c0c0', '#fea7a0', '#82d9e0', '#f696ff', '#8aea74', '#b5aaff', '#cbd632', '#f4b66d', '#e2c646', '#b2e334', '#ff9bd8', '#81e5a8', '#9ebaff', '#ce9dff', '#9bea4b',
  '#000000', '#ffffff', '#ffe7e0', '#c2ffff', '#ffd6ff', '#caffb4', '#f5eaff', '#ffff72', '#fff6ad', '#ffff86', '#f2ff74', '#ffdbff', '#c1ffe8', '#defaff', '#ffddff', '#dbff8b'];

// the PET: green on black (xpet); every colour but 0 is the green, so a colour of the C64 shows
const PET_GREEN = '#65d045';
const PET = ['#000000', ...Array(15).fill(PET_GREEN)];

// the Atari 8-bit computers (GTIA): 16 hues x 8 luminances (hue * 8 + luminance / 2), as Altirra 4.40 shows them
// (NTSC, its default palette: a screenshot of bands of COLBK) - most modes ignore the low bit of the luminance
const GTIA = [
  '#000000', '#161517', '#3e3c3f', '#67646a', '#837e85', '#aaa4ad', '#cdc6d2', '#f3ebf8', '#000200', '#072a00', '#364f00', '#627500', '#7f8e00', '#a7b327', '#cbd555', '#f2f981',
  '#0c0000', '#3d1800', '#653d00', '#8f6400', '#aa7e00', '#d2a33a', '#f5c564', '#ffea8f', '#280000', '#5a0000', '#832900', '#ad5216', '#c86d39', '#f09365', '#ffb68c', '#ffdbb4',
  '#360000', '#670000', '#901829', '#bb4556', '#d66072', '#fe879b', '#ffaabf', '#ffd0e7', '#330010', '#63023d', '#8c1a65', '#b7428e', '#d25da9', '#fa84d1', '#ffa7f4', '#ffccff',
  '#1a0a42', '#4c156d', '#772793', '#a14abb', '#bd64d6', '#e589fd', '#ffabff', '#ffd0ff', '#00135f', '#221f89', '#5134ae', '#7d56d6', '#996ff1', '#c194ff', '#e5b6ff', '#ffdaff',
  '#001463', '#00238d', '#123eb2', '#4c62da', '#6a7cf4', '#94a1ff', '#b9c2ff', '#e0e7ff', '#000e4d', '#002578', '#00489d', '#006ec5', '#2a88e0', '#60aeff', '#89d0ff', '#b3f4ff',
  '#000421', '#002c4d', '#005274', '#00799d', '#0093b8', '#22b9df', '#5edbff', '#8effff', '#000b00', '#003512', '#005b3c', '#008267', '#009c83', '#00c2ab', '#4ae3d0', '#7ffff6',
  '#001200', '#003b00', '#005f00', '#00862b', '#009f4a', '#26c575', '#61e69a', '#90ffc2', '#000f00', '#003900', '#005d00', '#008300', '#319c0d', '#65c146', '#8ee36e', '#b7ff98',
  '#000500', '#002f00', '#235300', '#537900', '#709200', '#9ab729', '#bed956', '#e5fd82', '#030000', '#321e00', '#5a4300', '#846900', '#9f8300', '#c7a831', '#eaca5d', '#ffef88'];

// the Atari 2600 (TIA, NTSC): 16 hues x 8 luminances, the palette of Stella 7.0 (its table)
const TIA = [
  '#000000', '#4a4a4a', '#6f6f6f', '#8e8e8e', '#aaaaaa', '#c0c0c0', '#d6d6d6', '#ececec', '#484800', '#69690f', '#86861d', '#a2a22a', '#bbbb35', '#d2d240', '#e8e84a', '#fcfc54',
  '#7c2c00', '#904811', '#a26221', '#b47a30', '#c3903d', '#d2a44a', '#dfb755', '#ecc860', '#901c00', '#a33915', '#b55328', '#c66c3a', '#d5824a', '#e39759', '#f0aa67', '#fcbc74',
  '#940000', '#a71a1a', '#b83232', '#c84848', '#d65c5c', '#e46f6f', '#f08080', '#fc9090', '#840064', '#97197a', '#a8308f', '#b846a2', '#c659b3', '#d46cc3', '#e07cd2', '#ec8ce0',
  '#500084', '#68199a', '#7d30ad', '#9246c0', '#a459d0', '#b56ce0', '#c57cee', '#d48cfc', '#140090', '#331aa3', '#4e32b5', '#6848c6', '#7f5cd5', '#956fe3', '#a980f0', '#bc90fc',
  '#000094', '#181aa7', '#2d32b8', '#4248c8', '#545cd6', '#656fe4', '#7580f0', '#8490fc', '#001c88', '#183b9d', '#2d57b0', '#4272c2', '#548ad2', '#65a0e1', '#75b5ef', '#84c8fc',
  '#003064', '#185080', '#2d6d98', '#4288b0', '#54a0c5', '#65b7d9', '#75cceb', '#84e0fc', '#004030', '#18624e', '#2d8169', '#429e82', '#54b899', '#65d1ae', '#75e7c2', '#84fcd4',
  '#004400', '#1a661a', '#328432', '#48a048', '#5cba5c', '#6fd26f', '#80e880', '#90fc90', '#143c00', '#355f18', '#527e2d', '#6e9c42', '#87b754', '#9ed065', '#b4e775', '#c8fc84',
  '#303800', '#505916', '#6d762b', '#88923e', '#a0ab4f', '#b7c25f', '#ccd86e', '#e0ec7c', '#482c00', '#694d14', '#866a26', '#a28638', '#bb9f47', '#d2b656', '#e8cc63', '#fce070'];

// the CPC: 27 colours, three levels of red, green and blue; the firmware number is 9 G + 3 R + B
const LEVEL = [0x00, 0x80, 0xff];
const CPC = Array.from({ length: 27 }, (_, k) => hex(LEVEL[Math.floor(k / 3) % 3], LEVEL[Math.floor(k / 9)], LEVEL[k % 3]));

// the NES (2C02): 64 entries, $0d-$0f, $1d-$1f, $2e-$2f, $3e-$3f black
const NES = ['#626262', '#001fb2', '#2404c8', '#5200b2', '#730076', '#800024', '#730b00', '#522800', '#244400', '#005700', '#005c00', '#005324', '#003c76', '#000000', '#000000', '#000000',
  '#ababab', '#0d57ff', '#4b30ff', '#8a13ff', '#bc08d6', '#d21269', '#c72e00', '#9d5400', '#607b00', '#209800', '#00a300', '#009942', '#007db4', '#000000', '#000000', '#000000',
  '#ffffff', '#53aeff', '#9085ff', '#d365ff', '#ff57ff', '#ff5dcf', '#ff7757', '#fa9e00', '#bdc700', '#7ae700', '#43f611', '#26ef7e', '#2cd5f6', '#4e4e4e', '#000000', '#000000',
  '#ffffff', '#b6e1ff', '#ced1ff', '#e9c3ff', '#ffbcff', '#ffbdf4', '#ffc6c3', '#ffd59a', '#e9e681', '#cef481', '#b6fb9a', '#a9fac3', '#a9f0f4', '#b8b8b8', '#000000', '#000000'];

// the BBC Micro: 8 colours (bit 0 red, 1 green, 2 blue); 8-15 flash between a colour and its opposite
const BBC = Array.from({ length: 8 }, (_, k) => hex(k & 1 ? 255 : 0, k & 2 ? 255 : 0, k & 4 ? 255 : 0));

// the SNES has no palette of its own (any of 32768 colours, BGR555): the editors offer 128 of them, 4 levels
// of red, 8 of green, 4 of blue
const SNES = Array.from({ length: 128 }, (_, k) => hex([0, 85, 170, 255][k >> 5], Math.round((k >> 2 & 7) * 255 / 7), [0, 85, 170, 255][k & 3]));

export const PALETTES = {
  vic2: { name: 'VIC-II', colors: VIC2_COLORS, note: '16 colours' },
  vic: { name: 'VIC (6561)', colors: VIC, note: '16 colours (VICE); the colour of a character is one of the first 8' },
  ted: { name: 'TED', colors: TED, note: '121 colours (VICE): 16 hues in 8 luminances' },
  pet: { name: 'PET', colors: PET, note: 'green on black (VICE)' },
  gtia: { name: 'GTIA', colors: GTIA, note: '128 colours, 16 hues in 8 luminances as most modes show them (Altirra)' },
  tia: { name: 'TIA (NTSC)', colors: TIA, note: '128 colours, 16 hues in 8 luminances (Stella)' },
  cpc: { name: 'CPC', colors: CPC, note: '27 colours: 3 levels of red, green and blue (the firmware numbers)' },
  nes: { name: 'NES (2C02)', colors: NES, note: '64 entries, 54 colours; a sprite or background palette takes 3 of them and a shared background colour' },
  snes: { name: 'SNES', colors: SNES, note: '128 of its 32768 colours (BGR555); a palette of the SNES holds 16 of them (4 bits per pixel) or 4 (2 bits)' },
  zx81: { name: 'ZX81', colors: ['#000000', '#ffffff'], note: 'black on white' },
  trs80: { name: 'TRS-80', colors: ['#000000', '#e6f0ff'], note: 'white on black' },
  bbc: { name: 'BBC Micro', colors: BBC, note: '8 colours; MODE 2 shows 8 and 8 flashing ones, MODE 1 and 5 four of them, MODE 0 and 4 two' },
};

const ALL = { screen: true, sprites: true, chars: true, tiles: true, bitmap: true };
const only = (...names) => Object.fromEntries(Object.keys(ALL).map(k => [k, names.includes(k)]));
const C64 = { editors: ALL, palette: 'vic2', cells: 'vic2', ecm: true, bitmap: 'koala', screen: { cols: 40, rows: 25 } };
const TEDM = { editors: only('screen', 'chars', 'tiles', 'bitmap'), palette: 'ted', cells: 'ted', ecm: true, bitmap: 'ted', screen: { cols: 40, rows: 25 } };

// the machines whose own colour rules come later: a cell or a sprite takes any colour of the palette, no
// multicolor or ECM of the Commodores; the bitmap is a Koala file of 16 of its colours (koala: the indices)
// cols: the columns of the chooser, names: the names of the colours, start: the colours of a new screen
const FREE = { cells: 'free', ecm: false, bitmap: 'koala' };
const CPC_NAMES = ['black', 'blue', 'bright blue', 'red', 'magenta', 'mauve', 'bright red', 'purple', 'bright magenta', 'green', 'cyan', 'sky blue',
  'yellow', 'white', 'pastel blue', 'orange', 'pink', 'pastel magenta', 'bright green', 'sea green', 'bright cyan', 'lime', 'pastel green', 'pastel cyan',
  'bright yellow', 'pastel yellow', 'bright white'];
const BBC_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
const hex2 = v => `$${v.toString(16).padStart(2, '0')}`;
// the colour register value of the Atari (hue in the high nibble, luminance 0-14): $94 the blue of GRAPHICS 0
const atariName = k => hex2(((k >> 3) << 4) | (k & 7) * 2);
// a player of the Atari: 8 pixels wide, a part 16 rows (a costume of parts one above the other: a taller player)
const PLAYER = { cols: 8, rows: 16, block: 16 };
const ATARI = { ...FREE, cells: 'atari', bitmap: 'atari', sprite: PLAYER, palette: 'gtia', cols: 8, name: atariName, start: { bg: 9 * 8 + 2, border: 0, text: 9 * 8 + 5 },
  koala: [0, 7, 2, 5, ...Array.from({ length: 12 }, (_, h) => (h + 1) * 8 + 4)] };
const CPCM = { ...FREE, palette: 'cpc', cols: 9, names: CPC_NAMES, start: { bg: 1, border: 1, text: 24 },
  koala: [0, 1, 2, 3, 4, 6, 9, 11, 12, 13, 15, 18, 20, 24, 25, 26] };

// the profile of each machine (platforms.js ids)
const PROFILES = {
  c64: C64,
  c128: C64,
  vic20: { editors: only('screen', 'chars', 'tiles'), palette: 'vic', cells: 'vic', ecm: false, bitmap: null, screen: { cols: 22, rows: 23 } },
  plus4: TEDM,
  c16: TEDM,
  pet: { editors: only('screen', 'tiles'), palette: 'pet', cells: 'mono', ecm: false, bitmap: null, screen: { cols: 40, rows: 25 } },
  atari8: { ...ATARI, editors: ALL, screen: { cols: 40, rows: 24 } },
  vcs: { ...ATARI, cells: 'free', editors: only('sprites'), palette: 'tia', start: { bg: 0, border: 0, text: 7 }, koala: null, screen: null },
  cpc464: { ...CPCM, editors: only('screen', 'chars', 'tiles', 'bitmap'), screen: { cols: 40, rows: 25 } },
  cpc6128: { ...CPCM, editors: only('screen', 'chars', 'tiles', 'bitmap'), screen: { cols: 40, rows: 25 } },
  nes: { ...FREE, editors: only('screen', 'sprites', 'chars', 'tiles'), palette: 'nes', cols: 16, name: hex2, start: { bg: 0x0f, border: 0x0f, text: 0x30 }, screen: { cols: 32, rows: 30 } },
  snes: { ...FREE, editors: only('screen', 'sprites', 'chars', 'tiles'), palette: 'snes', cols: 16, name: k => { const [r, g, b] = [1, 3, 5].map(i => parseInt(SNES[k].slice(i, i + 2), 16) >> 3); return `$${((b << 10) | (g << 5) | r).toString(16).padStart(4, '0')}`; }, start: { bg: 0, border: 0, text: 127 }, screen: { cols: 32, rows: 32 } },
  zx81: { ...FREE, editors: only('screen', 'tiles'), palette: 'zx81', cols: 2, names: ['black', 'white'], start: { bg: 1, border: 1, text: 0 }, screen: { cols: 32, rows: 24 } },
  trs80: { ...FREE, editors: only('screen', 'tiles'), palette: 'trs80', cols: 2, names: ['black', 'white'], start: { bg: 0, border: 0, text: 1 }, screen: { cols: 64, rows: 16 } },
  trs80m3: { ...FREE, editors: only('screen', 'tiles'), palette: 'trs80', cols: 2, names: ['black', 'white'], start: { bg: 0, border: 0, text: 1 }, screen: { cols: 64, rows: 16 } },
  bbcb: { ...FREE, editors: only('screen', 'chars', 'tiles', 'bitmap'), palette: 'bbc', cols: 4, names: BBC_NAMES, start: { bg: 0, border: 0, text: 7 },
    koala: [0, 1, 2, 3, 4, 5, 6, 7], screen: { cols: 40, rows: 25 } },
};

// the profile of a machine: { editors, palette: { name, colors, note }, cells, ecm, bitmap, screen };
// an unknown one is a C64
export function videoOf(machine) {
  const p = PROFILES[machine] ?? PROFILES.c64;
  return { ...p, palette: PALETTES[p.palette] };
}

// the graphics views a machine shows
export const GFX_VIEWS = Object.keys(ALL);
export const hasEditor = (machine, view) => !GFX_VIEWS.includes(view) || !!videoOf(machine).editors[view];

// --- the machine the editors work in ------------------------------------------------------------------

let active = 'c64', current = videoOf('c64');
const listeners = new Set();
export const video = () => current;
export const videoMachine = () => active;
// the machine of the project: its palette in PALETTE (c64.js listens), its colour rules
export function setVideoMachine(machine) {
  if (!PROFILES[machine]) machine = 'c64';
  if (machine === active) return false;
  active = machine;
  current = videoOf(machine);
  for (const f of listeners) f(current);
  return true;
}
export const onVideoChange = f => { listeners.add(f); return () => listeners.delete(f); };

// the colours: their number and the mask of a colour value (15, the TED 127, the CPC's 27 in 31 ...): PALETTE
// has mask + 1 entries (c64.js), the ones beyond the palette black
export const colorCount = () => current.palette.colors.length;
export const colorMask = () => (current.cells === 'ted' ? 0x7f : current.cells === 'free' || current.cells === 'atari' ? (2 ** Math.ceil(Math.log2(colorCount()))) - 1 : 15);

// the Atari: the colour registers COLOR0-COLOR4 (PF0-PF3, the background), as the OS starts them: $28 $ca $94
// $46 $00 - palette indices: hue * 8 + luminance / 2
export const ATARI_REGS = [0x28, 0xca, 0x94, 0x46, 0x00].map(v => (v >> 4) * 8 + ((v & 15) >> 1));
export const ATARI_REG_NAMES = ['COLOR0', 'COLOR1', 'COLOR2', 'COLOR3', 'COLOR4'];
// the colour of the set pixels of ANTIC 2: the hue of COLOR2, the luminance of COLOR1
export const antic2Text = regs => (regs[2] & 0x78) | (regs[1] & 7);
// the colours of the cells of an Atari screen from its chars: what the 11 pairs (ANTIC 4) or the set pixels show
export const atariCellColors = (chars, regs, antic4) => Uint8Array.from(chars, c => (antic4 ? (c & 0x80 ? regs[3] : regs[2]) : antic2Text(regs)));

// --- the colours of a cell and their multicolor mode -----------------------------------------------------

// whether the editors offer the multicolor mode: the Commodores' (the others get theirs with their stages)
export const hasMulticolor = () => ['vic2', 'vic', 'ted', 'atari'].includes(current.cells);
// whether a cell colour makes the cell multicolor in a multicolor place: bit 3 on every machine with one
export const isMcCell = c => current.cells === 'atari' || (current.cells !== 'free' && (c & 8) !== 0);   // the Atari: every cell of ANTIC 4
// the colour of a multicolor cell (11 on the C64 and TED, 10 on the VIC-20): bits 0-2, the TED's luminance too
export const mcCellColor = c => (current.cells === 'atari' ? c : c & (current.cells === 'ted' ? 0x77 : 7));
// the cell value of a colour in a multicolor place: the colour with bit 3
export const mcCell = c => (current.cells === 'atari' ? c : mcCellColor(c) | 8);
// the palette indices of the bit pairs 00 01 10 11 of a multicolor cell: bg the background, mc the two
// multicolors of the place, fg the cell colour
export function mcPens(bg, mc, fg) {
  return current.cells === 'vic' ? [bg, mc[0], mcCellColor(fg), mc[1]] : [bg, mc[0], mc[1], mcCellColor(fg)];
}
// the bit pair a pen paints in a multicolor char: 'bg', 'mc1', 'mc2', or 'color' the colour of the cell
export const mcPair = pen => (pen === 'bg' ? 0 : pen === 'mc1' ? 1 : current.cells === 'vic' ? (pen === 'mc2' ? 3 : 2) : pen === 'mc2' ? 2 : 3);
// the names of the place's two multicolors and of the cell colour in multicolor
export function mcNames() {
  if (current.cells === 'vic') return { mc1: 'Border (01)', mc2: 'Auxiliary (11)', cell: 'Char colour (10)' };
  if (current.cells === 'ted') return { mc1: 'Multicolor 1 ($ff16)', mc2: 'Multicolor 2 ($ff17)', cell: 'Char colour (11)' };
  if (current.cells === 'atari') return { mc1: 'COLOR0 (01)', mc2: 'COLOR1 (10)', cell: 'COLOR2 (11)' };
  return { mc1: 'Multicolor 1', mc2: 'Multicolor 2', cell: 'Char colour (11)' };
}

// the colours the char pickers draw in, light on dark (the C64: white on dark grey)
export function pickerColors() {
  const c = current.cells;
  if (c === 'free' || c === 'atari') {
    // the brightest colour on the darkest one
    const luma = hx => { const [r, g, b] = [1, 3, 5].map(k => parseInt(hx.slice(k, k + 2), 16)); return 3 * r + 4 * g + 2 * b; };
    const by = current.palette.colors.map((hx, k) => [luma(hx), k]).sort((a, b) => a[0] - b[0]);
    return { fg: by.at(-1)[1], bg: by[0][1] };
  }
  return c === 'ted' ? { fg: 0x71, bg: 0x21 } : c === 'vic2' ? { fg: 1, bg: 11 } : { fg: 1, bg: 0 };
}
// the colours a screen starts with, as the machine shows them after power on: { bg, border, text }, and
// the first colours of its multicolor mode (mc: the VIC-20's border, one of 8, and auxiliary colour) and ECM
export function startColors(c = current.cells, profile = current) {
  if (c === 'free') return { ...profile.start, mc: null, ecm: null };
  if (c === 'atari') return { ...profile.start, mc: [ATARI_REGS[0], ATARI_REGS[1]], ecm: null };
  return c === 'ted' ? { bg: 0x71, border: 0x6e, text: 0x00, mc: [0x68, 0x49], ecm: [0x32, 0x45, 0x56] }
    : c === 'vic' ? { bg: 1, border: 3, text: 6, mc: [3, 8], ecm: null }
    : c === 'mono' ? { bg: 0, border: 0, text: 1, mc: null, ecm: null }
    : { bg: 6, border: 14, text: 14, mc: [8, 9], ecm: [2, 5, 6] };
}

// the colours a pen can take: 'all' the palette, 'mc' the colour of a multicolor cell, 'cell' a cell colour
// (the VIC-20: 8). { list: [palette index], cols: the columns of the chooser }
export function colorChoices(kind = 'all') {
  const c = current.cells;
  if (c === 'ted') {
    // 16 hues across, 8 luminances down; a multicolor cell: hues 0-7
    const hues = kind === 'mc' ? 8 : 16;
    return { list: Array.from({ length: 8 * hues }, (_, k) => ((7 - Math.floor(k / hues)) << 4) | (k % hues)), cols: hues };
  }
  if (c === 'mono') return { list: [0, 1], cols: 2 };
  if (c === 'free' || c === 'atari') {
    // the bitmap: the 16 colours a Koala file holds; else the whole palette
    if (kind === 'bitmap' && current.koala) return { list: current.koala, cols: 4 };
    return { list: Array.from({ length: colorCount() }, (_, k) => k), cols: current.cols ?? 8 };
  }
  const n = kind === 'mc' || (kind === 'cell' && c === 'vic') ? 8 : 16;
  return { list: Array.from({ length: n }, (_, k) => k), cols: n === 8 ? 4 : 4 };
}

// the name of a colour
const VIC2_NAMES = ['black', 'white', 'red', 'cyan', 'purple', 'green', 'blue', 'yellow', 'orange', 'brown', 'light red', 'dark grey', 'grey', 'light green', 'light blue', 'light grey'];
const VIC_NAMES = ['black', 'white', 'red', 'cyan', 'purple', 'green', 'blue', 'yellow', 'orange', 'light orange', 'pink', 'light cyan', 'light purple', 'light green', 'light blue', 'light yellow'];
const TED_HUES = ['black', 'white', 'red', 'cyan', 'purple', 'green', 'blue', 'yellow', 'orange', 'brown', 'yellow green', 'pink', 'blue green', 'light blue', 'dark blue', 'light green'];
export function colorName(k) {
  const c = current.cells;
  if (c === 'ted') return (k & 15) === 0 ? 'black' : `${TED_HUES[k & 15]} ${(k >> 4) & 7}`;
  if (c === 'mono') return k ? 'green' : 'black';
  if (c === 'free' || c === 'atari') return current.names?.[k] ?? current.name?.(k) ?? String(k);
  return (c === 'vic' ? VIC_NAMES : VIC2_NAMES)[k & 15];
}
// a colour as the model writes it: the name of the C64 colours (COLOR_NAMES of adv.js) up to 15, else its number
export const colorValue = (k, names) => (k < 16 ? names[k] : String(k));
