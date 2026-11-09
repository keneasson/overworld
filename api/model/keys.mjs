// Every entity in the table, and its keys. Access patterns build keys only from here.
//
//   Entity    PK              SK               GSI1PK     GSI1SK
//   Project   PROJECT#<id>    PROJECT          PROJECTS   <updatedAt>
//   Node      PROJECT#<id>    NODE#<nodeId>
//   Flag      APP             FLAG#<name>
//   Changeset PROJECT#<id>    CHANGESET#<changesetId>
//   Comment   PROJECT#<id>    COMMENT#<itemKey>#<commentId>
//   Node with a sync state             PENDING#<id> <itemKey>  sparse: only nodes not yet in line with their store
//   Sync job  PROJECT#<id>    JOB#<savedAt>#<itemKey>   the outbox: a saved item still to reach its store
//   Lease     PROJECT#<id>    LEASE#sync         who is syncing this project, until when
//   Budget    PROJECT#<id>    LEASE#budget       the project's recent writes to its store (SYNC-10)
//   Report    PROJECT#<id>    AUDIT#<at>         what a reconciliation with the store fixed
//   Store link STORE#<store key>  PROJECT#<id>  which projects live in a store, e.g. github:owner/name (for its events)
//
// A project and its nodes share a partition (an item collection): one query reads a
// whole map, and one query finds everything to delete. Changesets and comments live there too,
// keyed by the item they concern (an issue number, or a node id for items made here). GSI1 is sparse: projects
// carry its keys, so it lists projects, most recently updated first; and so do nodes that are unsaved, saving, in conflict or
// failed, so a save or a refresh finds them without reading the map. Every prefix in a project's partition other than NODE#
// sorts before it, so the map is one range query.

export const ALL_PROJECTS = 'PROJECTS';
export const PROJECT_SK = 'PROJECT';
export const NODE_PREFIX = 'NODE#';
export const CHANGESET_PREFIX = 'CHANGESET#';
export const COMMENT_PREFIX = 'COMMENT#';
export const JOB_PREFIX = 'JOB#';
export const AUDIT_PREFIX = 'AUDIT#';

const projectPartition = (projectId) => `PROJECT#${projectId}`;

export const keys = {
  project: (id) => ({ PK: projectPartition(id), SK: PROJECT_SK }),
  node: (projectId, nodeId) => ({ PK: projectPartition(projectId), SK: `${NODE_PREFIX}${nodeId}` }),
  flag: (name) => ({ PK: 'APP', SK: `FLAG#${name}` }),
  changeset: (projectId, id) => ({ PK: projectPartition(projectId), SK: `${CHANGESET_PREFIX}${id}` }),
  comment: (projectId, { itemKey, id }) => ({ PK: projectPartition(projectId), SK: `${COMMENT_PREFIX}${itemKey}#${id}` }),
  pending: (projectId, itemKey) => ({ GSI1PK: `PENDING#${projectId}`, GSI1SK: itemKey }),
  pendingOf: (projectId) => ({ index: 'GSI1', pk: `PENDING#${projectId}` }),
  job: (projectId, id) => ({ PK: projectPartition(projectId), SK: `${JOB_PREFIX}${id}` }),
  jobsOf: (projectId) => ({ pk: projectPartition(projectId), skBeginsWith: JOB_PREFIX }),
  lease: (projectId, name) => ({ PK: projectPartition(projectId), SK: `LEASE#${name}` }),
  audit: (projectId, at) => ({ PK: projectPartition(projectId), SK: `${AUDIT_PREFIX}${at}` }),
  auditsOf: (projectId) => ({ pk: projectPartition(projectId), skBeginsWith: AUDIT_PREFIX }),
  storeLink: (key, projectId) => ({ PK: `STORE#${key}`, SK: projectPartition(projectId) }),
  storeLinks: (key) => ({ pk: `STORE#${key}` }),
  commentsOf: (projectId, itemKey = '') => ({ pk: projectPartition(projectId), skBeginsWith: `${COMMENT_PREFIX}${itemKey ? `${itemKey}#` : ''}` }),
};

/** Drop the table's bookkeeping, leaving the entity as the API knows it. */
export const strip = ({ PK, SK, GSI1PK, GSI1SK, entity, ...rest }) => rest;
