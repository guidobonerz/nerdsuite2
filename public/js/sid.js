// sid.js - a small model of the SID (6581/8580) for the sound editor: the three voices with
// their 24 bit oscillators, the four waveforms (triangle, sawtooth, pulse, noise - combined
// waveforms are their AND), the test bit, the ADSR envelopes with the chip's rates and its
// exponential decay, the filter and the master volume. It is written to like the chip -
// write(reg, value) with the registers $d400-$d418 as 0-24 - so the player of the editor does
// what a player in the game does. The filter is a state variable filter: low, band and high
// pass of the voices sent through it ($d417), the cutoff ($d415/$d416) from about 30 Hz to
// 12 kHz in even steps as in the 8580 - a 6581 bends that curve, and every chip its own way -
// and the resonance. Not modelled: ring modulation and sync.

export const CLOCK = 985248;            // PAL: the clock the frequencies are counted with
const OVERSAMPLE = 4;                   // oscillator steps per sample, averaged: less aliasing
const FILTER_STEPS = 2;                 // filter steps per sample: it stays stable up to its highest cutoff

// the clock cycles of one envelope step, per rate 0-15 of attack, decay and release
const PERIODS = [9, 32, 63, 95, 149, 220, 267, 313, 392, 977, 1954, 3126, 3907, 11720, 19532, 31251];
const ATTACK = 0, DECAY = 1, RELEASE = 2;

// decay and release slow down as the envelope falls: that is the exponential curve of the chip
const expPeriod = env => (env > 93 ? 1 : env > 54 ? 2 : env > 26 ? 4 : env > 14 ? 8 : env > 6 ? 16 : 30);

const newVoice = () => ({
  freq: 0, pw: 0, ctrl: 0, ad: 0, sr: 0,
  acc: 0, lfsr: 0x7ffff8, noise: 0,
  env: 0, state: RELEASE, envAcc: 0,
});

export class Sid {
  constructor(sampleRate = 44100) {
    this.sampleRate = sampleRate;
    this.reset();
  }

  reset() {
    this.regs = new Uint8Array(25);
    this.voices = [newVoice(), newVoice(), newVoice()];
    this.volume = 0;
    this.route = 0;                       // $d417: the voices that go through the filter, and the resonance
    this.damp = 1.4;
    this.mode = 0;                        // $d418: 1 low, 2 band, 4 high pass, 8 voice 3 is not heard
    this.cutoff = 0;                      // the coefficient of the cutoff frequency
    this.low = 0;
    this.band = 0;
    this.setCutoff();
  }

  setCutoff() {
    const fc = (this.regs[22] << 3) | (this.regs[21] & 7);
    this.cutoff = 2 * Math.sin(Math.PI * (30 + fc * 5.8) / (this.sampleRate * FILTER_STEPS));
  }

  write(reg, value) {
    value &= 255;
    if (reg < 0 || reg > 24) return;
    this.regs[reg] = value;
    if (reg === 24) { this.volume = value & 15; this.mode = value >> 4; return; }
    if (reg === 23) { this.route = value & 7; this.damp = 1.4 - (value >> 4) * 0.08; return; }
    if (reg > 20) { this.setCutoff(); return; }
    const v = this.voices[Math.floor(reg / 7)], r = this.regs, b = reg - (reg % 7);
    switch (reg % 7) {
      case 0: case 1: v.freq = r[b] | (r[b + 1] << 8); break;
      case 2: case 3: v.pw = r[b + 2] | ((r[b + 3] & 15) << 8); break;
      case 4:
        // the gate changes: the envelope counts anew - the cycles a slow decay had counted would be
        // a burst of fast attack steps
        if ((value & 1) && !(v.ctrl & 1)) { v.state = ATTACK; v.envAcc = 0; }
        if (!(value & 1) && (v.ctrl & 1)) { v.state = RELEASE; v.envAcc = 0; }
        v.ctrl = value;
        break;
      case 5: v.ad = value; break;
      case 6: v.sr = value; break;
    }
  }

  // one step of the envelope counter
  envStep(v) {
    if (v.state === ATTACK) {
      if (++v.env >= 255) { v.env = 255; v.state = DECAY; }
    } else if (v.state === DECAY) {
      if (v.env > (v.sr >> 4) * 17) v.env--;
    } else if (v.env > 0) v.env--;
  }

  // the samples out[from..to), -1 to 1
  render(out, from = 0, to = out.length) {
    const cycles = CLOCK / this.sampleRate, sub = cycles / OVERSAMPLE;
    const scale = this.volume / 15 / (0x800 * 255 * 3 * OVERSAMPLE);      // three voices at their loudest fit
    for (let i = from; i < to; i++) {
      let mix = 0, filtered = 0;
      for (let n = 0; n < 3; n++) {
        const v = this.voices[n];
        // the envelope
        const rate = v.state === ATTACK ? v.ad >> 4 : v.state === DECAY ? v.ad & 15 : v.sr & 15;
        v.envAcc += cycles;
        for (;;) {
          const period = PERIODS[rate] * (v.state === ATTACK ? 1 : expPeriod(v.env));
          if (v.envAcc < period) break;
          v.envAcc -= period;
          this.envStep(v);
          if (v.state !== ATTACK && (v.env === 0 || (v.state === DECAY && v.env <= (v.sr >> 4) * 17))) { v.envAcc = 0; break; }   // it rests
        }
        // the oscillator
        const ctrl = v.ctrl;
        if (!(ctrl & 0xf0)) continue;
        let sum = 0;
        for (let k = 0; k < OVERSAMPLE; k++) {
          if (ctrl & 8) v.acc = 0;                           // the test bit holds the oscillator
          else {
            const next = v.acc + v.freq * sub;
            // the noise register shifts when bit 19 of the oscillator rises
            let clocks = Math.floor((next + 0x80000) / 0x100000) - Math.floor((v.acc + 0x80000) / 0x100000);
            while (clocks-- > 0) {
              const l = v.lfsr;
              v.lfsr = ((l << 1) | (((l >> 22) ^ (l >> 17)) & 1)) & 0x7fffff;
            }
            v.acc = next >= 0x1000000 ? next - 0x1000000 : next;
          }
          const acc = v.acc | 0;
          let w = 0xfff;
          if (ctrl & 0x10) w &= ((acc & 0x800000 ? ~acc : acc) >> 11) & 0xfff;
          if (ctrl & 0x20) w &= acc >> 12;
          if (ctrl & 0x40) w &= (acc >> 12) >= v.pw ? 0xfff : 0;
          if (ctrl & 0x80) {
            const l = v.lfsr;
            w &= ((l >> 20 & 1) << 11) | ((l >> 18 & 1) << 10) | ((l >> 14 & 1) << 9) | ((l >> 11 & 1) << 8)
              | ((l >> 9 & 1) << 7) | ((l >> 5 & 1) << 6) | ((l >> 2 & 1) << 5) | ((l & 1) << 4);
          }
          sum += w - 0x800;
        }
        if (this.route & (1 << n)) filtered += sum * v.env;
        else if (n < 2 || !(this.mode & 8)) mix += sum * v.env;
      }
      if (this.route || this.low || this.band) {
        let high = 0;
        for (let k = 0; k < FILTER_STEPS; k++) {
          this.low += this.cutoff * this.band;
          high = filtered - this.low - this.damp * this.band;
          this.band += this.cutoff * high;
        }
        if (Math.abs(this.low) < 1e-3 && Math.abs(this.band) < 1e-3) this.low = this.band = 0;   // it rests
        mix += (this.mode & 1 ? this.low : 0) + (this.mode & 2 ? this.band : 0) + (this.mode & 4 ? high : 0);
      }
      const s = mix * scale;
      out[i] = s > 1 ? 1 : s < -1 ? -1 : s;
    }
  }
}
