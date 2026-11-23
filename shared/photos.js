// Screenshots in an item's Photos (#16), and the pins on them. A pin is a comment (#15) anchored to a spot or a region of
// one screenshot: x and y are fractions of its width and height from the top left, so a pin stays put however big the
// picture is drawn. Where a screenshot came from (uploaded here, given to an agent, captured in a browser) is kept, and
// changes nothing about it (SHOT-04). The API, the MCP server and the web app all read pins through this.

import { ValidationError } from './schema.js';

/** The kinds of image a screenshot can be. */
export const PHOTO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
/** The largest screenshot kept, in bytes: a request to the app's function carries at most 6 MB. */
export const MAX_PHOTO_BYTES = 4_000_000;
/** Where a screenshot came from. It is said, never acted on (SHOT-04). */
export const PHOTO_SOURCES = ['upload', 'agent', 'browser'];
export const SOURCE_WORDS = { upload: 'uploaded', agent: 'given to an agent', browser: 'captured in a browser' };

const fraction = (v, what) => {
  const n = Number(v);
  if (v == null || v === '' || !Number.isFinite(n) || n < 0 || n > 1) throw new ValidationError(`${what}: expected a fraction from 0 to 1`);
  return Math.round(n * 10000) / 10000;
};

/** A pin's spot as the API keeps it: x and y, and a region's width and height when it is one, all fractions. */
export function cleanSpot(a = {}) {
  const spot = { x: fraction(a.x, 'anchor.x'), y: fraction(a.y, 'anchor.y') };
  if (a.w != null || a.h != null) {
    spot.w = fraction(a.w, 'anchor.w');
    spot.h = fraction(a.h, 'anchor.h');
    if (spot.x + spot.w > 1.0001 || spot.y + spot.h > 1.0001) throw new ValidationError('anchor: the region runs off the screenshot');
    if (!spot.w || !spot.h) (delete spot.w), delete spot.h;
  }
  return spot;
}

/** Is this anchor a pin on a screenshot in Photos? */
export const isPin = (a) => a?.on === 'image' && Boolean(a.photo);

/**
 * Is this pin possibly out of date (SHOT-02): its screenshot was replaced by a newer one since it was pinned, and nobody
 * has confirmed or moved it since. A pin on a screenshot that has gone is too.
 */
export const isStale = (anchor, photo) => isPin(anchor) && (!photo || (anchor.version ?? 1) < (photo.version ?? 1));

const pct = (f) => `${Math.round(f * 100)}%`;

/** Where a pin sits, in words and pixels: "34% from the left and 12% from the top (about 435, 96 of 1280×800)". */
export function spotWords(a, photo) {
  const px = photo?.width && photo?.height ? (f, of) => Math.round(f * of) : null;
  const at = `${pct(a.x)} from the left and ${pct(a.y)} from the top`;
  const pixels = px ? ` (about ${px(a.x, photo.width)}, ${px(a.y, photo.height)} of ${photo.width}×${photo.height} pixels)` : '';
  if (a.w == null) return `the spot ${at}${pixels}`;
  const size = px ? `, ${px(a.w, photo.width)}×${px(a.h, photo.height)} pixels` : '';
  return `the region whose top left is ${at}${pixels}, ${pct(a.w)} wide and ${pct(a.h)} high${size}`;
}

/** What a screenshot is called: its caption, or where it came from and when. */
export const photoName = (p) => p?.caption || `Screenshot ${SOURCE_WORDS[p?.source] ?? 'added'}${p?.addedAt ? ` ${p.addedAt.slice(0, 10)}` : ''}`;
