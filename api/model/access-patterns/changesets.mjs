// Changesets: edits to several items of one area, reviewed and accepted (or discarded) as one.
// They live in their project's partition.

import { CHANGESET_PREFIX, keys, strip } from '../keys.mjs';

export function changesets(table) {
  const item = (projectId, cs) => ({ ...keys.changeset(projectId, cs.id), entity: 'changeset', ...cs });

  return {
    /** Every changeset of a project, oldest first. Query begins_with(SK, CHANGESET#). */
    async list(projectId) {
      const items = await table.query({ pk: keys.project(projectId).PK, skBeginsWith: CHANGESET_PREFIX });
      return items.map(strip).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    /** GetItem, or null. */
    async get(projectId, id) {
      const it = await table.get(keys.changeset(projectId, id));
      return it ? strip(it) : null;
    },

    /** PutItem. */
    async put(projectId, cs) {
      await table.put(item(projectId, cs));
    },
  };
}
