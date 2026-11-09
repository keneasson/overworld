// Nodes: the items on a project's map. They live in their project's partition.

import { NODE_PREFIX, keys, strip } from '../keys.mjs';
import { itemKeyOf } from '../../../shared/issue-shape.js';

/** A node as stored. One with a sync state (unsaved, saving, conflict, failed) also sits in the sparse PENDING index. */
export const nodeItem = (projectId, node) => ({ ...keys.node(projectId, node.id), ...(node.sync ? keys.pending(projectId, itemKeyOf(node)) : {}), entity: 'node', ...node });

export function nodes(table) {
  const item = nodeItem;

  return {
    /** One node, or null. GetItem: an issue's node is `issue-<number>`, so a webhook needs no more than this. */
    async get(projectId, id) {
      const it = await table.get(keys.node(projectId, id));
      return it ? strip(it) : null;
    },

    /** The nodes not yet in line with their store: unsaved, saving, in conflict or failed. Query GSI1 PK = PENDING#<id>, so the map isn't read. */
    async pending(projectId) {
      return (await table.query(keys.pendingOf(projectId))).map(strip);
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
