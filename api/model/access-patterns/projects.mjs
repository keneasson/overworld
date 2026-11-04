// Projects: the list, a whole map, a project's summary, and deleting all of it.

import { ALL_PROJECTS, NODE_PREFIX, PROJECT_SK, keys, strip } from '../keys.mjs';

export function projects(table) {
  const item = (project) => ({
    ...keys.project(project.id),
    GSI1PK: ALL_PROJECTS,
    GSI1SK: project.updatedAt ?? project.createdAt ?? '0',
    entity: 'project',
    ...project,
  });

  return {
    /** Every project, most recently updated first. Query GSI1. */
    async list() {
      return (await table.query({ index: 'GSI1', pk: ALL_PROJECTS, newestFirst: true })).map(strip);
    },

    /** A project and all of its nodes, or null. One query of the project's partition. */
    async getWithNodes(id) {
      const items = await table.query({ pk: keys.project(id).PK });
      const head = items.find((it) => it.SK === PROJECT_SK);
      if (!head) return null;
      return { project: strip(head), nodes: items.filter((it) => it.SK.startsWith(NODE_PREFIX)).map(strip) };
    },

    /** Save a project's summary (title, counts, timestamps). PutItem. */
    async put(project) {
      await table.put(item(project));
    },

    /** Delete a project and everything in its partition. Query, then batched deletes. */
    async delete(id) {
      const items = await table.query({ pk: keys.project(id).PK });
      await table.write({ deletes: items.map(({ PK, SK }) => ({ PK, SK })) });
    },
  };
}
