// zip.js - reads and writes zip files: the project packages and the downloads of a build.
// Deflate comes from the browser (CompressionStream 'deflate-raw'); no library. Written files are
// deflated, read files may be stored or deflated. Names are UTF-8. No zip64, no encryption.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function pipe(data, stream) {
  const out = new Response(new Blob([data]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
const deflate = data => pipe(data, new CompressionStream('deflate-raw'));

// inflates at most `limit` bytes: a file that unpacks to more than its zip says (a zip bomb) stops early
async function inflate(data, limit) {
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new Error('unpacks to more than it says');
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// the time and date of MS-DOS, as a zip stores them
function dosTime(d) {
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
           date: ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

// files: Map or object of name -> Uint8Array (or string, written as UTF-8). Returns the zip bytes
export async function writeZip(files, { date = new Date() } = {}) {
  const enc = new TextEncoder();
  const { time, date: day } = dosTime(date);
  const parts = [], central = [];
  let offset = 0;
  for (const [name, value] of files instanceof Map ? files : Object.entries(files)) {
    const data = typeof value === 'string' ? enc.encode(value) : value;
    const packed = await deflate(data);
    const method = packed.length < data.length ? 8 : 0;             // a file that does not shrink is stored
    const body = method ? packed : data;
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 0x0800, true);                                 // the name is UTF-8
    head.setUint16(8, method, true);
    head.setUint16(10, time, true);
    head.setUint16(12, day, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, body.length, true);
    head.setUint32(22, data.length, true);
    head.setUint16(26, nameBytes.length, true);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(8, 0x0800, true);
    dir.setUint16(10, method, true);
    dir.setUint16(12, time, true);
    dir.setUint16(14, day, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, body.length, true);
    dir.setUint32(24, data.length, true);
    dir.setUint16(28, nameBytes.length, true);
    dir.setUint32(42, offset, true);
    parts.push(new Uint8Array(head.buffer), nameBytes, body);
    central.push(new Uint8Array(dir.buffer), nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const dirSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, central.length / 2, true);
  end.setUint16(10, central.length / 2, true);
  end.setUint32(12, dirSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}

// the files of a zip: Map name -> Uint8Array, folders left out. limits: { files, bytes, file }
export async function readZip(bytes, { files: maxFiles = 5000, bytes: maxBytes = 64 << 20, file: maxFile = maxBytes } = {}) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('not a zip file');
  const count = view.getUint16(end + 10, true);
  if (count > maxFiles) throw new Error(`too many files in the zip (${count}, at most ${maxFiles})`);
  let p = view.getUint32(end + 16, true);
  const utf8 = new TextDecoder(), latin = new TextDecoder('latin1');
  const out = new Map();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error('broken zip file');
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const size = view.getUint32(p + 20, true);
    const length = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const nameBytes = bytes.subarray(p + 46, p + 46 + nameLen);
    const name = (flags & 0x0800 ? utf8 : latin).decode(nameBytes).replace(/\\/g, '/');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error(`${name}: encrypted zip files are not supported`);
    if (length > maxFile) throw new Error(`${name}: larger than ${maxFile >> 10} KB`);
    total += length;
    if (total > maxBytes) throw new Error(`the zip unpacks to more than ${maxBytes >> 20} MB`);
    if (view.getUint32(local, true) !== 0x04034b50) throw new Error('broken zip file');
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const body = bytes.subarray(start, start + size);
    let data;
    if (method === 0) data = body.slice();
    else if (method === 8) {
      try { data = await inflate(body, length); } catch (e) { throw new Error(`${name}: ${e.message}`); }
    }
    else throw new Error(`${name}: compression method ${method} is not supported`);
    if (data.length !== length || crc32(data) !== crc) throw new Error(`${name}: damaged in the zip file`);
    out.set(name, data);
  }
  return out;
}
