// Screenshots in an item's Photos (#16). A screenshot is bigger than a table item can hold (400 KB), so what it is (one
// small row, by item) is kept apart from its bytes, which are cut into parts that each fit. Replacing it with a newer
// one writes the new version's parts, then the row, then drops the old parts: a write that fails part-way leaves spare
// parts, never a row whose bytes are missing.

import { keys, strip } from '../keys.mjs';

const PART = 350_000; // characters of base64 in one part: an item stays well inside 400 KB

export function photos(table) {
  const partsOf = async (projectId, photo) => (await table.query(keys.photoPartsOf(projectId, photo))).sort((a, b) => (a.SK < b.SK ? -1 : 1));
  return {
    /** An item's screenshots, or a project's, oldest first: what they are, never their bytes. Query begins_with(SK, IMAGE#[<itemKey>#]). */
    async list(projectId, itemKey = '') {
      return (await table.query(keys.photosOf(projectId, itemKey))).map(strip).sort((a, b) => (a.addedAt < b.addedAt ? -1 : a.addedAt > b.addedAt ? 1 : 0));
    },

    /** GetItem: one screenshot, or null. */
    async get(projectId, ref) {
      const it = await table.get(keys.photo(projectId, ref));
      return it ? strip(it) : null;
    },

    /** A screenshot's bytes, as they were sent. Query begins_with(SK, IMGPART#<photoId>#<version>#). */
    async bytes(projectId, photo) {
      return Buffer.from((await partsOf(projectId, photo)).map((p) => p.data).join(''), 'base64');
    },

    /** Batched puts of the parts, then PutItem, then batched deletes of the version before: a new screenshot, or a newer one in its place. */
    async put(projectId, photo, bytes) {
      const data = bytes.toString('base64');
      const puts = [];
      for (let n = 0; n * PART < data.length; n++) puts.push({ ...keys.photoPart(projectId, photo, n), entity: 'photo-part', data: data.slice(n * PART, (n + 1) * PART) });
      await table.write({ puts });
      await table.put({ ...keys.photo(projectId, photo), entity: 'photo', ...photo });
      if (photo.version > 1) {
        const old = await partsOf(projectId, { id: photo.id, version: photo.version - 1 });
        if (old.length) await table.write({ deletes: old.map(({ PK, SK }) => ({ PK, SK })) });
      }
    },

    /** DeleteItem, then batched deletes of its parts. */
    async delete(projectId, photo) {
      await table.delete(keys.photo(projectId, photo));
      const parts = await partsOf(projectId, photo);
      if (parts.length) await table.write({ deletes: parts.map(({ PK, SK }) => ({ PK, SK })) });
    },
  };
}

// One-time links an agent sends a screenshot's bytes to (SHOT-04): found by the link's hash in one GetItem, outside any
// partition, used once, and gone after 15 minutes (the table's TTL, checked on read too).
export function uploads(table) {
  return {
    /** PutItem. */
    async put(hash, row) {
      await table.put({ ...keys.upload(hash), entity: 'upload', ...row });
    },
    /** GetItem, then DeleteItem: the link's row, once, while it lasts; otherwise null. */
    async take(hash, nowSeconds) {
      const it = await table.get(keys.upload(hash));
      if (!it) return null;
      await table.delete(keys.upload(hash));
      return it.expiresAt > nowSeconds ? strip(it) : null;
    },
  };
}
