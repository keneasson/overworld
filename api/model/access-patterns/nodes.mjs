// Nodes: the items on a project's map. They live in their project's partition.

import { NODE_PREFIX, keys, strip } from '../keys.mjs';

export function nodes(table) {
  const item = (projectId, node) => ({ ...keys.node(projectId, node.id), entity: 'node', ...node });

  return {
    /** One node, or null. GetItem: an issue's node is `issue-<number>`, so a webhook needs no more than this. */
    async get(projectId, id) {
      const it = await table.get(keys.node(projectId, id));
      return it ? strip(it) : null;
    },

    /** Add or replace nodes. Batched puts. */
    async put(projectId, list) {
      await table.write({ puts: list.map((n) => item(projectId, n)) });
    },

    /** Delete nodes by id. Batched deletes. */
    async delete(projectId, ids) {
      await table.write({ deletes: ids.map((id) => keys.node(projectId, id)) });
    },

    /**
     * Swap a project's whole map for a new one (a GitHub refresh). The new nodes are
     * written before the old ones are deleted, so a failure leaves extras, never a hole.
     */
    async replace(projectId, list) {
      const keep = new Set(list.map((n) => n.id));
      const current = await table.query({ pk: keys.project(projectId).PK, skBeginsWith: NODE_PREFIX });
      await table.write({
        puts: list.map((n) => item(projectId, n)),
        deletes: current.filter((it) => !keep.has(it.id)).map(({ PK, SK }) => ({ PK, SK })),
      });
    },
  };
}
