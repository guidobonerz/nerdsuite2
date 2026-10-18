// sidplayer.js - plays a song (song.js) on the SID: tick() is the player's frame, 50 times a
// second, and everything it does is a write to a SID register - what a player in the game
// would do in its raster interrupt.
//   a row    lasts `tempo` frames. A note first takes the gate away for a frame, then the next
//            frame sets the instrument and the gate: the envelope starts again.
//   a frame  moves the sounding notes: a step of the wave table, the arpeggio, a slide or glide,
//            the vibrato, the frequency, a step of the pulse table or the pulse sweep, a step of
//            the filter table or the sweep of the filter's cutoff - in this order, as the engine
//            (engine/tables.s, track.s) does it
//   tables   (song.js) a note of an instrument with a table runs it from the instrument's row: the
//            wave table sets the waveform and the pitch, the pulse table the width, the filter
//            table the filter it takes; a vibrato of the speed table, after its delay
//   the filter  is one for the three voices: a note of an instrument with a filter sends its voice
//            through it and sets it (kind, resonance, cutoff, sweep), a note of one without takes
//            its voice out
//   commands of a cell (song.js COMMANDS) come after its note
// SidEngine is the player with the chip and a clock in samples - a chip and a player for every
// three voices of a song of more: the audio worklet of the sound editor (sidworklet.js) and the
// tests render with it.

import { Sid } from './sid.js';
import {
  VOICES, NOTE_OFF, NO_LOOP, NOTES, FREQ, cellOffset, decode, pickVoices, gameSong,
  CMD_UP, CMD_DOWN, CMD_GLIDE, CMD_ARP, CMD_CUTOFF, CMD_PULSE, CMD_VOLUME, CMD_TEMPO, CMD_BREAK,
  CMD_UP_T, CMD_DOWN_T, CMD_GLIDE_T, CMD_VIB_T,
} from './song.js';

const PULSE_MIN = 0x100, PULSE_MAX = 0xf00;
const ARP_ENDS = 0x80;                    // the step of an arpeggio a command ended
const SOUND = 3;                          // the track of the first sound (4: the second): it plays on the voice of a music track
const SOUNDS = 2;                         // sounds over the music at a time
const SID_VOICE = [0, 7, 14];             // the registers of each voice
// a track: tnote is the note the pitch is of (the wave table moves it), wave the waveform (the
// table changes it); wptr/wdelay the wave table, pptr/ptimer/pspeed the pulse table, vtab the
// row of a vibrato of the speed table (vdelay frames before it starts, vcount frames of its half
// wave gone, vdir its way)
const newTrack = () => ({
  ins: null, song: null, note: -1, tnote: -1, wave: 0, trigger: false, gate: false, freq: 0, pulse: 0x800, pulseDir: 1, vib: 0, vibStep: 0, vibOffset: 0,
  arp: 0, arpStep: 0, slide: 0, speed: 0, target: 0,
  wptr: 0, wdelay: 0, pptr: 0, ptimer: 0, pspeed: 0, vtab: 0, vdelay: 0, vcount: 0, vdir: 1,
});
const newSeq = () => ({ song: null, playing: false, order: 0, row: 0, frame: 0, tempo: 1, break: false, loopPattern: false });
const newFilter = () => ({ route: 0, res: 0, mode: 0, cutoff: 0, sweep: 0, owner: -1, ptr: 0, timer: 0, speed: 0, song: null });
const STEPS = 8;                          // rows a table step reads at most: jumps and filter types before a step
const signed = b => (b << 24) >> 24;
// a row of a table of a song: [left, right], null past its end
const row = (song, table, n) => song?.tables?.[table]?.[n - 1] ?? null;
// a 16 bit speed of the speed table
const speedOf = (song, n) => { const r = row(song, 'speed', n); return r ? (r[0] << 8) | r[1] : 0; };

// The engine plays the same way (engine/sound.s): tracks 0-2 are the music, tracks 3 and 4 two
// sounds that may play at a time - the first voice of a song, once, on the last voice the music
// does not hold a note on and no other sound has (else the last no other sound has), whose music
// is silent meanwhile; a sound while one plays is the second. The numbers are whole numbers a 6502
// counts as well, so game and editor sound alike.
export class Player {
  // write(reg, value): the SID. onrow(order, row): a row of the music starts
  constructor(write, onrow = null) {
    this.sid = write;
    this.onrow = onrow;
    this.muted = [false, false, false];
    this.music = newSeq();
    this.effects = Array.from({ length: SOUNDS }, newSeq);
    this.reset();
  }

  // the first sound: a step sound waits for it (steps.s)
  get effect() { return this.effects[0]; }

  get song() { return this.music.song; }
  get playing() { return this.music.playing; }

  reset() {
    Object.assign(this.music, { playing: false, order: 0, row: 0, frame: 0, break: false });
    for (const e of this.effects) Object.assign(e, { playing: false, order: 0, row: 0, frame: 0, break: false });
    this.tracks = Array.from({ length: VOICES + SOUNDS }, newTrack);
    this.filter = newFilter();
    this.volume = 15;
    this.soundVoices = Array(SOUNDS).fill(2); // the music track whose voice each sound plays on
    for (let r = 0; r < 24; r++) this.sid(r, 0);
    this.sid(24, 15);
  }

  // the track is heard: the music's track is not while a sound plays on its voice
  live(track) { return track >= SOUND || !this.taken(track); }
  // a sound plays on the voice of music track k (but sound `but`)
  taken(k, but = -1) { return this.effects.some((e, n) => n !== but && e.playing && this.soundVoices[n] === k); }

  voice(track) { return track >= SOUND ? this.soundVoices[track - SOUND] : track; }

  // a register of the voice of a track
  write(track, reg, value) {
    if (this.live(track)) this.sid(SID_VOICE[this.voice(track)] + reg, value);
  }

  // the song changes while it plays: the position stays
  setSong(song) {
    const m = this.music;
    m.song = song;
    if (song) m.tempo = song.tempo;
    if (song && m.order >= song.orders.length) m.order = 0;
    if (song && m.row >= song.rows) m.row = 0;
  }

  // loopPattern: the pattern of the order again and again
  play(order = 0, row = 0, loopPattern = false) {
    const m = this.music;
    if (!m.song) return;
    this.reset();
    Object.assign(m, { order: Math.min(order, m.song.orders.length - 1), row: Math.min(row, m.song.rows - 1), tempo: m.song.tempo, loopPattern, playing: true });
  }

  // a song as a sound: its first voice, once, over the music - the second sound while the first
  // plays; on the last voice the music holds no note on and the other sound does not have, else
  // the last the other sound does not have
  playSound(song) {
    const n = this.effects[0].playing ? 1 : 0, e = this.effects[n];
    this.stopSeq(e);
    let voice = -1;
    for (let k = 2; k >= 0 && voice < 0; k--) if (!this.tracks[k].gate && !this.taken(k, n)) voice = k;
    for (let k = 2; k >= 0 && voice < 0; k--) if (!this.taken(k, n)) voice = k;
    this.soundVoices[n] = voice;
    Object.assign(e, { song, order: 0, row: 0, frame: 0, tempo: song.tempo, break: false, playing: true });
  }

  stop() { this.reset(); }

  // the notes of a sequencer release; the volume is the music's: it ends with it
  stopSeq(seq) {
    seq.playing = false;
    const n = this.effects.indexOf(seq);
    for (const k of n >= 0 ? [SOUND + n] : [0, 1, 2]) {
      this.noteOff(k);
      this.tracks[k] = newTrack();
    }
    if (seq === this.music) { this.volume = 15; this.sid(24, (this.filter.mode << 4) | 15); }
  }

  mute(voice, on) {
    this.muted[voice] = on;
    if (on) this.noteOff(voice);
  }

  // song: the song of the instrument, the music's by default
  // glide: a sounding note does not start anew, its pitch moves to the note - with the
  // instrument it has, the one of the cell is not used
  noteOn(track, note, ins, song = this.music.song, glide = false) {
    const v = this.tracks[track], i = song?.instruments[ins - 1];
    if (i && !glide) { v.ins = i; v.song = song; }
    if (!v.ins) return;
    if (glide && v.note >= 0) {
      Object.assign(v, { note: note - 1, slide: CMD_GLIDE, target: FREQ[note - 1] });
      return;
    }
    // the tables of the instrument start again; with a wave table its arpeggio gives way
    const it = v.ins;
    Object.assign(v, { note: note - 1, tnote: note - 1, trigger: true, gate: true, slide: 0, arp: it.waveTab ? 0 : (it.arp1 << 4) | it.arp2,
      wave: it.wave, wptr: it.waveTab ?? 0, wdelay: 0, pptr: it.pulseTab ?? 0, ptimer: 0, vtab: it.vibTab ?? 0, vdelay: it.vibDelay ?? 0, vdir: 1 });
    this.write(track, 4, v.wave & 0xfe);                  // the gate goes, the next frame sets it
  }

  noteOff(track) {
    const v = this.tracks[track];
    this.write(track, 4, v.ins ? v.wave & 0xfe : 0);
  }

  // the command of a cell, after its note
  command(track, seq, cmd, value) {
    const v = this.tracks[track];
    switch (cmd) {
      case CMD_UP: case CMD_DOWN: v.slide = cmd; v.speed = value; break;
      case CMD_GLIDE: v.speed = value; break;
      // the speeds of the speed table: 16 bit; a vibrato of its row (0 ends it)
      case CMD_UP_T: case CMD_DOWN_T: v.slide = cmd === CMD_UP_T ? CMD_UP : CMD_DOWN; v.speed = speedOf(seq.song, value); break;
      case CMD_GLIDE_T: v.speed = speedOf(seq.song, value); break;
      case CMD_VIB_T:
        Object.assign(v, { vtab: value, vdelay: 0, vcount: (row(seq.song, 'speed', value)?.[0] ?? 0) >> 1, vdir: 1, vibOffset: 0, song: v.song ?? seq.song });
        break;
      case CMD_ARP:                                       // it ends: the next frame is on the note again
        if (!value && v.arp) v.arpStep = ARP_ENDS;
        v.arp = value;
        break;
      case CMD_CUTOFF: this.filter.cutoff = value; this.sid(22, value); break;
      case CMD_PULSE: v.pulse = value << 4; this.setPulse(track, v.pulse); break;
      case CMD_VOLUME:                                    // the volume is the music's
        if (track < SOUND) { this.volume = value & 15; this.sid(24, (this.filter.mode << 4) | this.volume); }
        break;
      case CMD_TEMPO: if (value) seq.tempo = value; break;
      case CMD_BREAK: seq.break = true; break;
    }
  }

  tick() {
    for (let k = SOUND + SOUNDS - 1; k >= 0; k--) this.trackFrame(k);
    for (const seq of [...[...this.effects].reverse(), this.music]) {
      if (!seq.playing || !seq.song) continue;
      if (seq.frame === 0) this.playRow(seq);
      if (seq.playing) seq.frame = seq.frame + 1 < seq.tempo ? seq.frame + 1 : 0;
    }
  }

  playRow(seq) {
    const song = seq.song, pattern = song.patterns[song.orders[seq.order]], sound = seq !== this.music;
    if (!sound) this.onrow?.(seq.order, seq.row);
    for (let k = 0; k < (sound ? 1 : VOICES); k++) {
      const o = cellOffset(seq.row, k), note = pattern[o], ins = pattern[o + 1], cmd = pattern[o + 2], value = pattern[o + 3];
      const track = sound ? SOUND + this.effects.indexOf(seq) : k;
      if (!sound && this.muted[k]) {                      // a muted voice still says how the song goes on
        if (cmd === CMD_TEMPO || cmd === CMD_BREAK) this.command(track, seq, cmd, value);
        continue;
      }
      if (note === NOTE_OFF) { this.tracks[track].gate = false; this.noteOff(track); }
      else if (note) this.noteOn(track, note, ins, song, cmd === CMD_GLIDE || cmd === CMD_GLIDE_T);
      if (cmd) this.command(track, seq, cmd, value);
    }
    const end = seq.break;
    seq.break = false;
    if (++seq.row < song.rows && !end) return;
    seq.row = 0;
    if (seq.loopPattern || ++seq.order < song.orders.length) return;
    if (sound || song.loop === NO_LOOP) { seq.order = 0; this.stopSeq(seq); } else seq.order = Math.min(song.loop, song.orders.length - 1);
  }

  trackFrame(k) {
    const v = this.tracks[k], i = v.ins;
    if (!i || v.note < 0) return;
    if (v.trigger) {
      v.trigger = false;
      v.pulse = i.pulse; v.pulseDir = 1; v.vib = 0; v.vibOffset = 0; v.arpStep = 0;
      this.waveStep(v);                                   // the first step of the wave table: the waveform, the pitch
      v.freq = FREQ[v.tnote];
      // the step of the vibrato: up to about a semitone, a part of the distance to the next note
      v.vibStep = v.vtab ? 0 : ((FREQ[v.note + 1] - FREQ[v.note]) * i.vibDepth * i.vibSpeed) >> 8;
      v.vcount = (row(v.song, 'speed', v.vtab)?.[0] ?? 0) >> 1;
      if (this.live(k)) { this.setFilter(k, i, v.song); if (this.filter.owner === k) this.filterStep(); }
      this.write(k, 5, (i.a << 4) | i.d);
      this.write(k, 6, (i.s << 4) | i.r);
      this.pulseStep(v);
      this.setPulse(k, v.pulse);
      this.setFreq(k, v.freq);
      this.write(k, 4, (v.wave & 0xfe) | 1);
      return;
    }
    let moved = false;
    const was = v.wave, note = this.waveStep(v);
    if (v.wave !== was) this.write(k, 4, (v.wave & 0xfe) | (v.gate ? 1 : 0));
    if (note) { v.freq = FREQ[v.tnote]; moved = true; }
    if (v.arp) {
      // the note, its first and its second other note, a frame each; without a second one two steps
      v.arpStep = v.arpStep + 1 < (v.arp & 15 ? 3 : 2) ? v.arpStep + 1 : 0;
      v.freq = FREQ[Math.min(v.tnote + [0, v.arp >> 4, v.arp & 15][v.arpStep], NOTES - 1)];
      moved = true;
    } else if (v.arpStep === ARP_ENDS) {
      v.arpStep = 0;
      v.freq = FREQ[v.tnote];
      moved = true;
    }
    if (v.slide) {
      const f = v.freq, s = v.speed, t = v.target;
      v.freq = v.slide === CMD_UP ? Math.min(0xffff, f + s) : v.slide === CMD_DOWN ? Math.max(0, f - s) : f < t ? Math.min(t, f + s) : Math.max(t, f - s);
      moved = true;
    }
    if (v.vtab) {
      // a vibrato of the speed table: the depth a frame, the way turns after left frames
      const r = row(v.song, 'speed', v.vtab);
      if (v.vdelay) v.vdelay--;
      else if (r && r[0]) {
        v.vibOffset = (v.vibOffset + v.vdir * r[1]) | 0;
        if (++v.vcount >= r[0]) { v.vcount = 0; v.vdir = -v.vdir; }
        moved = true;
      }
    } else if (v.vibStep) {
      // a triangle: a quarter of the 64 steps up, a half down, a quarter up
      v.vib = (v.vib + i.vibSpeed) & 63;
      v.vibOffset += v.vib < 16 || v.vib >= 48 ? v.vibStep : -v.vibStep;
      moved = true;
    }
    if (moved) this.setFreq(k, v.freq + v.vibOffset);
    if (v.pptr || v.ptimer) {
      if (this.pulseStep(v)) this.setPulse(k, v.pulse);
    } else if (i.pwm && !i.pulseTab && (v.wave & 0x40)) {   // a pulse table ends: the width stays
      v.pulse += i.pwm * v.pulseDir;
      if (v.pulse >= PULSE_MAX) { v.pulse = PULSE_MAX; v.pulseDir = -1; }
      if (v.pulse < PULSE_MIN) { v.pulse = PULSE_MIN; v.pulseDir = 1; }
      this.setPulse(k, v.pulse);
    }
    const f = this.filter;
    if (f.owner === k && (f.ptr || f.timer)) this.filterStep();
    else if (f.owner === k && f.sweep) {
      f.cutoff = Math.max(0, Math.min(255, f.cutoff + f.sweep));
      this.sid(22, f.cutoff);
    }
  }

  // a step of the wave table of track v: its waveform and the note of its pitch. Returns whether
  // the note changed
  waveStep(v) {
    if (!v.wptr) return false;
    if (v.wdelay) { v.wdelay--; return false; }
    for (let n = 0; n < STEPS; n++) {
      const r = row(v.song, 'wave', v.wptr);
      if (!r) { v.wptr = 0; return false; }
      const [l, x] = r;
      if (l === 0xff) { v.wptr = x; if (!x) return false; continue; }
      v.wptr = v.wptr < 255 ? v.wptr + 1 : 0;
      if (l >= 1 && l <= 0x0f) { v.wdelay = l - 1; return false; }
      if (l >= 0xf0) return false;                        // a command of GoatTracker: its right byte is no note
      if (l >= 0x10) v.wave = l & 0xfe;                  // the gate is the note's
      if (x === 0x80) return false;
      const to = x < 0x60 ? v.note + x : x < 0x80 ? v.note - (0x80 - x) : x - 0x80;
      v.tnote = Math.max(0, Math.min(NOTES - 1, to));
      return true;
    }
    return false;
  }

  // a step of the pulse table of track v: its width. Returns whether it changed
  pulseStep(v) {
    if (v.ptimer) { v.ptimer--; v.pulse = (v.pulse + v.pspeed) & 0xfff; return true; }
    if (!v.pptr) return false;
    for (let n = 0; n < STEPS; n++) {
      const r = row(v.song, 'pulse', v.pptr);
      if (!r) { v.pptr = 0; return false; }
      const [l, x] = r;
      if (l === 0xff) { v.pptr = x; if (!x) return false; continue; }
      v.pptr = v.pptr < 255 ? v.pptr + 1 : 0;
      if (l >= 0x80) { v.pulse = ((l & 15) << 8) | x; return true; }
      if (!l) return false;
      v.ptimer = l - 1; v.pspeed = signed(x);
      v.pulse = (v.pulse + v.pspeed) & 0xfff;
      return true;
    }
    return false;
  }

  // a step of the filter table of the filter's note: its type, resonance, cutoff
  filterStep() {
    const f = this.filter;
    if (f.timer) { f.timer--; f.cutoff = (f.cutoff + f.speed) & 255; this.sid(22, f.cutoff); return; }
    for (let n = 0; n < STEPS && f.ptr; n++) {
      const r = row(f.song, 'filter', f.ptr);
      if (!r) { f.ptr = 0; return; }
      const [l, x] = r;
      if (l === 0xff) { f.ptr = x; continue; }
      f.ptr = f.ptr < 255 ? f.ptr + 1 : 0;
      if (l >= 0x80) {                                    // the type and the resonance: the next row in the same frame
        f.mode = (l >> 4) & 7; f.res = x >> 4;
        this.sid(23, (f.res << 4) | f.route);
        this.sid(24, (f.mode << 4) | this.volume);
        continue;
      }
      if (!l) f.cutoff = x;
      else { f.timer = l - 1; f.speed = signed(x); f.cutoff = (f.cutoff + f.speed) & 255; }
      this.sid(22, f.cutoff);
      return;
    }
  }

  // the note of track k starts: its voice goes through the filter, which is now the one of
  // its instrument (one with a filter table too, which runs from its row) - or around it
  setFilter(k, i, song = null) {
    const f = this.filter, bit = 1 << this.voice(k);
    if (i.filter || i.filterTab) {
      Object.assign(f, { mode: i.filter & 7, res: i.res, cutoff: i.cutoff, sweep: i.filterTab ? 0 : i.sweep, owner: k, route: f.route | bit,
        ptr: i.filterTab ?? 0, timer: 0, speed: 0, song });
      this.sid(22, f.cutoff);
      this.sid(24, (f.mode << 4) | this.volume);
    } else f.route &= ~bit;
    this.sid(23, (f.res << 4) | f.route);
  }

  setFreq(k, f) {
    f &= 0xffff;
    this.write(k, 0, f & 255);
    this.write(k, 1, f >> 8);
  }

  setPulse(k, p) {
    this.write(k, 2, p & 255);
    this.write(k, 3, p >> 8);
  }
}

// messages: {type: 'song', bytes, all} {type: 'play', order, row, loop} {type: 'stop'}
// {type: 'mute', voice, on} {type: 'noteOn', voice, note, ins} {type: 'noteOff', voice}
// {type: 'sound', bytes}: a song as a sound over the music
// A song plays as the game plays it: its game voices on one SID. all: every voice of the song,
// a SID and a player for every three (the voice of a message is a voice of the song)
// onpos({order, row}) names every row that starts
export class SidEngine {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.chips = [];                        // {sid, player}
    this.slots = [];                        // per voice of the song: [chip, voice of its SID], or null
    this.muted = new Set();
    this.perTick = sampleRate / 50;
    this.left = 0;                          // samples until the next frame of the players
    this.onpos = null;
    this.buffer = null;
    this.setChips(1);
  }

  get player() { return this.chips[0].player; }

  setChips(n) {
    while (this.chips.length > n) this.chips.pop();
    while (this.chips.length < n) {
      const sid = new Sid(this.sampleRate), first = !this.chips.length;
      this.chips.push({ sid, player: new Player((r, v) => sid.write(r, v), first ? (order, row) => this.onpos?.({ order, row }) : null) });
    }
  }

  // the voices of the song on the SIDs: the game voices on one, or all, three on each
  setSong(song, all) {
    const groups = [];
    if (all) for (let v = 0; v < song.voices; v += VOICES) groups.push([v, v + 1, v + 2].filter(x => x < song.voices));
    else groups.push(song.game);
    const playing = this.player.playing, at = { order: this.player.music.order, row: this.player.music.row };
    this.setChips(groups.length);
    this.slots = Array.from({ length: song.voices }, () => null);
    groups.forEach((list, c) => {
      const { player } = this.chips[c];
      player.setSong(pickVoices(song, list, { globals: groups.length > 1 }));
      list.forEach((v, k) => { this.slots[v] = [c, k]; });
      for (let k = 0; k < VOICES; k++) player.mute(k, list[k] != null && this.muted.has(list[k]));
      // a SID that comes while the song plays joins it at the row of the others
      if (playing && !player.playing) { player.play(at.order, at.row); player.music.frame = this.player.music.frame; }
    });
  }

  // the SID voice of a voice of the song; a voice that is not heard plays its notes on the first SID
  slot(voice) { return this.slots[voice] ?? [0, voice % VOICES]; }

  handle(m) {
    switch (m.type) {
      case 'song': this.setSong(decode(m.bytes), !!m.all); break;
      case 'play': for (const c of this.chips) c.player.play(m.order, m.row, m.loop); this.left = 0; break;
      case 'stop': for (const c of this.chips) c.player.stop(); break;
      case 'mute': {
        if (m.on) this.muted.add(m.voice); else this.muted.delete(m.voice);
        const s = this.slots[m.voice];
        if (s) this.chips[s[0]].player.mute(s[1], m.on);
        break;
      }
      case 'sound': if (!(m.polite && this.player.effect.playing)) this.player.playSound(gameSong(decode(m.bytes))); break;   // polite: a step waits for another sound
      case 'noteOn': { const [c, k] = this.slot(m.voice); this.chips[c].player.noteOn(k, m.note, m.ins); break; }
      case 'noteOff': { const [c, k] = this.slot(m.voice); this.chips[c].player.noteOff(k); break; }
    }
  }

  // the SIDs are mixed: louder than one, not as loud as their sum
  render(out) {
    const n = this.chips.length, gain = 1 / Math.sqrt(n);
    if (n > 1 && this.buffer?.length !== out.length) this.buffer = new Float32Array(out.length);
    let i = 0;
    while (i < out.length) {
      if (this.left < 1) { for (const c of this.chips) c.player.tick(); this.left += this.perTick; }
      const len = Math.min(out.length - i, Math.ceil(this.left));
      this.chips[0].sid.render(out, i, i + len);
      for (let c = 1; c < n; c++) {
        this.chips[c].sid.render(this.buffer, i, i + len);
        for (let k = i; k < i + len; k++) out[k] += this.buffer[k];
      }
      if (n > 1) for (let k = i; k < i + len; k++) { const s = out[k] * gain; out[k] = s > 1 ? 1 : s < -1 ? -1 : s; }
      i += len;
      this.left -= len;
    }
  }
}
