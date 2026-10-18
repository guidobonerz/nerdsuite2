// song.js - the song of the sound editor: a tracker song for the three voices of the SID.
//   voices       three - or more, up to MAX_VOICES, for an imported MIDI file: the editor plays
//                them on a SID for every three. The game plays up to three of them, `game`: the
//                voices of the song that are the voices of the SID in the game
//   instruments  1-15: a waveform, the envelope (attack, decay, sustain, release), the pulse
//                width with a sweep, a vibrato, an arpeggio (the note and two notes above it, a
//                frame each) and the filter (low, band or high pass, cutoff with a sweep, resonance)
//   patterns     rows of a cell per voice; a cell is a note (or the note off), an
//                instrument and a command with its value (COMMANDS)
//   orders       the patterns in the order the song plays them, with the position it loops to
//   tempo        the frames (1/50 s) a row lasts
//   tables       four tables as GoatTracker has them, shared by the instruments: rows of two bytes
//                (left, right), numbered from 1; an instrument points at a row of each (0: none) and
//                its note runs them from there, a step a frame (sidplayer.js, engine/tables.s)
//     wave       left $00 the waveform stays, $01-$0F wait that many frames, $10-$EF a waveform
//                (the gate bit is the note's), $F0-$FE a command of GoatTracker (skipped), $FF jump
//                to the row of the right byte (0: stop); right $00-$5F that many semitones up,
//                $60-$7F $80 - right down, $80 the pitch stays, $81-$DF right - $80 semitones above
//                C-0 ($81 C#0). The waveform and the arpeggio of the instrument give way to the table
//     pulse      left $80-$8F the width: its high nibble the low nibble of left, its low byte the
//                right one; $01-$7F for that many frames the width moves by the right byte
//                (signed), $FF jump. The width wraps at 12 bits. The width of the instrument and
//                its sweep give way to the table
//     filter     left $80-$F0 the type (bit 4 low, 5 band, 6 high pass) and the resonance (the high
//                nibble of right); $00 the cutoff is right; $01-$7F for that many frames the cutoff
//                moves by the right byte (signed), $FF jump. The note takes the filter, as one of
//                an instrument with a filter does; the cutoff wraps at 8 bits
//     speed      speeds: of a vibrato left the frames of half a wave, right its depth (added to the
//                frequency a frame); of a slide or glide left and right one 16 bit speed. The
//                vibrato row of an instrument (with its delay in frames) and the commands of the
//                table speeds point at a row
//
// The file (.sng) is the song as a player reads it:
//   0   'YSNG'   4   version (2)   5   tempo   6   rows of a pattern
//   7   instruments (NI)   8   patterns (NP)   9   orders (NO)   10   loop position ($ff: the song ends)
//   11  version 3: the voices (NV), else 0 - three
//   12  NO bytes: the orders
//       NI x 12 bytes: waveform ($10 triangle, $20 sawtooth, $40 pulse, $80 noise), attack/decay,
//                     sustain/release, pulse width low, high, pulse sweep, vibrato depth/speed,
//                     arpeggio (the semitones of its two notes, a nibble each), filter (resonance * 16
//                     + 1 low, 2 band, 4 high pass; 0: not filtered), cutoff, cutoff sweep (signed,
//                     a frame), 0
//       NP x rows x NV x 4 bytes: note (0 none, 1-95 C-0 to A#7, $ff off), instrument (0 none),
//                     command (0 none), its value
//       NI x 12 bytes: the names of the instruments, for the editor
//       version 3: 3 bytes, the voices the game plays ($ff: none, a silent voice of the SID)
//   version 4 (a song with tables): instruments of 16 bytes - bytes 0-10 as before, then the row of
//       its wave, pulse and filter table, of its vibrato in the speed table (0: none) and the delay
//       of that vibrato in frames -, the 3 bytes of the game's voices, then the four
//       tables: the rows of the wave, pulse, filter and speed table (a byte each), their rows (2
//       bytes: left, right)
//   version 5 (an instrument with sync or ring modulation): as version 4, and the waveform byte of
//       an instrument keeps the bits $02 (sync with the voice before) and $04 (ring modulation by it)
// A song of three voices that the game plays as they are is written as version 2, one with
// other voices as version 3 - a song without tables stays readable by an older editor; one with
// sync or ring is version 5, which an older editor refuses rather than lose them.
// Version 1 had no arpeggio, filter and commands - instruments of 8 bytes, cells of 2. It is read.

import { CLOCK } from './sid.js';
import { withTag, readTag } from './filetag.js';

export const VOICES = 3;
export const NOTE_OFF = 0xff;
export const NO_LOOP = 0xff;                // the loop position of a song that ends
export const NOTES = 95;                  // C-0 to A#7: a B-7 does not fit the 16 bit frequency
export const MAX_VOICES = 24;             // of a song in the editor: eight SIDs
export const MAX_INSTRUMENTS = 15, MAX_PATTERNS = 64, MAX_ORDERS = 128;
export const ROW_CHOICES = [16, 32, 48, 64];
export const WAVES = [
  { value: 0x10, label: '§0027' }, { value: 0x20, label: '§0028' },
  { value: 0x40, label: '§0029' }, { value: 0x80, label: '§0030' },
];
export const FILTERS = [
  { value: 0, label: '§0031' }, { value: 1, label: '§0032' }, { value: 2, label: '§1110' }, { value: 4, label: '§0033' },
];
// the commands of a cell. A slide and a glide go on until the next note or slide of the voice
// (a slide of 00 ends it); an arpeggio wins over them
export const CMD_UP = 1, CMD_DOWN = 2, CMD_GLIDE = 3, CMD_ARP = 4, CMD_CUTOFF = 5, CMD_PULSE = 6, CMD_VOLUME = 7, CMD_TEMPO = 8, CMD_BREAK = 9;
// the commands of the speed table: the value is a row of it (a 16 bit speed, a vibrato)
export const CMD_UP_T = 10, CMD_DOWN_T = 11, CMD_GLIDE_T = 12, CMD_VIB_T = 13;
export const COMMANDS = [
  { value: CMD_UP, label: '§0034', tip: '§0035' },
  { value: CMD_DOWN, label: '§0036', tip: '§0037' },
  { value: CMD_GLIDE, label: '§0038', tip: '§0039' },
  { value: CMD_ARP, label: 'Arpeggio', tip: '§0040' },
  { value: CMD_CUTOFF, label: '§0041', tip: '§0042' },
  { value: CMD_PULSE, label: '§0367', tip: '§0043' },
  { value: CMD_VOLUME, label: '§0044', tip: '§0045' },
  { value: CMD_TEMPO, label: '§1106', tip: '§0046' },
  { value: CMD_BREAK, label: '§0047', tip: '§0048' },
  { value: CMD_UP_T, label: '§1300', tip: '§1301' },
  { value: CMD_DOWN_T, label: '§1302', tip: '§1303' },
  { value: CMD_GLIDE_T, label: '§1304', tip: '§1305' },
  { value: CMD_VIB_T, label: '§1306', tip: '§1307' },
];
// the four tables of a song, in the order of the file; a table holds MAX_TABLE_ROWS rows at most
export const TABLES = ['wave', 'pulse', 'filter', 'speed'];
export const MAX_TABLE_ROWS = 255;
export const newTables = () => ({ wave: [], pulse: [], filter: [], speed: [] });
export const CELL = 4;                    // the bytes of a cell: note, instrument, command, value
const MAGIC = 'YSNG', NAME_LENGTH = 12, HEADER = 12, VERSION = 5, INS_BYTES = 12, INS_BYTES_4 = 16, NO_VOICE = 0xff;

const NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];
export const NOTE_NAMES = NAMES;
export const noteName = n => (n === NOTE_OFF ? '===' : n ? NAMES[(n - 1) % 12] + Math.floor((n - 1) / 12) : '---');

// the frequency register of note 0 (C-0) and up, A-4 is 440 Hz; one more for the vibrato of the last
export const FREQ = Array.from({ length: NOTES + 1 }, (_, n) =>
  Math.min(65535, Math.round(440 * 2 ** ((n - 57) / 12) * 16777216 / CLOCK)));

export const newInstrument = (name = 'instrument', o = {}) =>
  ({ name, wave: 0x40, a: 0, d: 9, s: 8, r: 9, pulse: 2048, pwm: 0, vibDepth: 0, vibSpeed: 0, arp1: 0, arp2: 0, filter: 0, cutoff: 128, res: 0, sweep: 0,
    waveTab: 0, pulseTab: 0, filterTab: 0, vibTab: 0, vibDelay: 0, ...o });

// the ready instruments the editor adds, by group. The SID has one filter: the last note of an
// instrument with a filter sets it for every voice it sends through it
const TRI = 0x10, SAW = 0x20, PULSE = 0x40, NOISE = 0x80;
export const PRESETS = [
  { group: '§0357', instruments: [
    newInstrument('pwm lead', { wave: PULSE, a: 0, d: 9, s: 10, r: 8, pulse: 0x400, pwm: 40, vibDepth: 3, vibSpeed: 5 }),
    newInstrument('saw lead', { wave: SAW, a: 0, d: 8, s: 11, r: 8, vibDepth: 2, vibSpeed: 5, filter: 1, cutoff: 180, res: 6 }),
    newInstrument('chip square', { wave: PULSE, a: 0, d: 0, s: 15, r: 4, pulse: 0x800 }),
    newInstrument('flute', { wave: TRI, a: 3, d: 8, s: 12, r: 8, vibDepth: 2, vibSpeed: 4 }),
  ] },
  { group: '§0358', instruments: [
    newInstrument('fat bass', { wave: PULSE, a: 0, d: 9, s: 8, r: 6, pulse: 0x300, pwm: 16, filter: 1, cutoff: 60, res: 10 }),
    newInstrument('acid bass', { wave: SAW, a: 0, d: 6, s: 4, r: 4, filter: 1, cutoff: 160, res: 12, sweep: -4 }),
    newInstrument('sub bass', { wave: TRI, a: 0, d: 10, s: 10, r: 6 }),
    newInstrument('pluck bass', { wave: PULSE, a: 0, d: 6, s: 0, r: 6, pulse: 0x800 }),
  ] },
  { group: '§0359', instruments: [
    newInstrument('major arp', { wave: PULSE, a: 0, d: 9, s: 10, r: 8, pulse: 0x600, pwm: 20, arp1: 4, arp2: 7 }),
    newInstrument('minor arp', { wave: PULSE, a: 0, d: 9, s: 10, r: 8, pulse: 0x600, pwm: 20, arp1: 3, arp2: 7 }),
    newInstrument('power chord', { wave: SAW, a: 0, d: 9, s: 10, r: 8, arp1: 7, arp2: 12 }),
  ] },
  { group: '§0360', instruments: [
    newInstrument('string pad', { wave: SAW, a: 8, d: 10, s: 12, r: 11, vibDepth: 2, vibSpeed: 3, filter: 1, cutoff: 120, res: 4 }),
    newInstrument('choir pad', { wave: PULSE, a: 9, d: 10, s: 12, r: 11, pulse: 0x800, pwm: 8, vibDepth: 1, vibSpeed: 3 }),
    newInstrument('sweep pad', { wave: PULSE, a: 6, d: 10, s: 12, r: 10, pulse: 0x500, pwm: 12, filter: 1, cutoff: 20, res: 8, sweep: 1 }),
    newInstrument('e-piano', { wave: PULSE, a: 0, d: 10, s: 4, r: 9, pulse: 0x300, vibDepth: 1, vibSpeed: 6 }),
    newInstrument('organ', { wave: PULSE, a: 0, d: 0, s: 15, r: 4, pulse: 0x800, vibDepth: 1, vibSpeed: 7 }),
    newInstrument('bell', { wave: TRI, a: 0, d: 11, s: 0, r: 11, vibDepth: 1, vibSpeed: 6 }),
    newInstrument('marimba', { wave: TRI, a: 0, d: 6, s: 0, r: 6 }),
  ] },
  { group: '§0361', instruments: [
    newInstrument('kick', { wave: TRI, a: 0, d: 5, s: 0, r: 5, filter: 1, cutoff: 60, res: 4, sweep: -8 }),
    newInstrument('snare', { wave: NOISE, a: 0, d: 6, s: 0, r: 6, filter: 2, cutoff: 140, res: 4 }),
    newInstrument('tom', { wave: TRI, a: 0, d: 7, s: 0, r: 7, filter: 1, cutoff: 90, sweep: -3 }),
    newInstrument('closed hat', { wave: NOISE, a: 0, d: 2, s: 0, r: 2, filter: 4, cutoff: 200 }),
    newInstrument('open hat', { wave: NOISE, a: 0, d: 7, s: 0, r: 7, filter: 4, cutoff: 200 }),
  ] },
  { group: '§0362', instruments: [
    newInstrument('zap', { wave: PULSE, a: 0, d: 7, s: 0, r: 6, pulse: 0x200, filter: 2, cutoff: 255, res: 15, sweep: -12 }),
    newInstrument('laser', { wave: SAW, a: 0, d: 6, s: 0, r: 5, arp1: 12, arp2: 7, filter: 1, cutoff: 255, res: 10, sweep: -20 }),
    newInstrument('shot', { wave: NOISE, a: 0, d: 5, s: 0, r: 5, filter: 1, cutoff: 255, res: 6, sweep: -24 }),
    newInstrument('explosion', { wave: NOISE, a: 0, d: 11, s: 0, r: 11, filter: 1, cutoff: 140, res: 10, sweep: -2 }),
    newInstrument('hit', { wave: NOISE, a: 0, d: 4, s: 0, r: 4, filter: 1, cutoff: 90, res: 6, sweep: -6 }),
    newInstrument('coin', { wave: PULSE, a: 0, d: 8, s: 0, r: 8, pulse: 0x800, arp1: 5 }),
    newInstrument('power up', { wave: PULSE, a: 0, d: 9, s: 6, r: 8, pulse: 0x400, pwm: 30, arp1: 7, arp2: 12, vibDepth: 2, vibSpeed: 8 }),
    newInstrument('blip', { wave: PULSE, a: 0, d: 2, s: 0, r: 2, pulse: 0x800 }),
    newInstrument('alarm', { wave: PULSE, a: 0, d: 0, s: 15, r: 3, pulse: 0x800, arp1: 3 }),
    newInstrument('ufo', { wave: PULSE, a: 2, d: 0, s: 15, r: 8, pulse: 0x400, pwm: 80, vibDepth: 15, vibSpeed: 15 }),
  ] },
  { group: '§0363', instruments: [
    newInstrument('wind', { wave: NOISE, a: 10, d: 10, s: 10, r: 11, filter: 2, cutoff: 60, res: 12, sweep: 1 }),
    newInstrument('thunder', { wave: NOISE, a: 2, d: 13, s: 0, r: 13, filter: 1, cutoff: 50, res: 12, sweep: -1 }),
    newInstrument('surf', { wave: NOISE, a: 11, d: 11, s: 6, r: 12, filter: 1, cutoff: 30, res: 6, sweep: 1 }),
    newInstrument('rain', { wave: NOISE, a: 4, d: 0, s: 6, r: 8, filter: 4, cutoff: 220, res: 2 }),
    newInstrument('engine', { wave: PULSE, a: 2, d: 0, s: 15, r: 6, pulse: 0x100, pwm: 60, filter: 1, cutoff: 40, res: 10 }),
    newInstrument('bubble', { wave: TRI, a: 0, d: 5, s: 0, r: 5, filter: 2, cutoff: 30, res: 15, sweep: 12 }),
    newInstrument('bird', { wave: TRI, a: 1, d: 6, s: 0, r: 5, arp1: 12, vibDepth: 15, vibSpeed: 12 }),
    newInstrument('heartbeat', { wave: TRI, a: 0, d: 4, s: 0, r: 4, filter: 1, cutoff: 30, res: 8, sweep: -2 }),
  ] },
];

export const newPattern = (rows, voices = VOICES) => new Uint8Array(rows * voices * CELL);

export function newSong() {
  return {
    tempo: 6, rows: 32, loop: 0, voices: VOICES, game: [0, 1, 2], orders: [0], patterns: [newPattern(32)], tables: newTables(),
    instruments: [
      newInstrument('lead', { wave: 0x40, a: 0, d: 9, s: 10, r: 9, pulse: 2048, pwm: 24, vibDepth: 3, vibSpeed: 5 }),
      newInstrument('bass', { wave: 0x20, a: 0, d: 8, s: 6, r: 6 }),
      newInstrument('soft', { wave: 0x10, a: 2, d: 8, s: 12, r: 10, vibDepth: 2, vibSpeed: 4 }),
      newInstrument('hihat', { wave: 0x80, a: 0, d: 3, s: 0, r: 3 }),
    ],
  };
}

export const cloneSong = s => ({ ...s, game: [...s.game], orders: [...s.orders], patterns: s.patterns.map(p => p.slice()), instruments: s.instruments.map(i => ({ ...i })),
  tables: Object.fromEntries(TABLES.map(k => [k, (s.tables?.[k] ?? []).map(r => [...r])])) });

// the bits of an instrument's waveform besides the waveform: sync and ring modulation (version 5)
export const SYNC = 0x02, RING = 0x04;
const WAVE_KEPT = 0xf0 | SYNC | RING;
export const usesRingSync = song => song.instruments.some(i => i.wave & (SYNC | RING));

// a song that needs the tables: an instrument points into one, a table has rows, a command of the
// speed table plays - it is written as version 4
export function usesTables(song) {
  if (TABLES.some(k => song.tables?.[k]?.length)) return true;
  if (song.instruments.some(i => i.waveTab || i.pulseTab || i.filterTab || i.vibTab)) return true;
  return song.patterns.some(p => { for (let o = 2; o < p.length; o += CELL) if (p[o] >= CMD_UP_T && p[o] <= CMD_VIB_T) return true; return false; });
}

// the cell of a voice in a row: its offset in the pattern of a song of `voices` voices
export const cellOffset = (row, voice, voices = VOICES) => (row * voices + voice) * CELL;

// patterns of `rows` rows: shorter ones are filled with empty rows, longer ones cut
export function setRows(song, rows) {
  song.patterns = song.patterns.map(p => { const n = newPattern(rows, song.voices); n.set(p.subarray(0, n.length)); return n; });
  song.rows = rows;
}

// a song of three voices: the voices `list` of the song (-1 or none: a silent voice), with the
// same orders and instruments. globals: the tempo, pattern end and volume commands of the other
// voices come along, in a cell without a command - the SIDs of the editor that play a song of
// more voices keep in step
const GLOBAL_COMMANDS = [CMD_TEMPO, CMD_BREAK, CMD_VOLUME];
export function pickVoices(song, list, { globals = false } = {}) {
  const n = song.voices, voices = [0, 1, 2].map(k => (list[k] >= 0 && list[k] < n ? list[k] : -1));
  const patterns = song.patterns.map(p => {
    const q = newPattern(song.rows);
    for (let r = 0; r < song.rows; r++) {
      voices.forEach((v, k) => { if (v >= 0) q.set(p.subarray(cellOffset(r, v, n), cellOffset(r, v, n) + CELL), cellOffset(r, k)); });
      if (!globals) continue;
      for (let v = 0; v < n; v++) {
        const o = cellOffset(r, v, n);
        if (voices.includes(v) || !GLOBAL_COMMANDS.includes(p[o + 2])) continue;
        const free = [0, 1, 2].find(k => !q[cellOffset(r, k) + 2]);
        if (free != null) q.set([p[o + 2], p[o + 3]], cellOffset(r, free) + 2);
      }
    }
    return q;
  });
  return { ...cloneSong(song), voices: VOICES, game: [0, 1, 2], patterns };
}

// the song as the game plays it: its game voices
export const gameSong = song => (song.voices === VOICES && song.game.join() === '0,1,2' ? song : pickVoices(song, song.game));

const isEmpty = p => p.every(b => !b);

export const encode = song => withTag(songBytes(song));   // the tag of the editor that wrote it at the end (filetag.js)
function songBytes(song) {
  // empty patterns at the end that no order plays are not written
  let np = song.patterns.length;
  while (np > 1 && isEmpty(song.patterns[np - 1]) && !song.orders.includes(np - 1)) np--;
  const ni = song.instruments.length, no = song.orders.length, nv = song.voices, size = song.rows * nv * CELL;
  const version = usesRingSync(song) ? 5 : usesTables(song) ? 4 : nv === VOICES && song.game.join() === '0,1,2' ? 2 : 3;
  const insBytes = version > 3 ? INS_BYTES_4 : INS_BYTES;
  const tables = TABLES.map(k => (song.tables?.[k] ?? []).slice(0, MAX_TABLE_ROWS));
  const tableBytes = version > 3 ? 4 + tables.reduce((n, t) => n + t.length * 2, 0) : 0;
  const bytes = new Uint8Array(HEADER + no + ni * insBytes + np * size + ni * NAME_LENGTH + (version > 2 ? 3 : 0) + tableBytes);
  for (let k = 0; k < 4; k++) bytes[k] = MAGIC.charCodeAt(k);
  bytes.set([version, song.tempo, song.rows, ni, np, no, song.loop === NO_LOOP ? NO_LOOP : Math.min(song.loop, no - 1), version > 2 ? nv : 0], 4);
  let o = HEADER;
  bytes.set(song.orders, o); o += no;
  for (const i of song.instruments) {
    bytes.set([i.wave & (version > 4 ? WAVE_KEPT : 0xf0), (i.a << 4) | i.d, (i.s << 4) | i.r, i.pulse & 255, (i.pulse >> 8) & 15, i.pwm & 255, (i.vibDepth << 4) | i.vibSpeed,
      (i.arp1 << 4) | i.arp2, i.filter ? (i.res << 4) | (i.filter & 7) : 0, i.cutoff & 255, i.sweep & 255, 0], o);
    if (version > 3) bytes.set([i.waveTab ?? 0, i.pulseTab ?? 0, i.filterTab ?? 0, i.vibTab ?? 0, i.vibDelay ?? 0].map(v => v & 255), o + 11);
    o += insBytes;
  }
  for (let k = 0; k < np; k++) { bytes.set(song.patterns[k], o); o += size; }
  for (const i of song.instruments) {
    for (let k = 0; k < NAME_LENGTH; k++) bytes[o + k] = k < i.name.length ? i.name.charCodeAt(k) & 127 : 32;
    o += NAME_LENGTH;
  }
  if (version > 2) { bytes.set([0, 1, 2].map(k => song.game[k] ?? NO_VOICE), o); o += 3; }
  if (version > 3) {
    bytes.set(tables.map(t => t.length), o); o += 4;
    for (const t of tables) for (const [l, r] of t) { bytes[o++] = l & 255; bytes[o++] = r & 255; }
  }
  return bytes;
}

export function decode(bytes) {
  bytes = readTag(bytes).data;
  if (bytes.length < HEADER || String.fromCharCode(...bytes.subarray(0, 4)) !== MAGIC) throw new Error('not a song of the sound editor');
  const version = bytes[4];
  if (version < 1 || version > VERSION) throw new Error(`song version ${version} is not known`);
  const [tempo, rows, ni, np, no, loop] = bytes.subarray(5, 11);
  const voices = version > 2 ? bytes[11] : VOICES;
  if (voices < VOICES || voices > MAX_VOICES) throw new Error(`a song of ${voices} voices`);
  const cell = version === 1 ? 2 : CELL, insBytes = version === 1 ? 8 : version > 3 ? INS_BYTES_4 : INS_BYTES, size = rows * voices * cell;
  if (!rows || !np || !no || bytes.length < HEADER + no + ni * insBytes + np * size) throw new Error('the song file is cut short');
  let o = HEADER;
  const orders = [...bytes.subarray(o, o + no)].map(p => Math.min(p, np - 1)); o += no;
  const instruments = [];
  for (let k = 0; k < ni; k++, o += insBytes) {
    const b = bytes.subarray(o, o + insBytes);
    const i = newInstrument(`instrument ${k + 1}`, { wave: b[0] & (version > 4 ? WAVE_KEPT : 0xf0), a: b[1] >> 4, d: b[1] & 15, s: b[2] >> 4, r: b[2] & 15,
      pulse: b[3] | ((b[4] & 15) << 8), pwm: b[5], vibDepth: b[6] >> 4, vibSpeed: b[6] & 15 });
    if (version > 1) {
      const filter = [1, 2, 4].includes(b[8] & 7) ? b[8] & 7 : 0;
      Object.assign(i, { arp1: b[7] >> 4, arp2: b[7] & 15, filter, res: b[8] >> 4, cutoff: b[9], sweep: (b[10] << 24) >> 24 });
    }
    if (version > 3) Object.assign(i, { waveTab: b[11], pulseTab: b[12], filterTab: b[13], vibTab: b[14], vibDelay: b[15] });
    instruments.push(i);
  }
  const patterns = [];
  for (let k = 0; k < np; k++, o += size) {
    const p = newPattern(rows, voices);
    if (version > 1) p.set(bytes.subarray(o, o + size));
    else for (let c = 0; c < rows * VOICES; c++) p.set(bytes.subarray(o + c * 2, o + c * 2 + 2), c * CELL);
    patterns.push(p);
  }
  for (const i of instruments) {
    if (o + NAME_LENGTH > bytes.length) break;
    i.name = String.fromCharCode(...bytes.subarray(o, o + NAME_LENGTH)).trimEnd() || i.name;
    o += NAME_LENGTH;
  }
  let game = [0, 1, 2];
  if (version > 2) { game = o + 3 <= bytes.length ? [...new Set([...bytes.subarray(o, o + 3)].filter(v => v < voices))] : []; o += 3; }
  const tables = newTables();
  if (version > 3) {
    if (o + 4 > bytes.length) throw new Error('the song file is cut short');
    const counts = [...bytes.subarray(o, o + 4)];
    o += 4;
    TABLES.forEach((k, n) => {
      if (o + counts[n] * 2 > bytes.length) throw new Error('the song file is cut short');
      for (let r = 0; r < counts[n]; r++, o += 2) tables[k].push([bytes[o], bytes[o + 1]]);
    });
  }
  return { tempo: Math.max(1, tempo), rows, loop: loop === NO_LOOP ? NO_LOOP : Math.min(loop, no - 1), voices, game, orders, patterns, instruments, tables };
}

// the notes of the cells [r0..r1] x [v0..v1] of a pattern of `voices` voices moved by semitones;
// notes that leave the range stay
export function transpose(pattern, r0, r1, v0, v1, semitones, voices = VOICES) {
  for (let r = r0; r <= r1; r++) {
    for (let v = v0; v <= v1; v++) {
      const o = cellOffset(r, v, voices), n = pattern[o];
      if (n && n !== NOTE_OFF && n + semitones >= 1 && n + semitones <= NOTES) pattern[o] = n + semitones;
    }
  }
}
