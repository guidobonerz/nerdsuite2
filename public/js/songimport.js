// songimport.js - songs of other programs become songs of the sound editor (song.js):
//   GoatTracker 2 (.sng, 'GTS5')  the patterns, the orderlists of the three channels with their
//       repeats and transposes, the instruments with their envelope and their rows of the four
//       tables, the tables as they are (song.js), and the pattern commands the player knows:
//       portamento up and down, tone portamento and vibrato of the speedtable, cutoff, volume,
//       tempo. Not kept: the other commands, the first waveform and gate timer of an instrument,
//       the channels of a filtertable row (the filter takes the voice of the note), the depth of a
//       vibrato relative to its note (its depth is taken as it is).
//   SID tunes (.sid, PSID / RSID)  a tune is a program, not notes: it runs on a 6502
//       (cpu6502.js) for some seconds, and what it writes to the SID every frame is heard as
//       notes - a gate that rises is a note, the distance of the notes is the tempo. Its sounds
//       become instruments with tables (transcribeSid): what the waveform, the pitch, the pulse
//       width and the filter do frame by frame, a vibrato. Not kept: slides between notes.
//   MIDI files (.mid, .midi, RIFF .rmi)  the notes of all tracks on a grid of rows (a quarter note
//       is some rows). All of them: a voice for every note that sounds at once, up to MAX_VOICES -
//       a voice plays one part (a track's channel), the first voices the most played parts; the
//       game plays three of them, at first the first voice of the three most played parts. Or
//       shared out to three voices: a part keeps its voice while it can, of a chord the highest
//       note wins, a voice that still sounds is not taken. The General MIDI program chooses a
//       ready instrument, the drums (channel 10) become kick, snare, tom and hats. Not kept:
//       velocity, pitch bends, controllers, tempo changes.
// All give { song, notes }: the notes tell what was cut or left out.

import { Cpu } from './cpu6502.js';
import { CLOCK } from './sid.js';
import {
  VOICES, MAX_VOICES, NOTE_OFF, NOTES, MAX_INSTRUMENTS, MAX_PATTERNS, MAX_ORDERS, MAX_TABLE_ROWS, PRESETS, newInstrument, newPattern, newTables, cellOffset,
  CMD_UP_T, CMD_DOWN_T, CMD_GLIDE_T, CMD_VIB_T, CMD_CUTOFF, CMD_VOLUME, CMD_TEMPO,
} from './song.js';

const text = (bytes, from, length) => {
  let s = '';
  for (let k = from; k < from + length && bytes[k]; k++) s += String.fromCharCode(bytes[k]);
  return s.trim();
};
const magic = bytes => String.fromCharCode(...bytes.subarray(0, 4));

// 'song' (of this editor), 'goat', 'sid', 'midi' or null
export function songKind(bytes) {
  const m = magic(bytes);
  return m === 'YSNG' ? 'song' : /^GTS[2-5]$/.test(m) ? 'goat' : m === 'PSID' || m === 'RSID' ? 'sid'
    : m === 'MThd' || (m === 'RIFF' && text(bytes, 8, 4) === 'RMID') ? 'midi' : null;
}

// --- the song from rows -------------------------------------------------------------------------

// the instruments a song can keep: the most played ones; the others play the most similar one.
// used: how often each is played. Gives the kept instruments and the new number (1-15) of each
function reduceInstruments(instruments, used, notes) {
  const order = instruments.map((_, k) => k).filter(k => used[k]).sort((a, b) => used[b] - used[a]);
  const kept = order.slice(0, MAX_INSTRUMENTS).sort((a, b) => a - b);
  const distance = (a, b) => (a.wave === b.wave ? 0 : 100) + Math.abs(a.a - b.a) + Math.abs(a.d - b.d) + Math.abs(a.s - b.s) + Math.abs(a.r - b.r);
  const map = instruments.map((ins, k) => {
    if (!used[k]) return 0;
    const at = kept.indexOf(k);
    if (at >= 0) return at + 1;
    return 1 + kept.reduce((best, c, n) => (distance(ins, instruments[c]) < distance(ins, instruments[kept[best]]) ? n : best), 0);
  });
  if (order.length > kept.length) notes.push(`${order.length} instruments: the ${MAX_INSTRUMENTS} most played stay, the others play the most similar one`);
  return { kept: kept.map(k => instruments[k]), map };
}

// voices: per voice the rows [note, instrument index + 1 or 0, command, value] of the whole song
// - three, or more; game: the voices the game plays; tables: those of the song (song.js)
function buildSong({ tempo, rows, voices, instruments, loopRow = 0, game = [0, 1, 2], tables = newTables() }, notes) {
  const used = instruments.map(() => 0);
  for (const v of voices) for (const c of v) { if (c[1] > instruments.length) c[1] = 0; if (c[0] && c[0] !== NOTE_OFF && c[1]) used[c[1] - 1]++; }
  const { kept, map } = reduceInstruments(instruments, used, notes);
  const length = Math.max(...voices.map(v => v.length));
  const nv = Math.max(VOICES, voices.length);
  const song = { tempo, rows, loop: 0, voices: nv, game, orders: [], patterns: [], instruments: kept.length ? kept : [newInstrument()], tables };
  const known = new Map();
  for (let start = 0; start < length; start += rows) {
    const p = newPattern(rows, nv);
    for (let r = 0; r < rows; r++) {
      for (let v = 0; v < voices.length; v++) {
        const [note, ins, cmd = 0, value = 0] = voices[v][start + r] ?? [0, 0];
        p.set([note, note && note !== NOTE_OFF && ins ? map[ins - 1] : 0, cmd, value], cellOffset(r, v, nv));
      }
    }
    const key = p.join(',');
    if (!known.has(key)) {
      if (song.patterns.length >= MAX_PATTERNS) { notes.push(`more than ${MAX_PATTERNS} different patterns: the song ends after ${song.orders.length} positions`); break; }
      known.set(key, song.patterns.length);
      song.patterns.push(p);
    }
    if (song.orders.length >= MAX_ORDERS) { notes.push(`more than ${MAX_ORDERS} positions: the end of the song is cut`); break; }
    song.orders.push(known.get(key));
  }
  if (!song.orders.length) { song.orders = [0]; song.patterns = [newPattern(rows, nv)]; }
  song.loop = Math.min(Math.floor(loopRow / rows), song.orders.length - 1);
  return song;
}

// --- GoatTracker ----------------------------------------------------------------------------------

const GT_FIRST_NOTE = 0x60, GT_LAST_NOTE = 0xbc, GT_KEYOFF = 0xbe, GT_END = 0xff, MAX_ROWS = 8192;

export function importGoat(bytes) {
  if (magic(bytes) !== 'GTS5') throw new Error(`a GoatTracker song of the old format ${magic(bytes)}: load and save it with GoatTracker 2 first`);
  const notes = [];
  let o = 4 + 32 * 3;
  const title = text(bytes, 4, 32);
  const subtunes = bytes[o++];
  const orderlists = [];
  for (let k = 0; k < subtunes * VOICES; k++) { const n = bytes[o++]; orderlists.push(bytes.subarray(o, o + n + 1)); o += n + 1; }
  if (subtunes > 1) notes.push(`${subtunes} subtunes: the first one is imported`);

  const gt = [];
  for (let n = bytes[o++]; n > 0; n--, o += 25) {
    gt.push({ ad: bytes[o], sr: bytes[o + 1], wave: bytes[o + 2], pulse: bytes[o + 3], filter: bytes[o + 4], vib: bytes[o + 5], vibDelay: bytes[o + 6],
      name: text(bytes, o + 9, 16) });
  }
  const tables = [];                       // wave, pulse, filter, speed: the left and the right column
  for (let t = 0; t < 4; t++) { const n = bytes[o++]; tables.push({ left: bytes.subarray(o, o + n), right: bytes.subarray(o + n, o + 2 * n) }); o += 2 * n; }
  const patterns = [];
  for (let n = bytes[o++]; n > 0; n--) { const rows = bytes[o++]; patterns.push(bytes.subarray(o, o + rows * 4)); o += rows * 4; }
  if (o > bytes.length) throw new Error('the GoatTracker song is cut short');

  const [waveTable, pulseTable, , speedTable] = tables;
  // the tables as they are: rows [left, right]; the instruments point at their rows
  const songTables = newTables();
  ['wave', 'pulse', 'filter', 'speed'].forEach((k, t) => { songTables[k] = [...tables[t].left].map((l, n) => [l, tables[t].right[n]]); });
  // a vibrato of the speedtable: bit 7 of its left byte (a depth relative to the note) is dropped
  const vibratoRow = n => { const r = songTables.speed[n - 1]; if (r && r[0] & 0x80) { r[0] &= 0x7f; relative = true; } };
  let relative = false;
  const instruments = gt.map((g, k) => {
    const ins = newInstrument((g.name || `instrument ${k + 1}`).slice(0, 12), { a: g.ad >> 4, d: g.ad & 15, s: g.sr >> 4, r: g.sr & 15, wave: 0x40, pulse: 2048,
      waveTab: g.wave, pulseTab: g.pulse, filterTab: g.filter, vibTab: g.vib, vibDelay: g.vibDelay });
    if (g.vib) vibratoRow(g.vib);
    // what the instrument shows without its tables: the waveform its wavetable settles on, the first width
    // the wavetable: the waveform it settles on, the last one before it jumps or ends
    for (let p = g.wave, steps = 0; p >= 1 && p <= waveTable.left.length && steps < 32; p++, steps++) {
      const l = waveTable.left[p - 1];
      if (l === 0xff) break;
      if (l >= 0x10 && l <= 0xdf && (l & 0xf0)) ins.wave = l & 0xf0;
    }
    // the pulsetable: the first width it sets, the first speed it moves with
    let width = null;
    for (let p = g.pulse, steps = 0; p >= 1 && p <= pulseTable.left.length && steps < 32; p++, steps++) {
      const l = pulseTable.left[p - 1], r = pulseTable.right[p - 1];
      if (l === 0xff) break;
      if (l >= 0x80) width ??= ((l & 15) << 8) | r;
      else if (l && !ins.pwm) ins.pwm = Math.abs(r < 128 ? r : r - 256);
    }
    if (width != null) ins.pulse = width;
    return ins;
  });
  void speedTable;
  // the commands of GoatTracker the player has: 1-4 of the speedtable, cutoff, volume, tempo
  const dropped = new Set();
  const command = (c, d) => {
    switch (c) {
      case 0: return [0, 0];
      case 1: return [CMD_UP_T, d];
      case 2: return [CMD_DOWN_T, d];
      case 3: return d ? [CMD_GLIDE_T, d] : [0, 0];          // 300: a tied note - none
      case 4: if (d) vibratoRow(d); return [CMD_VIB_T, d];
      case 0x0c: return [CMD_CUTOFF, d];
      case 0x0d: return [CMD_VOLUME, d & 15];
      case 0x0f: return (d & 0x7f) >= 3 ? [CMD_TEMPO, d & 0x7f] : (dropped.add('funktempo'), [0, 0]);
      default: dropped.add(c.toString(16).toUpperCase()); return [0, 0];
    }
  };

  // a channel as rows: its orderlist with the repeats and transposes, to its end mark
  let tempo = null;
  const lengths = new Map();
  function channel(list, wanted) {
    const rows = [];
    const end = list.indexOf(GT_END), restart = end >= 0 ? list[end + 1] ?? 0 : 0;
    let restartRow = 0, transposeBy = 0, repeat = 1;
    const run = (from, to) => {
      for (let k = from; k < to && rows.length < MAX_ROWS; k++) {
        const b = list[k];
        if (k === restart && from === 0) restartRow = rows.length;
        if (b >= 0xe0) transposeBy = b - 0xf0;
        else if (b >= 0xd0) repeat = (b & 15) || 16;
        else {
          const p = patterns[b];
          for (; repeat > 0; repeat--) {
            for (let q = 0; p && q < p.length && p[q] !== GT_END; q += 4) {
              const n = p[q];
              if (p[q + 2] === 0x0f && tempo == null && (p[q + 3] & 0x7f) >= 3) tempo = p[q + 3] & 0x7f;
              const note = n >= GT_FIRST_NOTE && n <= GT_LAST_NOTE ? Math.max(1, Math.min(NOTES, n - GT_FIRST_NOTE + 1 + transposeBy)) : n === GT_KEYOFF ? NOTE_OFF : 0;
              rows.push([note, note && note !== NOTE_OFF ? p[q + 1] & 0x3f : 0, ...command(p[q + 2], p[q + 3])]);
            }
          }
          if (p) lengths.set(p.length / 4 - 1, (lengths.get(p.length / 4 - 1) ?? 0) + 1);
          repeat = 1;
        }
      }
    };
    run(0, end < 0 ? list.length : end);
    // a shorter channel goes on from its restart position
    while (wanted && rows.length < wanted && restart < end && rows.length > restartRow) { const before = rows.length; run(restart, end); if (rows.length === before) break; }
    return { rows: wanted ? rows.slice(0, wanted) : rows, restartRow };
  }
  const first = orderlists.slice(0, VOICES).map(l => channel(l, 0));
  const length = Math.max(...first.map(c => c.rows.length));
  const voices = orderlists.slice(0, VOICES).map((l, k) => (first[k].rows.length < length ? channel(l, length).rows : first[k].rows));
  if (length >= MAX_ROWS) notes.push(`the song is cut after ${MAX_ROWS} rows`);
  // the rows of a pattern: what most patterns of the song have
  const common = [...lengths].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 32;
  const rows = common >= 8 && common <= 64 ? common : 32;
  const song = buildSong({ tempo: tempo ?? 6, rows, voices, instruments, loopRow: first[0].restartRow, tables: songTables }, notes);
  notes.unshift(`GoatTracker song${title ? ` "${title}"` : ''}: the instruments and their tables as they are`);
  if (dropped.size) notes.push(`commands not imported: ${[...dropped].join(', ')}`);
  if (relative) notes.push('a vibrato with a depth relative to its note plays its depth as it is');
  return { song, notes };
}

// --- SID tunes ------------------------------------------------------------------------------------

const word = (bytes, o) => (bytes[o] << 8) | bytes[o + 1];

export function sidInfo(bytes) {
  if (songKind(bytes) !== 'sid') throw new Error('not a SID tune');
  return { title: text(bytes, 0x16, 32), author: text(bytes, 0x36, 32), songs: Math.max(1, word(bytes, 0x0e)), start: Math.max(1, word(bytes, 0x10)) };
}

// the frames of the tune: per frame and voice what the SID registers hold
function runTune(bytes, subtune, frames, notes) {
  let data = bytes.subarray(word(bytes, 6)), load = word(bytes, 8);
  const init = word(bytes, 0x0a), play = word(bytes, 0x0c);
  if (!load) { load = data[0] | (data[1] << 8); data = data.subarray(2); }
  if (load + data.length > 0x10000) throw new Error('the tune does not fit the memory');
  const mem = new Uint8Array(0x10000);
  // the end of the Kernal's interrupt, for tunes that leave through it
  mem.set([0x4c, 0x81, 0xea], 0xea31);
  mem.set([0xad, 0x0d, 0xdc, 0x68, 0xa8, 0x68, 0xaa, 0x68, 0x40], 0xea7e);
  mem.set(data, load);
  mem[1] = 0x37;
  const regs = new Uint8Array(32);
  // a tune that waits for a raster line goes on: the line moves with every read of it - its low
  // byte in $d012, its 9th bit in bit 7 of $d011 (the 312 lines of PAL)
  // A tune that measures the machine (PAL or NTSC) with an NMI of timer A of CIA 2 gets one when
  // it lets the timer and its NMI run - once. The NMIs of samples are not heard here: an NMI
  // that runs code in the registers of a CIA (a vector to $dc04) does not come
  let raster = 0, nmiMask = 0, timerOn = false;
  const nmi = (mask, on) => {
    const vector = mem[0xfffa] | (mem[0xfffb] << 8);
    if (mask & 1 && on && !(nmiMask & 1 && timerOn) && (vector < 0xd000 || vector >= 0xe000)) cpu.nmiPending = true;
    nmiMask = mask; timerOn = on;
  };
  const cpu = new Cpu(mem, {
    onwrite: (a, v) => {
      if (a >= 0xd400 && a < 0xd800) regs[a & 31] = v;
      else if (a === 0xdd0d) nmi(v & 0x80 ? nmiMask | (v & 0x1f) : nmiMask & ~v, timerOn);
      else if (a === 0xdd0e) nmi(nmiMask, !!(v & 1));
    },
    onread: a => {
      if (a !== 0xd011 && a !== 0xd012) return undefined;
      raster = (raster + 7) % 312;
      return a === 0xd012 ? raster & 255 : (mem[0xd011] & 0x7f) | (raster & 0x100 ? 0x80 : 0);
    },
  });
  const returned = cpu.call(init || load, { a: subtune - 1, max: 5000000 });
  let routine = play, asIrq = false, kernal = false;
  if (!routine) {                           // the tune set up an interrupt: that is its player
    asIrq = true;
    const soft = mem[0x314] | (mem[0x315] << 8), hard = mem[0xfffe] | (mem[0xffff] << 8);
    if (soft >= load && soft < load + data.length) { routine = soft; kernal = true; } else routine = hard;
    if (!routine) throw new Error('the tune has no play routine and sets no interrupt');
  }
  if (!returned && play) notes.push('the init routine of the tune did not end');
  const out = [];
  let failed = 0;
  for (let f = 0; f < frames; f++) {
    if (!cpu.call(routine, { max: 200000, asIrq, kernal })) failed++;
    const voices = Array.from({ length: VOICES }, (_, v) => {
      const b = v * 7;
      return { freq: regs[b] | (regs[b + 1] << 8), pulse: regs[b + 2] | ((regs[b + 3] & 15) << 8), ctrl: regs[b + 4], ad: regs[b + 5], sr: regs[b + 6] };
    });
    // the filter: the cutoff (its high 8 bits), the resonance, the voices through it, its type
    voices.filter = { cut: regs[22], res: regs[23] >> 4, route: regs[23] & 7, mode: (regs[24] >> 4) & 7 };
    out.push(voices);
  }
  if (failed > frames / 2) throw new Error('the play routine of the tune does not run here');
  if (cpu.unknown) notes.push('the tune uses opcodes this 6502 does not know: notes may be wrong');
  return out;
}

const noteOf = freq => Math.max(1, Math.min(NOTES, Math.round(12 * Math.log2(Math.max(1, freq) * CLOCK / 16777216 / 440)) + 58));

// the frames a row lasts: the longest that (nearly) all notes start on
function findTempo(onsets) {
  if (onsets.length < 4) return { tempo: 6, offset: onsets[0] ?? 0 };
  for (let t = 24; t > 1; t--) {
    const hits = new Array(t).fill(0);
    for (const f of onsets) hits[f % t]++;
    const best = hits.indexOf(Math.max(...hits));
    if (hits[best] >= onsets.length * 0.95) return { tempo: t, offset: best };
  }
  return { tempo: 1, offset: 0 };
}

// --- the sounds of a SID tune as instruments with tables ------------------------------------------
// The notes of the tune are grouped by their sound: the envelope, the waveforms and the pitches of
// their first frames, the width of a pulse and whether the voice goes through the filter. A group
// is an instrument; one of its notes, the longest, gives its tables - a step a frame, like the
// player of the editor runs them (song.js):
//   wave    the waveform and the pitch of each frame: relative to the note, or fixed notes when
//           the notes of the group play the same pitches whatever their note (a drum); a value
//           that stays is a wait, an arpeggio that comes round again a jump back to it
//   pulse   the width of the first frame, then sweeps - so many frames of a step - and a jump
//           back when they come round again
//   filter  the type and the resonance, the cutoff of the first frame, then its sweeps
//   speed   a vibrato: the frames of a half wave and the step of the frequency a frame
const PROFILE = 128;                        // the frames of a note looked at
const SHAPE = 8;                            // ... and those that tell its sound
const MAX_WAVE_ROWS = 32;                   // the rows of a wave table at most

const semitone = freq => 12 * Math.log2(Math.max(1, freq) * CLOCK / 16777216 / 440) + 57;    // C-0 = 0
// the pitch of a frame as a note (C-0 = 0), or null between two notes (a slide, a wide vibrato)
const pitchOf = freq => { const s = semitone(freq), n = Math.round(s); return Math.abs(s - n) < 0.3 ? Math.max(0, Math.min(NOTES - 1, n)) : null; };
// the waveform with sync, ring and test (all four waveforms are three: F0-FE are no waveforms in a table); 0: none
const waveOf = ctrl => (!(ctrl & 0xf0) ? 0 : (ctrl & 0xf0) === 0xf0 ? 0xe0 | (ctrl & 0x0e) : ctrl & 0xfe);
const signed12 = d => ((d + 2048) & 4095) - 2048;
const signed8 = d => ((d + 128) & 255) - 128;

// the first frame from that a list repeats with a period: { start, period } - the shortest, at
// least twice in the list - or null. same(a, b): two entries are alike
function cycleOf(list, maxPeriod, same = (a, b) => a === b) {
  for (let start = 0; start < list.length; start++) {
    for (let period = 2; period <= maxPeriod && start + 2 * period <= list.length; period++) {
      let ok = true;
      for (let i = start + period; i < list.length && ok; i++) ok = same(list[i], list[i - period]);
      if (ok) return { start, period };
    }
  }
  return null;
}

// sweeps: a value a frame (12 or 8 bits) as steps of up to 127 a frame, each for up to 127
// frames - [frames, step]; a jump: none. set(v) a row that sets the value
function sweepRows(values, bits, setRow) {
  const wrap = bits === 12 ? signed12 : signed8;
  const segments = [];                      // [frames, step] or ['set', value]
  for (let i = 1; i < values.length; i++) {
    const d = wrap(values[i] - values[i - 1]);
    if (Math.abs(d) > 127) { segments.push(['set', values[i]]); continue; }
    const last = segments[segments.length - 1];
    if (last && last[0] !== 'set' && last[1] === d && last[0] < 127) last[0]++;
    else segments.push([1, d]);
  }
  while (segments.length && segments[segments.length - 1][0] !== 'set' && segments[segments.length - 1][1] === 0) segments.pop();   // it stays: the end
  // sweeps that come round again: the last one may be cut by the end of the note
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  const cycle = segments.length >= 4 ? cycleOf(segments.slice(0, -1), 6, same) : null;
  const used = cycle ? segments.slice(0, cycle.start + cycle.period) : segments;
  const rows = [setRow(values[0]), ...used.map(s => (s[0] === 'set' ? setRow(s[1]) : [s[0], s[1] & 255]))];
  return { rows, loop: cycle ? cycle.start + 2 : 0 };        // loop: the row to jump back to (the set row is the first), 0: the end
}

// the wave table of a note: [wave, pitch] a frame - pitch a note (fixed) or a step from the note
function waveRows(seq, fixed) {
  const code = p => (fixed ? 0x81 + Math.max(0, Math.min(0x5e, p - 1)) : p >= 0 ? Math.min(0x5f, p) : 0x80 + Math.max(-32, p));
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  let last = seq.length - 1;                // the value it settles on
  while (last > 0 && same(seq[last], seq[last - 1])) last--;
  const steady = seq.length - last >= 3;
  const cycle = steady ? null : cycleOf(seq, 16, same);
  const rows = [], rowAt = [];
  const emit = (from, to) => {              // frames from..to-1: a row each value, a wait for the frames it stays
    for (let i = from; i < to;) {
      let j = i + 1;
      while (j < to && same(seq[j], seq[i])) j++;
      rowAt[i] = rows.length;
      rows.push([seq[i][0], code(seq[i][1])]);
      for (let hold = j - i - 1; hold > 0; hold -= 15) rows.push([Math.min(15, hold), 0]);
      i = j;
    }
  };
  if (cycle) {
    emit(0, cycle.start);
    emit(cycle.start, cycle.start + cycle.period);
    if (rows.length < MAX_WAVE_ROWS) return { rows, loop: rowAt[cycle.start] + 1 };
    rows.length = 0;
  }
  emit(0, Math.min(seq.length, (steady ? last : seq.length - 1) + 1));
  if (rows.length > MAX_WAVE_ROWS) rows.length = MAX_WAVE_ROWS;
  return { rows, loop: 0 };
}

// a vibrato of a note that stays on its pitch: [frames of a half wave, step a frame, delay]
function vibratoOf(freqs) {
  // around its note: a slide goes further than a semitone
  const pitches = freqs.map(semitone);
  if (Math.max(...pitches) - Math.min(...pitches) > 1.2) return null;
  const steps = [];
  for (let i = 1; i < freqs.length; i++) steps.push(freqs[i] - freqs[i - 1]);
  const first = steps.findIndex(d => d !== 0);
  if (first < 0) return null;
  const runs = [];
  let sign = 0, run = 0;
  for (const d of steps.slice(first)) {
    const s = Math.sign(d) || sign;
    if (s === sign) run++;
    else { if (sign) runs.push(run); sign = s; run = 1; }
  }
  if (runs.length < 2) return null;         // a slide, not a vibrato
  const median = list => [...list].sort((a, b) => a - b)[list.length >> 1];
  const step = median(steps.filter(d => d).map(Math.abs));
  return [Math.max(1, Math.min(127, median(runs))), Math.max(1, Math.min(255, step)), Math.min(255, first)];
}

export function transcribeSid(frames, { tempo: givenTempo = null } = {}) {
  const notes = [];
  const gate = (f, v) => (f >= 0 && f < frames.length ? frames[f][v].ctrl & 1 : 0);
  // a note starts when the gate rises - or when, the gate held, the waveform goes for a frame: a
  // restart of the oscillator (and its test bit) for the next note without a release
  const restarts = (f, v) => f > 0 && gate(f, v) && gate(f - 1, v) && !(frames[f][v].ctrl & 0xf0) && frames[f - 1][v].ctrl & 0xf0;
  const rises = [], falls = [];
  for (let v = 0; v < VOICES; v++) {
    rises.push([]); falls.push([]);
    for (let f = 0; f < frames.length; f++) {
      if ((gate(f, v) && !gate(f - 1, v)) || restarts(f, v)) rises[v].push(f);
      if (!gate(f, v) && gate(f - 1, v)) falls[v].push(f);
    }
  }
  const { tempo, offset } = givenTempo ? { tempo: givenTempo, offset: rises.flat().sort((a, b) => a - b)[0] ?? 0 } : findTempo(rises.flat().sort((a, b) => a - b));
  const count = Math.min(MAX_ROWS, Math.ceil((frames.length - offset) / tempo));
  const rowOf = f => Math.floor((f - offset) / tempo);

  // every note: its voice, its frames, its note (after the first frames: the click of a drum, a
  // hard restart), what its frames do
  const all = [];
  for (let v = 0; v < VOICES; v++) {
    rises[v].forEach((f, k) => {
      const end = Math.min(rises[v][k + 1] ?? frames.length, falls[v].find(x => x > f) ?? frames.length);
      // its sound lasts to the next note: a release goes on with its waveform and its pitch (a
      // gate of a frame, then the release, is a sound too) - but not the hard restart before it
      const next = rises[v][k + 1] ?? frames.length;
      let len = Math.min(PROFILE, next - f);
      const restart = c => !(c & 1) && (!(c & 0xf0) || c & 8);
      while (len > 1 && f + len - 1 >= end && restart(frames[f + len - 1][v].ctrl)) len--;
      const fr = i => frames[f + i][v], filt = frames[f + Math.min(1, len - 1)].filter;
      const waves = [], pitches = [];
      // a frame without a waveform or with the test bit is not heard: its pitch is none
      for (let i = 0; i < len; i++) { const w = waveOf(fr(i).ctrl); waves.push(w); pitches.push(w && !(w & 8) ? pitchOf(fr(i).freq) : null); }
      // its note: the pitch its first frames have most with a tone (not noise, not a hard restart),
      // the first of them - the root of an arpeggio; else after the first frames
      const heard = new Map();
      for (let i = 0; i < Math.min(len, SHAPE); i++) if (waves[i] && !(waves[i] & 0x88) && pitches[i] != null) heard.set(pitches[i], (heard.get(pitches[i]) ?? 0) + 1);
      const at = Math.min(end - 1, f + Math.min(2, tempo - 1));
      const base = heard.size ? [...heard].reduce((a, b) => (b[1] > a[1] ? b : a))[0] : noteOf(frames[at][v].freq) - 1;
      const s = fr(Math.min(1, len - 1));
      const routed = !!(filt && filt.route & (1 << v) && filt.mode);
      const rel = pitches.slice(0, SHAPE).map(p => (p == null ? 'x' : p - base)), fix = pitches.slice(0, SHAPE).map(p => p ?? 'x');
      const main = waves.find(w => w & 0xf0 && !(w & 8)) ?? waves.find(w => w) ?? 0x40;
      // the sound is told by the frames its gate is on: the release and the hard restart of the
      // next note come as early as the note is short - a note of a row is the same sound
      const shape = Math.max(1, Math.min(SHAPE, len, end - f));
      const kind = [s.ad, s.sr, main & 0x40 ? s.pulse >> 8 : '-', routed ? filt.mode : 0].join(':');
      const sound = `${kind}:${waves.slice(0, shape).join(',')}`;
      all.push({ v, f, end, len, base, at, kind, shape, keyRel: `${sound}|${rel.slice(0, shape).join(',')}`, keyFix: `${sound}|${fix.slice(0, shape).join(',')}`,
        waves, pitches, rel, main, ad: s.ad, sr: s.sr, routed });
    });
  }
  // the groups: the same sound and the same steps from the note; groups whose notes play the same
  // pitches whatever their note are one, with fixed notes (a drum on several notes)
  const groups = new Map();
  for (const n of all) {
    if (!groups.has(n.keyRel)) groups.set(n.keyRel, { notes: [], guests: [], fixed: false, first: n.f + n.v / 4 });
    groups.get(n.keyRel).notes.push(n);
  }
  // a group of short notes is the sound of the longer ones that begin like them: into the most
  // played of those (the longest first, so a group a frame shorter does not take them)
  const begins = (short, long) => short.kind === long.kind && short.shape < long.shape
    && short.waves.slice(0, short.shape).every((w, i) => w === long.waves[i]) && short.rel.slice(0, short.shape).every((p, i) => p === long.rel[i]);
  for (const [key, g] of [...groups].sort((a, b) => b[1].notes[0].shape - a[1].notes[0].shape)) {
    const n = g.notes[0];
    if (n.shape >= SHAPE || !groups.has(key)) continue;
    let into = null;
    for (const h of groups.values()) if (h !== g && begins(n, h.notes[0]) && (!into || h.notes.length > into.notes.length)) into = h;
    if (!into) continue;
    into.notes.push(...g.notes);
    into.first = Math.min(into.first, g.first);
    groups.delete(key);
  }
  const byFix = new Map();
  for (const [key, g] of groups) {
    const fix = new Set(g.notes.map(n => n.keyFix));
    if (fix.size !== 1 || g.notes[0].keyFix.includes('x')) continue;
    const k = [...fix][0];
    if (byFix.has(k)) {
      const into = byFix.get(k);
      into.notes.push(...g.notes); into.fixed = true; into.first = Math.min(into.first, g.first);
      groups.delete(key);
    } else byFix.set(k, g);
  }
  // the instruments: the groups heard longest - their frames, not their notes: a long note of its
  // own sound counts as much as many short ones; a note of another one plays the most like it
  const heardFor = g => g.notes.reduce((sum, n) => sum + (n.end - n.f), 0);
  const list = [...groups.values()].sort((a, b) => heardFor(b) - heardFor(a));
  const kept = list.slice(0, MAX_INSTRUMENTS).sort((a, b) => a.first - b.first);
  // how unlike two sounds are: their first frames - the waveforms, the steps from the note - then
  // the filter and the envelope
  const distance = (a, b) => {
    let d = (a.routed === b.routed ? 0 : 20) + Math.abs((a.ad >> 4) - (b.ad >> 4)) + Math.abs((a.ad & 15) - (b.ad & 15))
      + Math.abs((a.sr >> 4) - (b.sr >> 4)) + Math.abs((a.sr & 15) - (b.sr & 15));
    for (let i = 0; i < SHAPE; i++) d += ((a.waves[i] ?? 0) === (b.waves[i] ?? 0) ? 0 : 12) + (a.rel[i] === b.rel[i] ? 0 : 6);
    return d;
  };
  for (const g of list.slice(MAX_INSTRUMENTS)) {
    const like = kept.reduce((best, k) => (distance(g.notes[0], k.notes[0]) < distance(g.notes[0], best.notes[0]) ? k : best), kept[0]);
    like.guests.push(...g.notes);         // they play it, they do not make it: its tables are its own notes'
  }
  if (list.length > MAX_INSTRUMENTS) notes.push(`${list.length} sounds: the ${list.length - MAX_INSTRUMENTS} heard least play the most similar of ${MAX_INSTRUMENTS}`);

  const tables = newTables();
  let full = false;
  const put = (table, made) => {            // the rows of a table, a jump back or the end; their first row, 0: no room
    if (!made.rows.length) return 0;
    if (tables[table].length + made.rows.length + 1 > MAX_TABLE_ROWS) { full = true; return 0; }
    const first = tables[table].length + 1;
    tables[table].push(...made.rows, [0xff, made.loop ? first + made.loop - 1 : 0]);
    return first;
  };
  const speedRow = row => {                 // a row of the speed table, the same one once
    const k = tables.speed.findIndex(r => r[0] === row[0] && r[1] === row[1]);
    if (k >= 0) return k + 1;
    if (tables.speed.length >= MAX_TABLE_ROWS) { full = true; return 0; }
    tables.speed.push(row);
    return tables.speed.length;
  };
  const names = { 0x10: 'tri', 0x20: 'saw', 0x40: 'pulse', 0x80: 'noise' };
  const instruments = kept.map((g, k) => {
    const rep = g.notes.reduce((a, b) => (b.len > a.len ? b : a));
      const v = rep.v, fr = i => frames[rep.f + i][v];
    const ins = newInstrument(`${names[rep.main & 0xf0] ?? 'mix'} ${k + 1}`, { wave: rep.main & 0xf0, a: rep.ad >> 4, d: rep.ad & 15, s: rep.sr >> 4, r: rep.sr & 15,
      pulse: rep.main & 0x40 ? fr(Math.min(1, rep.len - 1)).pulse : 2048 });
    // the wave table: the waveform and the pitch of each frame - fixed notes for a drum (it starts
    // with noise and its pitch moves: its note does not matter) and for notes alike on any note
    const fixed = g.fixed || (!!(rep.waves[0] & 0x80) && rep.pitches.some(p => p != null && p !== rep.pitches[0]));
    // as far as the notes of the sound agree: beyond that the longest note does what only it does
    // (a slide of its own), and the table stays on its last step
    let agreed = rep.len;
    for (let i = SHAPE; i < rep.len && agreed === rep.len; i++) {
      const pitchAt = n => (n.pitches[i] == null ? null : fixed ? n.pitches[i] : n.pitches[i] - n.base);
      const there = g.notes.filter(n => n.len > i);
      const alike = there.filter(n => n.waves[i] === rep.waves[i] && (pitchAt(n) == null || pitchAt(rep) == null || pitchAt(n) === pitchAt(rep)));
      if (there.length >= 2 && alike.length < there.length * 0.8) agreed = i;
    }
    const seq = [];
    let wave = rep.main, pitch = fixed ? rep.pitches.find(p => p != null) ?? rep.base : 0;
    for (let i = 0; i < agreed; i++) {
      if (rep.waves[i]) wave = rep.waves[i];
      if (rep.pitches[i] != null) pitch = fixed ? rep.pitches[i] : rep.pitches[i] - rep.base;
      seq.push([wave, pitch]);
    }
    const plain = !fixed && seq.every(([w, p]) => w === (rep.main & 0xf0) && p === 0);   // the instrument alone does it
    if (!plain) ins.waveTab = put('wave', waveRows(seq, fixed));
    const moves = seq.some(([, p]) => p !== seq[0][1]);
    g.pitchMoves = moves;
    // the pulse table: when the width moves
    if (seq.some(([w]) => w & 0x40)) {
      const widths = Array.from({ length: rep.len }, (_, i) => fr(i).pulse);
      if (widths.some(w => w !== widths[0])) ins.pulseTab = put('pulse', sweepRows(widths, 12, w => [0x80 | (w >> 8), w & 255]));
      ins.pulse = widths[0];
    }
    // the filter table: the note goes through the filter
    if (rep.routed) {
      const filt = frames[rep.f + Math.min(1, rep.len - 1)].filter;
      const cuts = Array.from({ length: rep.len }, (_, i) => frames[rep.f + i].filter.cut);
      const made = sweepRows(cuts, 8, c => [0, c]);
      made.rows.unshift([0x80 | (filt.mode << 4), filt.res << 4]);
      if (made.loop) made.loop++;
      ins.filterTab = put('filter', made);
    }
    // a vibrato of the speed table: the note stays on its pitch and its frequency swings
    if (!moves && !fixed && rep.len > 6) {
      const vib = vibratoOf(Array.from({ length: rep.len }, (_, i) => fr(i).freq));
      if (vib) { ins.vibTab = speedRow([vib[0], vib[1]]); ins.vibDelay = ins.vibTab ? vib[2] : 0; }
    }
    return ins;
  });
  if (full) notes.push('the tables are full: some sounds play without theirs');
  const instrumentOf = new Map();
  kept.forEach((g, k) => { for (const n of [...g.notes, ...g.guests]) instrumentOf.set(n, k + 1); });
  const groupOf = new Map();
  kept.forEach(g => { for (const n of [...g.notes, ...g.guests]) groupOf.set(n, g); });

  const voices = [];
  for (let v = 0; v < VOICES; v++) {
    const rows = Array.from({ length: count }, () => [0, 0]);
    const mine = all.filter(n => n.v === v);
    const moving = [];                      // the frames of notes whose tables move the pitch
    for (const n of mine) {
      const r = rowOf(n.f + tempo / 2);                            // the nearest row: a note a little early is that row's
      if (groupOf.get(n)?.pitchMoves) moving.push([n.f, n.end]);
      if (r < 0 || r >= count) continue;
      rows[r] = [n.base + 1, instrumentOf.get(n) ?? 0];
    }
    // the gate goes and no note follows at once: a note off - in its row, or the next free one
    for (const f of falls[v]) {
      const next = rises[v].find(x => x >= f);
      if (next != null && next - f <= Math.max(3, tempo)) continue;
      for (let r = Math.max(0, rowOf(f)); r < Math.min(count, rowOf(f) + 2); r++) if (!rows[r][0]) { rows[r] = [NOTE_OFF, 0]; break; }
    }
    // a held note that changes its pitch for a whole row is a new note - not where its table moves it
    let last = 0;
    for (let r = 0; r < count; r++) {
      if (rows[r][0]) { last = rows[r][0] === NOTE_OFF ? 0 : rows[r][0]; continue; }
      const from = offset + r * tempo, to = Math.min(frames.length, from + tempo);
      if (!last || tempo < 2 || from < 0 || to - from < tempo || moving.some(([a, b]) => from >= a && from < b)) continue;
      const n = noteOf(frames[from][v].freq);
      let steady = n !== last;
      for (let f = from; f < to && steady; f++) steady = gate(f, v) && noteOf(frames[f][v].freq) === n;
      if (steady) { rows[r] = [n, 0]; last = n; }
    }
    while (rows.length && !rows[rows.length - 1][0]) rows.pop();
    voices.push(rows);
  }
  if (!voices.some(v => v.length)) throw new Error('the tune plays no note in this time');
  const length = Math.max(...voices.map(v => v.length));
  const song = buildSong({ tempo, rows: length > 32 * MAX_ORDERS ? 64 : 32, voices, instruments, tables }, notes);
  const made = TABLE_NAMES.filter(t => tables[t].length).join(', ');
  return { song, notes, tempo, made };
}
const TABLE_NAMES = ['wave', 'pulse', 'filter', 'speed'];

// the frames of a SID tune: per frame the registers of its voices and of the filter
export function sidFrames(bytes, { subtune = null, seconds = 120 } = {}) {
  const info = sidInfo(bytes);
  return runTune(bytes, Math.max(1, Math.min(info.songs, subtune ?? info.start)), Math.round(seconds * 50), []);
}

export function importSid(bytes, { subtune = null, seconds = 120 } = {}) {
  const info = sidInfo(bytes), runNotes = [];
  const frames = runTune(bytes, Math.max(1, Math.min(info.songs, subtune ?? info.start)), Math.round(seconds * 50), runNotes);
  const { song, notes, tempo, made } = transcribeSid(frames);
  notes.unshift(`SID tune${info.title ? ` "${info.title}"` : ''}${info.author ? ` by ${info.author}` : ''}: ${seconds} s heard as notes, a row is ${tempo} frame${tempo > 1 ? 's' : ''}; `
    + `its sounds as instruments with tables${made ? ` (${made})` : ''} - slides between notes are not kept`, ...runNotes);
  return { song, notes };
}

// --- MIDI files -----------------------------------------------------------------------------------

const preset = name => PRESETS.flatMap(g => g.instruments).find(i => i.name === name);
// the ready instrument of each family of 8 General MIDI programs, and the family's name
const GM_FAMILIES = [
  ['piano', 'e-piano'], ['mallets', 'bell'], ['organ', 'organ'], ['guitar', 'pluck bass'],
  ['bass', 'fat bass'], ['strings', 'string pad'], ['ensemble', 'choir pad'], ['brass', 'saw lead'],
  ['reed', 'pwm lead'], ['pipe', 'flute'], ['synth lead', 'pwm lead'], ['synth pad', 'sweep pad'],
  ['synth fx', 'ufo'], ['ethnic', 'pluck bass'], ['percussive', 'marimba'], ['sound fx', 'explosion'],
];
// the drums of channel 10 by their key: the instrument and the note it plays
const DRUM_NOTE = { kick: 25, snare: 61, tom: 37, 'closed hat': 85, 'open hat': 85 };
const drumOf = key => (key === 35 || key === 36 ? 'kick' : key >= 37 && key <= 40 ? 'snare'
  : [41, 43, 45, 47, 48, 50].includes(key) ? 'tom' : [46, 49, 52, 55, 57].includes(key) ? 'open hat' : 'closed hat');
const DRUM_RANK = ['kick', 'snare', 'tom', 'open hat', 'closed hat'];     // of drums at once, the first wins
const DRUMS = 9;                                                           // channel 10

const be32 = (bytes, o) => bytes[o] * 0x1000000 + (bytes[o + 1] << 16) + (bytes[o + 2] << 8) + bytes[o + 3];

// the notes of all tracks: { tpq, tempos, signature, title, parts } - a part is the notes of a
// channel of a track: { name, drums, program, notes: [{ key, start, end }] } in ticks
function readMidi(bytes) {
  let o = 0;
  while (o + 4 <= bytes.length && text(bytes, o, 4) !== 'MThd') o++;       // a RIFF (.rmi) holds the file
  if (o + 14 > bytes.length) throw new Error('not a MIDI file');
  const division = word(bytes, o + 12), count = word(bytes, o + 10);
  // SMPTE time: ticks of a second, as if a quarter note were half a second (120 bpm)
  const tpq = division & 0x8000 ? (256 - (division >> 8)) * (division & 255) / 2 : division;
  if (!tpq) throw new Error('the MIDI file has no time division');
  o += 8 + be32(bytes, o + 4);
  const tempos = [], signatures = [], parts = new Map();
  let title = '';
  for (let t = 0; t < count && o + 8 <= bytes.length; ) {
    const id = text(bytes, o, 4), length = be32(bytes, o + 4);
    o += 8;
    const stop = Math.min(bytes.length, o + length);
    if (id !== 'MTrk') { o = stop; continue; }
    const programs = new Array(16).fill(0), open = new Map();
    let tick = 0, running = 0, name = '';
    const vlq = () => { let v = 0, b; do { b = bytes[o++]; v = v * 128 + (b & 127); } while (b & 128 && o < stop); return v; };
    const part = ch => {
      const key = `${t}:${ch}`;
      if (!parts.has(key)) parts.set(key, { track: t, name: '', drums: ch === DRUMS, program: programs[ch], notes: [] });
      return parts.get(key);
    };
    const end = (ch, key) => {
      const list = open.get(ch * 128 + key);
      const n = list?.shift();
      if (n) { n.end = tick; part(ch).notes.push(n); }
    };
    while (o < stop) {
      tick += vlq();
      let status = bytes[o];
      if (status >= 0x80) o++;
      else if (running) status = running;                                  // running status: the last one again
      else break;
      if (status === 0xff) {                                               // a meta event
        const type = bytes[o++], n = vlq(), d = bytes.subarray(o, o + n);
        o += n; running = 0;
        if (type === 0x51 && n >= 3) tempos.push([tick, (d[0] << 16) | (d[1] << 8) | d[2]]);
        else if (type === 0x58 && n >= 2) signatures.push([tick, d[0], 2 ** d[1]]);
        else if (type === 0x03 && !name) name = text(d, 0, n);
        else if (type === 0x2f) break;
        continue;
      }
      if (status === 0xf0 || status === 0xf7) { o += vlq(); running = 0; continue; }   // a system exclusive
      running = status;
      const type = status >> 4, ch = status & 15, a = bytes[o] & 127, b = bytes[o + 1] & 127;
      o += type === 0xc || type === 0xd ? 1 : 2;
      if (type === 0xc) programs[ch] = a;
      else if (type === 9 && b) {
        const key = ch * 128 + a;
        if (!open.has(key)) open.set(key, []);
        open.get(key).push({ key: a, start: tick, program: programs[ch] });
        part(ch);
      } else if (type === 8 || type === 9) end(ch, a);
    }
    for (const k of open.keys()) while (open.get(k).length) end(k >> 7, k & 127);   // a note that is never let go
    for (const p of parts.values()) if (p.track === t) p.name = name;
    if (t === 0 && name) title = name;
    o = stop;
    t++;
  }
  const list = [...parts.values()].filter(p => p.notes.length);
  for (const p of list) {
    p.notes.sort((a, b) => a.start - b.start || b.key - a.key);            // of a chord the highest note first
    p.program = p.notes[0].program;
    p.name = p.drums ? 'drums' : p.name || GM_FAMILIES[p.program >> 3][0];
  }
  tempos.sort((a, b) => a[0] - b[0]);
  signatures.sort((a, b) => a[0] - b[0]);
  return { tpq, tempos, signature: signatures[0]?.slice(1) ?? [4, 4], title, parts: list };
}

export function midiInfo(bytes) {
  const m = readMidi(bytes);
  if (!m.parts.length) throw new Error('the MIDI file plays no note');
  return {
    title: m.title, bpm: Math.round(60e6 / (m.tempos[0]?.[1] ?? 500000)),
    parts: m.parts.map(p => ({ name: p.name, drums: p.drums, notes: p.notes.length })),
  };
}

// rowsPerQuarter: the rows of a quarter note (4: a row is a sixteenth). drums: channel 10 too.
// all: a voice for every note at once (up to MAX_VOICES), else the notes shared out to three
export function importMidi(bytes, { rowsPerQuarter = 4, drums = true, all = true } = {}) {
  const m = readMidi(bytes), notes = [];
  if (!m.parts.length) throw new Error('the MIDI file plays no note');
  const usq = m.tempos[0]?.[1] ?? 500000;
  const tempo = Math.max(1, Math.min(255, Math.round(usq / 1e6 * 50 / rowsPerQuarter)));
  if (new Set(m.tempos.map(t => t[1])).size > 1) notes.push(`the tempo changes: it stays ${Math.round(60e6 / usq)} bpm`);
  const rowOf = tick => Math.round(tick * rowsPerQuarter / m.tpq);

  // the instruments: one of a part, one of each drum - without the filter: the SID has one for all
  const instruments = [], byKey = new Map();
  const instrument = (key, name, from) => {
    if (!byKey.has(key)) { byKey.set(key, instruments.length + 1); instruments.push(newInstrument(name.slice(0, 12), { ...from, name: name.slice(0, 12), filter: 0, cutoff: 128, res: 0, sweep: 0 })); }
    return byKey.get(key);
  };
  const pitch = key => { let n = key - 11; while (n < 1) n += 12; while (n > NOTES) n -= 12; return n; };

  // the parts, the most played first, the drums last: they fill what the others leave free
  const parts = m.parts.filter(p => drums || !p.drums).sort((a, b) => a.drums - b.drums || b.notes.length - a.notes.length);
  if (!parts.length) throw new Error('the MIDI file plays only drums');
  let length = 0;
  const wanted = parts.map((p, k) => {
    let list = p.notes.map(n => {
      const start = rowOf(n.start);
      if (p.drums) {
        const drum = drumOf(n.key);
        return { part: k, start, end: start + 1, drum, note: DRUM_NOTE[drum], ins: instrument(`drum ${drum}`, drum, preset(drum)) };
      }
      const [family, ready] = GM_FAMILIES[n.program >> 3];
      return { part: k, start, end: Math.max(start + 1, rowOf(n.end)), note: pitch(n.key), ins: instrument(`${p.track}:${n.program}`, p.name || family, preset(ready)) };
    });
    // on three voices of drums at once one: the kick before the snare before the rest
    if (p.drums && !all) list = list.sort((a, b) => a.start - b.start || DRUM_RANK.indexOf(a.drum) - DRUM_RANK.indexOf(b.drum)).filter((n, i, all) => !i || all[i - 1].start !== n.start);
    list = list.filter(n => n.start < MAX_ROWS);
    for (const n of list) length = Math.max(length, Math.min(MAX_ROWS, n.end));
    return list;
  });
  if (m.parts.some(p => rowOf(p.notes[p.notes.length - 1].start) >= MAX_ROWS)) notes.push(`the song is cut after ${MAX_ROWS} rows`);

  // the voices: a row holds the note that sounds there. A note goes to a voice that is free while it
  // sounds - the voice its part played last first. A note of the same part that started before is
  // cut. All: a voice is of one part, a part takes another voice when its own ones sound
  const owner = [], partOf = [];
  const open = () => { owner.push(new Int32Array(length + 1).fill(-1)); partOf.push(-1); };
  if (!all) for (let v = 0; v < VOICES; v++) open();
  const placed = [], last = new Map();         // the voice a part last played on; of the drums: a drum
  let dropped = 0;
  for (const list of wanted) {
    for (const n of list) {
      const free = v => {
        for (let r = n.start; r < n.end; r++) {
          const q = owner[v][r];
          if (q >= 0 && (placed[q].part !== n.part || placed[q].start >= n.start)) return false;
        }
        return true;
      };
      const mine = v => !all || partOf[v] === n.part || (partOf[v] < 0 && owner.length >= MAX_VOICES);
      let v = [last.get(n.drum ?? n.part) ?? 0, ...owner.keys()].find(x => x < owner.length && mine(x) && free(x));
      if (v == null && all && owner.length < MAX_VOICES) { open(); v = owner.length - 1; }
      // no voice left: any voice that is free then
      if (v == null && all) v = [...owner.keys()].find(free);
      if (v == null) { dropped++; continue; }
      if (partOf[v] < 0) partOf[v] = n.part;
      const q = owner[v][n.start];
      if (q >= 0) { placed[q].end = n.start; for (let r = n.start; owner[v][r] === q; r++) owner[v][r] = -1; }
      n.voice = v;
      last.set(n.drum ?? n.part, v);
      for (let r = n.start; r < n.end; r++) owner[v][r] = placed.length;
      placed.push(n);
    }
  }
  if (dropped) notes.push(`${dropped} of ${dropped + placed.length} notes did not fit the ${all ? MAX_VOICES : 'three'} voices`);
  while (owner.length < VOICES) open();
  // the game plays the first voice of the three most played parts
  const game = [];
  for (let v = 0; v < owner.length && game.length < VOICES; v++) if (!game.some(g => partOf[g] === partOf[v])) game.push(v);
  for (let v = 0; v < owner.length && game.length < VOICES; v++) if (!game.includes(v)) game.push(v);
  game.sort((a, b) => a - b);

  const voices = owner.map(() => Array.from({ length }, () => [0, 0]));
  for (const n of placed) voices[n.voice][n.start] = [n.note, n.ins];
  // the end of a note that nothing follows at once: a note off (a drum just dies away)
  for (const n of placed) if (!n.drum && n.end < length && !voices[n.voice][n.end][0] && owner[n.voice][n.end] < 0) voices[n.voice][n.end] = [NOTE_OFF, 0];

  // the rows of a pattern: whole bars, near 32
  const [num, den] = m.signature, bar = rowsPerQuarter * 4 * num / den;
  const fits = [32, 64, 48, 16].filter(r => Number.isInteger(bar) && bar > 0 && r % bar === 0);
  const rows = length > (fits[0] ?? 32) * MAX_ORDERS && fits.includes(64) ? 64 : fits[0] ?? 32;
  const song = buildSong({ tempo, rows, voices, instruments, game }, notes);
  const on = all ? `${song.voices} voices, the game plays ${game.map(v => v + 1).join(', ')}` : 'three voices';
  notes.unshift(`MIDI file${m.title ? ` "${m.title}"` : ''}: ${parts.length} part${parts.length > 1 ? 's' : ''} on ${on}, a row is ${tempo} frame${tempo > 1 ? 's' : ''} - without velocity, pitch bends and controllers`);
  return { song, notes };
}
