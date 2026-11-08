// Comments: anchored to one section or behaviour of an item, so they travel with it.
// Sorted within the partition by item, then by id, which starts with the time: one query reads a thread in order.

import { keys, strip } from '../keys.mjs';

export function comments(table) {
  return {
    /** A project's comments, or one item's, oldest first. Query begins_with(SK, COMMENT#[<itemKey>#]). */
    async list(projectId, itemKey = '') {
      return (await table.query(keys.commentsOf(projectId, itemKey))).map(strip);
    },

    /** GetItem by the comment's own fields, or null. */
    async get(projectId, ref) {
      const it = await table.get(keys.comment(projectId, ref));
      return it ? strip(it) : null;
    },

    /** PutItem. */
    async put(projectId, comment) {
      await table.put({ ...keys.comment(projectId, comment), entity: 'comment', ...comment });
    },

    /** DeleteItem. */
    async delete(projectId, ref) {
      await table.delete(keys.comment(projectId, ref));
    },
  };
}
