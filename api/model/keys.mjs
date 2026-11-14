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
//   Agent     PROJECT#<id>    AGENT#<agentId>    an agent that may use the project through MCP (#4)
//   Seen      PROJECT#<id>    AGENT#<agentId>#SEEN  when the agent last called, at most every few minutes (CONN-07)
//   Token     TOKEN#<sha256>  TOKEN              an agent's token, by its hash; the token itself is never stored
//   Claim     PROJECT#<id>    CLAIM#<behaviourId>  who is coding a behaviour, until when (MCP-04)
//   Handoff   PROJECT#<id>    HANDOFF#<itemKey>#<at>#<id>  where work on an item stands, when a claim ends (MCP-09)
//   Fact      PROJECT#<id>    FACT#<at>#<id>     a standing decision or correction, remembered (MCP-10)
//   Action    PROJECT#<id>    ACTION#<at>#<id>   ACTIONS#<id>#<agentId> <at>   what an agent changed (MCP-14)
//   Request   PROJECT#<id>    KEY#<agentId>#<requestKey>  a change's result, kept a day for repeats (MCP-12)
//   Limit     PROJECT#<id>    LIMIT#<agentId>#<minute>    an agent's calls this minute (MCP-13)
//
// A project and its nodes share a partition (an item collection): one query reads a
// whole map, and one query finds everything to delete. The map's entities sort last: every prefix in a
// project's partition other than NODE# (CHANGESET#, COMMENT#, JOB#, LEASE#, AUDIT#) sorts before it, and
// PROJECT after it, so opening a map is one range query from NODE# on, and never reads the changesets,
// comments or sync's records: those load when they're asked for (DATA-02). A new entity in the partition
// must sort before NODE#, or every map open would read it. Changesets and comments are keyed by the item
// they concern (an issue number, or a node id for items made here). GSI1 is sparse: projects carry its keys,
// so it lists projects, most recently updated first; and so do nodes that are unsaved, saving, in conflict
// or failed, so a save or a refresh finds them without reading the map. Agents' records (AGENT#, CLAIM#, HANDOFF#,
// FACT#, ACTION#, KEY#, LIMIT#) sort before NODE# too, and actions carry GSI1 keys so one agent's work lists alone.
// Requests and limits carry `expiresAt`, the table's TTL, so they clean themselves up. A token sits outside the
// partition, so a call finds its agent in one read; deleting a project deletes its agents' tokens first.

export const ALL_PROJECTS = 'PROJECTS';
export const PROJECT_SK = 'PROJECT';
export const NODE_PREFIX = 'NODE#';
export const CHANGESET_PREFIX = 'CHANGESET#';
export const COMMENT_PREFIX = 'COMMENT#';
export const JOB_PREFIX = 'JOB#';
export const AUDIT_PREFIX = 'AUDIT#';
export const AGENT_PREFIX = 'AGENT#';
export const CLAIM_PREFIX = 'CLAIM#';
export const FACT_PREFIX = 'FACT#';

const projectPartition = (projectId) => `PROJECT#${projectId}`;

export const keys = {
  project: (id) => ({ PK: projectPartition(id), SK: PROJECT_SK }),
  node: (projectId, nodeId) => ({ PK: projectPartition(projectId), SK: `${NODE_PREFIX}${nodeId}` }),
  flag: (name) => ({ PK: 'APP', SK: `FLAG#${name}` }),
  changeset: (projectId, id) => ({ PK: projectPartition(projectId), SK: `${CHANGESET_PREFIX}${id}` }),
  comment: (projectId, { itemKey, id }) => ({ PK: projectPartition(projectId), SK: `${COMMENT_PREFIX}${itemKey}#${id}` }),
  mapOf: (projectId) => ({ pk: projectPartition(projectId), skFrom: NODE_PREFIX }),
  pending: (projectId, itemKey) => ({ GSI1PK: `PENDING#${projectId}`, GSI1SK: itemKey }),
  pendingOf: (projectId) => ({ index: 'GSI1', pk: `PENDING#${projectId}` }),
  job: (projectId, id) => ({ PK: projectPartition(projectId), SK: `${JOB_PREFIX}${id}` }),
  jobsOf: (projectId) => ({ pk: projectPartition(projectId), skBeginsWith: JOB_PREFIX }),
  lease: (projectId, name) => ({ PK: projectPartition(projectId), SK: `LEASE#${name}` }),
  audit: (projectId, at) => ({ PK: projectPartition(projectId), SK: `${AUDIT_PREFIX}${at}` }),
  auditsOf: (projectId) => ({ pk: projectPartition(projectId), skBeginsWith: AUDIT_PREFIX }),
  storeLink: (key, projectId) => ({ PK: `STORE#${key}`, SK: projectPartition(projectId) }),
  storeLinks: (key) => ({ pk: `STORE#${key}` }),
  agent: (projectId, agentId) => ({ PK: projectPartition(projectId), SK: `${AGENT_PREFIX}${agentId}` }),
  agentSeen: (projectId, agentId) => ({ PK: projectPartition(projectId), SK: `${AGENT_PREFIX}${agentId}#SEEN` }),
  agentsOf: (projectId) => ({ pk: projectPartition(projectId), skBeginsWith: AGENT_PREFIX }),
  token: (hash) => ({ PK: `TOKEN#${hash}`, SK: 'TOKEN' }),
  claim: (projectId, behaviourId) => ({ PK: projectPartition(projectId), SK: `${CLAIM_PREFIX}${behaviourId}` }),
  claimsOf: (projectId) => ({ pk: projectPartition(projectId), skBeginsWith: CLAIM_PREFIX }),
  handoff: (projectId, { itemKey, at, id }) => ({ PK: projectPartition(projectId), SK: `HANDOFF#${itemKey}#${at}#${id}` }),
  handoffsOf: (projectId, itemKey) => ({ pk: projectPartition(projectId), skBeginsWith: `HANDOFF#${itemKey}#` }),
  fact: (projectId, { at, id }) => ({ PK: projectPartition(projectId), SK: `${FACT_PREFIX}${at}#${id}` }),
  factsOf: (projectId) => ({ pk: projectPartition(projectId), skBeginsWith: FACT_PREFIX }),
  action: (projectId, { at, id }) => ({ PK: projectPartition(projectId), SK: `ACTION#${at}#${id}` }),
  agentActions: (projectId, agentId, at) => ({ GSI1PK: `ACTIONS#${projectId}#${agentId}`, GSI1SK: at }),
  actionsOf: (projectId, agentId) => ({ index: 'GSI1', pk: `ACTIONS#${projectId}#${agentId}` }),
  request: (projectId, agentId, requestKey) => ({ PK: projectPartition(projectId), SK: `KEY#${agentId}#${requestKey}` }),
  limit: (projectId, agentId, minute) => ({ PK: projectPartition(projectId), SK: `LIMIT#${agentId}#${minute}` }),
  commentsOf: (projectId, itemKey = '') => ({ pk: projectPartition(projectId), skBeginsWith: `${COMMENT_PREFIX}${itemKey ? `${itemKey}#` : ''}` }),
};

/** Drop the table's bookkeeping, leaving the entity as the API knows it. */
export const strip = ({ PK, SK, GSI1PK, GSI1SK, entity, ...rest }) => rest;
