// cpu6502.js - a 6502 for the import of .sid files: it runs the init and the play routine of
// a tune and the importer watches what they write to the SID. The legal opcodes, without the
// decimal mode; an unknown opcode counts as a NOP (cpu.unknown counts them). An NMI the importer
// asks for (cpu.nmiPending) comes before the next instruction.

const N = 0x80, V = 0x40, B = 0x10, I = 0x04, Z = 0x02, C = 0x01;

// the opcodes per instruction and addressing mode
const SPEC = {
  ADC: { imm: 0x69, zp: 0x65, zpx: 0x75, abs: 0x6d, abx: 0x7d, aby: 0x79, izx: 0x61, izy: 0x71 },
  AND: { imm: 0x29, zp: 0x25, zpx: 0x35, abs: 0x2d, abx: 0x3d, aby: 0x39, izx: 0x21, izy: 0x31 },
  ASL: { acc: 0x0a, zp: 0x06, zpx: 0x16, abs: 0x0e, abx: 0x1e },
  BCC: { rel: 0x90 }, BCS: { rel: 0xb0 }, BEQ: { rel: 0xf0 }, BMI: { rel: 0x30 }, BNE: { rel: 0xd0 }, BPL: { rel: 0x10 }, BVC: { rel: 0x50 }, BVS: { rel: 0x70 },
  BIT: { zp: 0x24, abs: 0x2c }, BRK: { imp: 0x00 },
  CLC: { imp: 0x18 }, CLD: { imp: 0xd8 }, CLI: { imp: 0x58 }, CLV: { imp: 0xb8 },
  CMP: { imm: 0xc9, zp: 0xc5, zpx: 0xd5, abs: 0xcd, abx: 0xdd, aby: 0xd9, izx: 0xc1, izy: 0xd1 },
  CPX: { imm: 0xe0, zp: 0xe4, abs: 0xec }, CPY: { imm: 0xc0, zp: 0xc4, abs: 0xcc },
  DEC: { zp: 0xc6, zpx: 0xd6, abs: 0xce, abx: 0xde }, DEX: { imp: 0xca }, DEY: { imp: 0x88 },
  EOR: { imm: 0x49, zp: 0x45, zpx: 0x55, abs: 0x4d, abx: 0x5d, aby: 0x59, izx: 0x41, izy: 0x51 },
  INC: { zp: 0xe6, zpx: 0xf6, abs: 0xee, abx: 0xfe }, INX: { imp: 0xe8 }, INY: { imp: 0xc8 },
  JMP: { abs: 0x4c, ind: 0x6c }, JSR: { abs: 0x20 },
  LDA: { imm: 0xa9, zp: 0xa5, zpx: 0xb5, abs: 0xad, abx: 0xbd, aby: 0xb9, izx: 0xa1, izy: 0xb1 },
  LDX: { imm: 0xa2, zp: 0xa6, zpy: 0xb6, abs: 0xae, aby: 0xbe }, LDY: { imm: 0xa0, zp: 0xa4, zpx: 0xb4, abs: 0xac, abx: 0xbc },
  LSR: { acc: 0x4a, zp: 0x46, zpx: 0x56, abs: 0x4e, abx: 0x5e }, NOP: { imp: 0xea },
  ORA: { imm: 0x09, zp: 0x05, zpx: 0x15, abs: 0x0d, abx: 0x1d, aby: 0x19, izx: 0x01, izy: 0x11 },
  PHA: { imp: 0x48 }, PHP: { imp: 0x08 }, PLA: { imp: 0x68 }, PLP: { imp: 0x28 },
  ROL: { acc: 0x2a, zp: 0x26, zpx: 0x36, abs: 0x2e, abx: 0x3e }, ROR: { acc: 0x6a, zp: 0x66, zpx: 0x76, abs: 0x6e, abx: 0x7e },
  RTI: { imp: 0x40 }, RTS: { imp: 0x60 },
  SBC: { imm: 0xe9, zp: 0xe5, zpx: 0xf5, abs: 0xed, abx: 0xfd, aby: 0xf9, izx: 0xe1, izy: 0xf1 },
  SEC: { imp: 0x38 }, SED: { imp: 0xf8 }, SEI: { imp: 0x78 },
  STA: { zp: 0x85, zpx: 0x95, abs: 0x8d, abx: 0x9d, aby: 0x99, izx: 0x81, izy: 0x91 },
  STX: { zp: 0x86, zpy: 0x96, abs: 0x8e }, STY: { zp: 0x84, zpx: 0x94, abs: 0x8c },
  TAX: { imp: 0xaa }, TAY: { imp: 0xa8 }, TSX: { imp: 0xba }, TXA: { imp: 0x8a }, TXS: { imp: 0x9a }, TYA: { imp: 0x98 },
};
const TABLE = [];
for (const [op, modes] of Object.entries(SPEC)) for (const [mode, code] of Object.entries(modes)) TABLE[code] = [op, mode];

export const SENTINEL = 0xfff0;          // a call returns to here

export class Cpu {
  // mem: 64K; onwrite(addr, value) sees every write; onread(addr) may answer a read (not undefined)
  constructor(mem, { onwrite = null, onread = null } = {}) {
    Object.assign(this, { mem, onwrite, onread, a: 0, x: 0, y: 0, s: 0xff, p: 0x24, pc: 0, unknown: 0, nmiPending: false, broke: false });
  }

  read(a) { const v = this.onread?.(a); return v === undefined ? this.mem[a] : v; }
  write(a, v) { this.mem[a] = v; this.onwrite?.(a, v); }
  push(v) { this.mem[0x100 + this.s] = v; this.s = (this.s - 1) & 255; }
  pull() { this.s = (this.s + 1) & 255; return this.mem[0x100 + this.s]; }
  nz(v) { this.p = (this.p & ~(N | Z)) | (v & N) | (v ? 0 : Z); return v; }
  flag(f, on) { this.p = on ? this.p | f : this.p & ~f; }

  // runs the routine at addr until it returns (RTS, or RTI with asIrq) or max instructions
  // passed; false when it did not return
  call(addr, { a = 0, x = 0, y = 0, max = 1000000, asIrq = false, kernal = false } = {}) {
    this.a = a; this.x = x; this.y = y; this.s = 0xff;
    if (asIrq) {
      this.push(SENTINEL >> 8); this.push(SENTINEL & 255); this.push(this.p);
      if (kernal) { this.push(0); this.push(0); this.push(0); }     // A, X, Y of the Kernal's entry: $ea81 pulls them
    } else { this.push((SENTINEL - 1) >> 8); this.push((SENTINEL - 1) & 255); }
    this.pc = addr;
    this.broke = false;
    for (let n = 0; n < max; n++) {
      // the return of the routine: at the mark, with the stack as it was - a routine that sets the
      // stack anew (TXS) and comes by the mark later has not returned
      if (this.pc === SENTINEL && (this.s === 0xff || this.broke)) return true;
      if (this.nmiPending) { this.nmiPending = false; this.nmi(); }
      this.step();
    }
    return false;
  }

  // the NMI: the return address and the flags on the stack, on to the vector at $fffa
  nmi() {
    this.push(this.pc >> 8); this.push(this.pc & 255); this.push((this.p & ~B) | 0x20);
    this.flag(I, true);
    this.pc = this.mem[0xfffa] | (this.mem[0xfffb] << 8);
  }

  step() {
    const m = this.mem, code = m[this.pc], entry = TABLE[code];
    this.pc = (this.pc + 1) & 0xffff;
    if (!entry) { this.unknown++; return; }
    const [op, mode] = entry;
    const byte = () => { const v = m[this.pc]; this.pc = (this.pc + 1) & 0xffff; return v; };
    const word = () => { const lo = byte(); return lo | (byte() << 8); };
    let addr = -1;
    switch (mode) {
      case 'imm': addr = this.pc; this.pc = (this.pc + 1) & 0xffff; break;
      case 'zp': addr = byte(); break;
      case 'zpx': addr = (byte() + this.x) & 255; break;
      case 'zpy': addr = (byte() + this.y) & 255; break;
      case 'abs': addr = word(); break;
      case 'abx': addr = (word() + this.x) & 0xffff; break;
      case 'aby': addr = (word() + this.y) & 0xffff; break;
      case 'izx': { const z = (byte() + this.x) & 255; addr = m[z] | (m[(z + 1) & 255] << 8); break; }
      case 'izy': { const z = byte(); addr = ((m[z] | (m[(z + 1) & 255] << 8)) + this.y) & 0xffff; break; }
      case 'ind': { const p = word(); addr = m[p] | (m[(p & 0xff00) | ((p + 1) & 255)] << 8); break; }
      case 'rel': { const d = byte(); addr = (this.pc + (d < 128 ? d : d - 256)) & 0xffff; break; }
    }
    const value = () => (mode === 'acc' ? this.a : this.read(addr));
    const store = v => { if (mode === 'acc') this.a = v; else this.write(addr, v); };
    const branch = on => { if (on) this.pc = addr; };
    const compare = (r, v) => { this.flag(C, r >= v); this.nz((r - v) & 255); };
    const add = v => {
      const sum = this.a + v + (this.p & C);
      this.flag(V, ~(this.a ^ v) & (this.a ^ sum) & 0x80);
      this.flag(C, sum > 255);
      this.a = this.nz(sum & 255);
    };
    switch (op) {
      case 'ADC': add(value()); break;
      case 'SBC': add(value() ^ 255); break;
      case 'AND': this.a = this.nz(this.a & value()); break;
      case 'ORA': this.a = this.nz(this.a | value()); break;
      case 'EOR': this.a = this.nz(this.a ^ value()); break;
      case 'ASL': { const v = value(); this.flag(C, v & 0x80); store(this.nz((v << 1) & 255)); break; }
      case 'LSR': { const v = value(); this.flag(C, v & 1); store(this.nz(v >> 1)); break; }
      case 'ROL': { const v = value(), c = this.p & C; this.flag(C, v & 0x80); store(this.nz(((v << 1) | c) & 255)); break; }
      case 'ROR': { const v = value(), c = this.p & C; this.flag(C, v & 1); store(this.nz((v >> 1) | (c << 7))); break; }
      case 'BIT': { const v = value(); this.flag(Z, !(this.a & v)); this.flag(N, v & N); this.flag(V, v & V); break; }
      case 'BCC': branch(!(this.p & C)); break;
      case 'BCS': branch(this.p & C); break;
      case 'BEQ': branch(this.p & Z); break;
      case 'BNE': branch(!(this.p & Z)); break;
      case 'BMI': branch(this.p & N); break;
      case 'BPL': branch(!(this.p & N)); break;
      case 'BVC': branch(!(this.p & V)); break;
      case 'BVS': branch(this.p & V); break;
      case 'BRK': this.pc = SENTINEL; this.broke = true; break;   // a tune does not break: the call ends
      case 'CLC': this.flag(C, false); break;
      case 'SEC': this.flag(C, true); break;
      case 'CLI': this.flag(I, false); break;
      case 'SEI': this.flag(I, true); break;
      case 'CLV': this.flag(V, false); break;
      case 'CLD': case 'SED': case 'NOP': break;
      case 'CMP': compare(this.a, value()); break;
      case 'CPX': compare(this.x, value()); break;
      case 'CPY': compare(this.y, value()); break;
      case 'DEC': store(this.nz((value() - 1) & 255)); break;
      case 'INC': store(this.nz((value() + 1) & 255)); break;
      case 'DEX': this.x = this.nz((this.x - 1) & 255); break;
      case 'DEY': this.y = this.nz((this.y - 1) & 255); break;
      case 'INX': this.x = this.nz((this.x + 1) & 255); break;
      case 'INY': this.y = this.nz((this.y + 1) & 255); break;
      case 'JMP': this.pc = addr; break;
      case 'JSR': { const r = (this.pc - 1) & 0xffff; this.push(r >> 8); this.push(r & 255); this.pc = addr; break; }
      case 'RTS': this.pc = ((this.pull() | (this.pull() << 8)) + 1) & 0xffff; break;
      case 'RTI': this.p = (this.pull() & ~B) | 0x20; this.pc = this.pull() | (this.pull() << 8); break;
      case 'LDA': this.a = this.nz(value()); break;
      case 'LDX': this.x = this.nz(value()); break;
      case 'LDY': this.y = this.nz(value()); break;
      case 'STA': this.write(addr, this.a); break;
      case 'STX': this.write(addr, this.x); break;
      case 'STY': this.write(addr, this.y); break;
      case 'PHA': this.push(this.a); break;
      case 'PHP': this.push(this.p | B); break;
      case 'PLA': this.a = this.nz(this.pull()); break;
      case 'PLP': this.p = (this.pull() & ~B) | 0x20; break;
      case 'TAX': this.x = this.nz(this.a); break;
      case 'TAY': this.y = this.nz(this.a); break;
      case 'TSX': this.x = this.nz(this.s); break;
      case 'TXA': this.a = this.nz(this.x); break;
      case 'TXS': this.s = this.x; break;
      case 'TYA': this.a = this.nz(this.y); break;
    }
  }
}
