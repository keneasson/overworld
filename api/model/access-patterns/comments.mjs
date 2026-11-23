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

// What is addressed to agents (#15 NOTE-17): one small row per annotation, so each agent call finds what is waiting
// in one short query, without reading every comment in the project.
export function inbox(table) {
  return {
    /** Everything waiting for an agent, oldest first. Query begins_with(SK, INBOX#). */
    async list(projectId) {
      return (await table.query(keys.inboxOf(projectId))).map(strip);
    },
    /** PutItem: waiting, or handed to an agent. */
    async put(projectId, row) {
      await table.put({ ...keys.inbox(projectId, row.id), entity: 'inbox', ...row });
    },
    /** DeleteItem: an agent has replied. */
    async delete(projectId, id) {
      await table.delete(keys.inbox(projectId, id));
    },
  };
}

// Open questions (#68) live in their item's text; this keeps what the text doesn't say: who asked and answered each, when,
// the prompt a person changed, and whether its answer was applied. One row per question, by item.
export function questions(table) {
  return {
    /** A project's questions, or one item's. Query begins_with(SK, ASK#[<itemKey>#]). */
    async list(projectId, itemKey = '') {
      return (await table.query(keys.questionsOf(projectId, itemKey))).map(strip);
    },
    /** GetItem by the question's item and id, or null. */
    async get(projectId, ref) {
      const it = await table.get(keys.question(projectId, ref));
      return it ? strip(it) : null;
    },
    /** PutItem. */
    async put(projectId, q) {
      await table.put({ ...keys.question(projectId, q), entity: 'question', ...q });
    },
  };
}
