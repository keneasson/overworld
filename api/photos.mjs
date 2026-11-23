// What a screenshot is, read from its own bytes (#16): the kind of image and its size in pixels. The type a client
// claims is never trusted, so a file that isn't an image is refused whoever sends it (SHOT-04).

import { MAX_PHOTO_BYTES } from '../shared/photos.js';
import { ValidationError } from '../shared/schema.js';

/** @returns {{ mime: string, width: number, height: number }} */
export function imageInfo(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new ValidationError('image: expected the screenshot\'s bytes');
  if (buf.length > MAX_PHOTO_BYTES) throw new ValidationError(`image: at most ${MAX_PHOTO_BYTES / 1_000_000} MB; a smaller or JPEG/WebP screenshot fits`);
  const at = (s, i = 0) => buf.subarray(i, i + s.length).equals(Buffer.from(s, 'latin1'));
  if (at('\x89PNG\r\n\x1a\n') && buf.length >= 24) return { mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if ((at('GIF87a') || at('GIF89a')) && buf.length >= 10) return { mime: 'image/gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (at('RIFF') && at('WEBP', 8) && buf.length >= 30) {
    const chunk = buf.toString('latin1', 12, 16);
    if (chunk === 'VP8X') return { mime: 'image/webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (chunk === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { mime: 'image/webp', width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
    }
    if (chunk === 'VP8 ') return { mime: 'image/webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    // A JPEG's size is in its first start-of-frame segment.
    for (let i = 2; i + 9 < buf.length; ) {
      if (buf[i] !== 0xff) break;
      const marker = buf[i + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { mime: 'image/jpeg', width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  throw new ValidationError('image: expected a PNG, JPEG, WebP or GIF screenshot');
}
