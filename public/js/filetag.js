// filetag.js - the version of the editor that wrote a binary file of a game (its git tag, as the
// header bar shows it: v1.4.3), in a trailer at the end of the file:
//   the tag (ASCII, up to 64 bytes), its length (1 byte), 'YTAG'
// The format version after the magic of a file (.gfx YSCR, .spr YSPR, .til YTIL, .sng YSNG)
// decides whether a reader can read it (migrate.js); the tag only says who wrote it. It comes
// after the data, so the readers of every version - an older editor, advc (advc/adv/filetag.go) -
// read the file as before; the readers of this editor take it off first (readTag).

const MAGIC = [0x59, 0x54, 0x41, 0x47];      // 'YTAG'
const MAX = 64;

// the tag the encoders write: the version of this editor (app.js, from /api/info), none in tests
let writer = null;
export function setWriterTag(tag) { writer = tag ? String(tag).replace(/[^\x20-\x7e]/g, '').slice(0, MAX) || null : null; }
export const writerTag = () => writer;

// the bytes of a file with the tag at its end (none: as they are)
export function withTag(bytes, tag = writer) {
  if (!tag) return bytes;
  const t = [...tag].map(c => c.charCodeAt(0));
  const out = new Uint8Array(bytes.length + t.length + 1 + MAGIC.length);
  out.set(bytes);
  out.set(t, bytes.length);
  out[bytes.length + t.length] = t.length;
  out.set(MAGIC, bytes.length + t.length + 1);
  return out;
}

// { data, tag }: the bytes of a file without its tag, and the tag (null: a file without one)
export function readTag(bytes) {
  const n = bytes?.length ?? 0;
  if (n < MAGIC.length + 1 || MAGIC.some((b, k) => bytes[n - MAGIC.length + k] !== b)) return { data: bytes, tag: null };
  const len = bytes[n - MAGIC.length - 1], start = n - MAGIC.length - 1 - len;
  if (len > MAX || start < 5) return { data: bytes, tag: null };
  const t = bytes.subarray(start, start + len);
  if ([...t].some(b => b < 0x20 || b > 0x7e)) return { data: bytes, tag: null };
  return { data: bytes.subarray(0, start), tag: String.fromCharCode(...t) };
}
