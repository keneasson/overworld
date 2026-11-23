// What the spec's own check found (#36, COHERE-04, COHERE-05): pairs of behaviours close in meaning, each with the model
// that found it and, once someone has looked, their judgement. Kept in the project's partition, before NODE#, so a map
// open never reads them and deleting the project takes them with it.

import { keys, strip } from '../keys.mjs';

export function findings(table) {
  return {
    /** Every finding in a project. Query begins_with(SK, COHERE#). */
    async list(projectId) {
      return (await table.query(keys.findingsOf(projectId))).map(strip);
    },
    /** One finding by its pair key, or null. GetItem. */
    async get(projectId, key) {
      const it = await table.get(keys.finding(projectId, key));
      return it ? strip(it) : null;
    },
    /** Record findings (a check's pairs, or a judgement). Batched puts. */
    async put(projectId, list) {
      await table.write({ puts: list.map((f) => ({ ...keys.finding(projectId, f.key), entity: 'finding', ...f })) });
    },
  };
}
