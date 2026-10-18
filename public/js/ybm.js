// ybm.js - the Yopaca picture file (.ybm): a C64 picture of the bitmap editor - Koala (.kla) or
// Art Studio (.art), the bytes as they are - with the reference image it is traced from (trace.js)
// and where that is placed. For the computer only (Export and Import of the Bitmap view): in the
// project the picture and its reference are files of their own.
//
//   'YBM1'  4 bytes, the magic
//   n       4 bytes, little endian: the length of the header
//   header  n bytes, JSON: { format: 'kla' | 'art' | 'tbm' (the TED), picture: bytes of the picture,
//           image: { type: 'image/png' | 'image/jpeg' | 'image/gif', size: its bytes } | null,
//           reference: { x, y, scale, opacity, front, shown } | null }
//   picture the bytes of the .kla or .art file
//   image   the bytes of the image, when there is one

const MAGIC = 'YBM1';
export const YBM_RE = /\.ybm$/i;

const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' };
export const imageType = ext => TYPES[String(ext).toLowerCase().replace(/^\./, '')] ?? null;
export const imageExt = type => Object.keys(TYPES).find(k => TYPES[k] === type) ?? null;

// picture: the bytes of the .kla or .art file, format its kind; image: { bytes, type } or null;
// reference: the placement of the image (null without one)
export function encodeYbm({ picture, format, image = null, reference = null }) {
  const header = {
    format,
    picture: picture.length,
    image: image ? { type: image.type, size: image.bytes.length } : null,
    reference: image && reference ? pick(reference) : null,
  };
  const head = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(8 + head.length + picture.length + (image?.bytes.length ?? 0));
  out.set(new TextEncoder().encode(MAGIC), 0);
  new DataView(out.buffer).setUint32(4, head.length, true);
  out.set(head, 8);
  out.set(picture, 8 + head.length);
  if (image) out.set(image.bytes, 8 + head.length + picture.length);
  return out;
}

export const isYbm = bytes => bytes.length >= 8 && new TextDecoder().decode(bytes.subarray(0, 4)) === MAGIC;

// { picture, format, image: { bytes, type } | null, reference | null }; throws when the bytes
// are no .ybm file
export function decodeYbm(bytes) {
  if (!isYbm(bytes)) throw new Error('not a Yopaca picture (.ybm)');
  const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  if (8 + n > bytes.length) throw new Error('the header is cut off');
  let header;
  try { header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + n))); } catch { throw new Error('the header is no JSON'); }
  if (!['kla', 'art'].includes(header?.format) || !Number.isInteger(header.picture)) throw new Error('the header names no picture');
  const at = 8 + n, size = header.image?.size ?? 0;
  if (at + header.picture + size > bytes.length) throw new Error('the file is cut off');
  const picture = bytes.slice(at, at + header.picture);
  const image = header.image && imageExt(header.image.type) ? { bytes: bytes.slice(at + header.picture, at + header.picture + size), type: header.image.type } : null;
  return { picture, format: header.format, image, reference: image && header.reference ? pick(header.reference) : null };
}

// the placement with its numbers checked: a missing one takes what the reference layer takes
function pick(r) {
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return { x: num(r.x, 0), y: num(r.y, 0), scale: Math.max(0.01, num(r.scale, 1)), opacity: Math.min(1, Math.max(0, num(r.opacity, 0.4))),
    front: r.front !== false, shown: r.shown !== false };
}
