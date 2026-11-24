// The spec checks itself (#36, COHERE-01, COHERE-04, COHERE-07): what one project's behaviours say against each other.
//
// Two layers, cheapest first. The deterministic one needs no model: the same behaviour ID in two items, and two words for
// one thing (the vocabulary below). The second finds pairs of behaviours close in meaning across items, from embeddings the
// caller supplies: the embedder is passed in, so this module never loads a model and tests use a fake one. Judging a close
// pair (duplicate, contradiction or unrelated) is left to a strong model or an agent; a small local classifier was noise.
//
// A behaviour here is { id, item, title, text }: its ID, its item's key (issue-12), that item's title and the behaviour's words.

/**
 * Word families: two names for one thing (COHERE-01). The first term is the one the project means to keep. Each term matches
 * as the start of a word, so `adopt` finds adopted and adoption. Curated by hand: add a family when drift is noticed.
 */
export const VOCABULARY = [
  { thing: 'a proposed change to the spec', terms: ['refinement', 'changeset'] },
  { thing: 'a remark anchored to the map', terms: ['comment', 'annotation'] },
  { thing: 'putting a comment away', terms: ['dismiss', 'resolve'] },
  { thing: 'making a proposal part of the spec', terms: ['adopt', 'accept'] },
  { thing: 'land with no work on it', terms: ['desert', 'badlands'] },
];

/** Pairs at least this close in meaning are worth judging: the spike found almost all of them real at 0.85 (bge-small). */
export const NEAR = 0.85;

/** A short, stable hash of a behaviour's words: findings and cached vectors are keyed by it, so an edit makes them stale. */
export function textHash(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  let h1 = 0xdeadbeef ^ s.length;
  let h2 = 0x41c6ce57 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const where = (b) => ({ item: b.item, title: b.title, text: b.text });

/** The same behaviour ID in more than one item (EDIT-01 in #5 and #41): [{ id, items: [{ item, title, text }] }], by ID. */
export function duplicateIds(behaviours) {
  const seen = new Map();
  for (const b of behaviours) if (b.id) seen.set(b.id, [...(seen.get(b.id) ?? []), b]);
  return [...seen]
    .filter(([, list]) => new Set(list.map((b) => b.item)).size > 1)
    .map(([id, list]) => ({ id, items: list.map(where).sort((x, y) => byKey(x.item, y.item)) }))
    .sort((x, y) => byKey(x.id, y.id));
}

/**
 * Vocabulary drift (COHERE-01): each family whose terms are both in use, with which items use which term.
 * @returns {{ thing: string, keep: string, terms: { term: string, items: string[], behaviours: string[] }[] }[]}
 */
export function vocabularyDrift(behaviours, families = VOCABULARY) {
  const out = [];
  for (const { thing, terms } of families) {
    const used = terms
      .map((term) => {
        const rx = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
        const hits = behaviours.filter((b) => rx.test(b.text));
        return { term, items: [...new Set(hits.map((b) => b.item))].sort(byKey), behaviours: [...new Set(hits.map((b) => b.id))].sort(byKey) };
      })
      .filter((t) => t.items.length);
    if (used.length > 1) out.push({ thing, keep: terms[0], terms: used });
  }
  return out;
}

/** Does either behaviour name the other's ID? A deliberate cross-reference ("as HANDOFF-02 says") is not a duplicate. */
export function citesEachOther(a, b) {
  const names = (text, id) => a.id !== b.id && new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text);
  return names(a.text, b.id) || names(b.text, a.id);
}

/** The key of a pair, the same whichever side comes first. */
export const pairKey = (a, b) => [`${a.item}:${a.id}`, `${b.item}:${b.id}`].sort(byKey).join('|');

/**
 * Vectors for each behaviour's words, by text hash, embedding only what the cache hasn't got.
 * @param {{ model: string, embed: (texts: string[]) => Promise<number[][]> }} embedder vectors normalised to length 1
 * @param {Map<string, number[]>} [cache] hash -> vector for this embedder's model; filled in place
 */
export async function embedBehaviours(behaviours, embedder, cache = new Map()) {
  const missing = [...new Map(behaviours.map((b) => [textHash(b.text), b.text])).entries()].filter(([h]) => !cache.has(h));
  for (let i = 0; i < missing.length; i += 32) {
    const batch = missing.slice(i, i + 32);
    const vectors = await embedder.embed(batch.map(([, t]) => t));
    batch.forEach(([h], k) => cache.set(h, vectors[k]));
  }
  return cache;
}

const dot = (a, b) => {
  let s = 0;
  for (let k = 0; k < a.length; k++) s += a[k] * b[k];
  return s;
};

/**
 * Pairs of behaviours in different items that sit close in meaning (COHERE-04), each recording the model it came from
 * (COHERE-07). With `changed`, only pairs with at least one changed behaviour are compared: the cost follows the change.
 * @param {object} o
 * @param {object[]} o.behaviours every behaviour in the project
 * @param {Map<string, number[]>} o.vectors hash -> vector, from embedBehaviours
 * @param {Set<string>} [o.changed] the text hashes that changed; leave out to compare everything
 * @param {{ model: string, version?: string }} o.embedder
 * @returns {{ key: string, cosine: number, model: string, version?: string, a: object, b: object }[]} closest first
 */
export function nearPairs({ behaviours, vectors, changed = null, threshold = NEAR, embedder }) {
  const list = behaviours.map((b) => ({ ...b, hash: textHash(b.text) })).filter((b) => vectors.has(b.hash));
  const out = new Map();
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (a.item === b.item) continue;
      if (changed && !changed.has(a.hash) && !changed.has(b.hash)) continue;
      const cosine = Math.round(dot(vectors.get(a.hash), vectors.get(b.hash)) * 1e4) / 1e4;
      if (cosine < threshold || citesEachOther(a, b)) continue;
      const key = pairKey(a, b);
      const [x, y] = `${a.item}:${a.id}` < `${b.item}:${b.id}` ? [a, b] : [b, a];
      out.set(key, { key, cosine, model: embedder.model, ...(embedder.version ? { version: embedder.version } : {}), a: side(x), b: side(y) });
    }
  }
  return [...out.values()].sort((p, q) => q.cosine - p.cosine || byKey(p.key, q.key));
}

const side = (b) => ({ id: b.id, item: b.item, hash: b.hash });

/**
 * A vector as the project keeps it: int8, with one float32 scale in front, base64 (388 bytes for bge-small's 384 dims).
 * Rounding moves a cosine by about 0.001, well under what separates a close pair from the rest.
 */
export function packVector(vector) {
  const max = vector.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
  const scale = max / 127 || 1;
  const bytes = new Uint8Array(4 + vector.length);
  new DataView(bytes.buffer).setFloat32(0, scale, true);
  const q = new Int8Array(bytes.buffer, 4);
  vector.forEach((x, k) => (q[k] = Math.max(-127, Math.min(127, Math.round(x / scale)))));
  return toBase64(bytes);
}

/** A stored vector back as numbers, normalised to length 1 again so a dot product is still a cosine. */
export function unpackVector(packed) {
  const bytes = fromBase64(packed);
  const scale = new DataView(bytes.buffer, bytes.byteOffset).getFloat32(0, true);
  const v = Array.from(new Int8Array(bytes.buffer, bytes.byteOffset + 4, bytes.length - 4), (x) => x * scale);
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

const toBase64 = (bytes) => (typeof Buffer !== 'undefined' ? Buffer.from(bytes).toString('base64') : btoa(String.fromCharCode(...bytes)));
const fromBase64 = (s) => (typeof Buffer !== 'undefined' ? new Uint8Array(Buffer.from(s, 'base64')) : Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

/** Where a behaviour's vector is kept: by item and ID, since one ID can sit in two items (duplicateIds). */
export const vectorKey = (b) => `${b.item}:${b.id}`;

/**
 * What a check has to do, worked out before any model loads: the behaviours whose words or model changed since their
 * vectors were kept, the vectors still good (by text hash), and the kept vectors whose behaviour is gone.
 * @param {object[]} behaviours every behaviour now, each with its hash
 * @param {{ behaviourId: string, item: string, textHash: string, model: string, vector: string }[]} stored what the project keeps
 * @returns {{ embed: object[], vectors: Map<string, number[]>, remove: { id: string, item: string }[] }}
 */
export function planVectors(behaviours, stored, model) {
  const kept = new Map(stored.filter((v) => v.model === model).map((v) => [`${v.item}:${v.behaviourId}`, v]));
  const vectors = new Map();
  for (const v of kept.values()) if (!vectors.has(v.textHash)) vectors.set(v.textHash, unpackVector(v.vector));
  const now = new Set(behaviours.map(vectorKey));
  return {
    embed: behaviours.filter((b) => kept.get(vectorKey(b))?.textHash !== (b.hash ?? textHash(b.text))),
    vectors,
    remove: stored.filter((v) => !now.has(`${v.item}:${v.behaviourId}`)).map((v) => ({ id: v.behaviourId, item: v.item })),
  };
}
