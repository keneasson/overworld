// Every entity in the table, and its keys. Access patterns build keys only from here.
//
//   Entity    PK              SK               GSI1PK     GSI1SK
//   Project   PROJECT#<id>    PROJECT          PROJECTS   <updatedAt>
//   Node      PROJECT#<id>    NODE#<nodeId>
//   Flag      APP             FLAG#<name>
//   Changeset PROJECT#<id>    CHANGESET#<changesetId>
//   Comment   PROJECT#<id>    COMMENT#<itemKey>#<commentId>
//
// A project and its nodes share a partition (an item collection): one query reads a
// whole map, and one query finds everything to delete. The map's entities sort last
// (CHANGESET# < COMMENT# < NODE# < PROJECT), so opening a map is one range query from NODE#
// on, and never reads the changesets or comments: those load when they're asked for (DATA-02).
// A new entity in the partition must sort before NODE#, or every map open would read it. Changesets and comments live there too,
// keyed by the item they concern (an issue number, not a node id, since a refresh renews node ids). GSI1 is sparse; only projects
// carry its keys, so it is the list of projects, most recently updated first.

export const ALL_PROJECTS = 'PROJECTS';
export const PROJECT_SK = 'PROJECT';
export const NODE_PREFIX = 'NODE#';
export const CHANGESET_PREFIX = 'CHANGESET#';
export const COMMENT_PREFIX = 'COMMENT#';

const projectPartition = (projectId) => `PROJECT#${projectId}`;

export const keys = {
  project: (id) => ({ PK: projectPartition(id), SK: PROJECT_SK }),
  node: (projectId, nodeId) => ({ PK: projectPartition(projectId), SK: `${NODE_PREFIX}${nodeId}` }),
  flag: (name) => ({ PK: 'APP', SK: `FLAG#${name}` }),
  changeset: (projectId, id) => ({ PK: projectPartition(projectId), SK: `${CHANGESET_PREFIX}${id}` }),
  comment: (projectId, { itemKey, id }) => ({ PK: projectPartition(projectId), SK: `${COMMENT_PREFIX}${itemKey}#${id}` }),
  mapOf: (projectId) => ({ pk: projectPartition(projectId), skFrom: NODE_PREFIX }),
  commentsOf: (projectId, itemKey = '') => ({ pk: projectPartition(projectId), skBeginsWith: `${COMMENT_PREFIX}${itemKey ? `${itemKey}#` : ''}` }),
};

/** Drop the table's bookkeeping, leaving the entity as the API knows it. */
export const strip = ({ PK, SK, GSI1PK, GSI1SK, entity, ...rest }) => rest;
