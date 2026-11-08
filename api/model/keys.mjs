// Every entity in the table, and its keys. Access patterns build keys only from here.
//
//   Entity    PK              SK               GSI1PK     GSI1SK
//   Project   PROJECT#<id>    PROJECT          PROJECTS   <updatedAt>
//   Node      PROJECT#<id>    NODE#<nodeId>
//   Flag      APP             FLAG#<name>
//   Changeset PROJECT#<id>    CHANGESET#<changesetId>
//   Comment   PROJECT#<id>    COMMENT#<itemKey>#<commentId>
//   Sync job  PROJECT#<id>    JOB#<jobId>        the outbox: an accepted changeset still to reach GitHub
//   Lease     PROJECT#<id>    LEASE#sync         who is syncing this project, until when
//   Report    PROJECT#<id>    AUDIT#<at>         what a reconciliation with GitHub fixed
//   Repo link REPO#<owner/name>  PROJECT#<id>    which projects map a repository (for webhooks)
//
// A project and its nodes share a partition (an item collection): one query reads a
// whole map, and one query finds everything to delete. Changesets and comments live there too,
// keyed by the item they concern (an issue number, not a node id, since a refresh renews node ids). GSI1 is sparse; only projects
// carry its keys, so it is the list of projects, most recently updated first.

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
  job: (projectId, id) => ({ PK: projectPartition(projectId), SK: `${JOB_PREFIX}${id}` }),
  jobsOf: (projectId) => ({ pk: projectPartition(projectId), skBeginsWith: JOB_PREFIX }),
  lease: (projectId, name) => ({ PK: projectPartition(projectId), SK: `LEASE#${name}` }),
  audit: (projectId, at) => ({ PK: projectPartition(projectId), SK: `${AUDIT_PREFIX}${at}` }),
  auditsOf: (projectId) => ({ pk: projectPartition(projectId), skBeginsWith: AUDIT_PREFIX }),
  repoLink: (repo, projectId) => ({ PK: `REPO#${repo.toLowerCase()}`, SK: projectPartition(projectId) }),
  repoLinks: (repo) => ({ pk: `REPO#${repo.toLowerCase()}` }),
  commentsOf: (projectId, itemKey = '') => ({ pk: projectPartition(projectId), skBeginsWith: `${COMMENT_PREFIX}${itemKey ? `${itemKey}#` : ''}` }),
};

/** Drop the table's bookkeeping, leaving the entity as the API knows it. */
export const strip = ({ PK, SK, GSI1PK, GSI1SK, entity, ...rest }) => rest;
