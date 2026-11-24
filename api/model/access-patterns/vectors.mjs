// Each behaviour's embedding (#36 COHERE-08): what the spec's check last embedded it from (its text hash and model), so a
// check anywhere, CI included, embeds only what changed. The vector is kept packed (int8 and a scale, base64, see
// shared/coherence.js), about 400 bytes, in the project's partition before NODE#, so a map open never reads them.

import { keys, strip } from '../keys.mjs';

export function vectors(table) {
  return {
    /** Every vector in a project, by item and behaviour. Query begins_with(SK, EMBED#). */
    async list(projectId) {
      return (await table.query(keys.vectorsOf(projectId))).map(strip);
    },
    /** Keep new vectors, over any for the same behaviour, and drop those whose behaviour is gone. Batched writes. */
    async write(projectId, { puts = [], removes = [] }) {
      await table.write({
        puts: puts.map((v) => ({ ...keys.vector(projectId, v), entity: 'vector', ...v })),
        deletes: removes.map((r) => keys.vector(projectId, { item: r.item, behaviourId: r.id })),
      });
    },
  };
}
