// Every entity in the table, and its keys. Access patterns build keys only from here.
//
//   Entity    PK              SK               GSI1PK     GSI1SK
//   Project   PROJECT#<id>    PROJECT          PROJECTS   <updatedAt>
//   Node      PROJECT#<id>    NODE#<nodeId>
//   Flag      APP             FLAG#<name>
//   Changeset PROJECT#<id>    CHANGESET#<changesetId>
//   Comment   PROJECT#<id>    COMMENT#<itemKey>#<commentId>
//   Question  PROJECT#<id>    ASK#<itemKey>#<questionId>  who asked and answered an item's open question, and when (#68)
//   Inbox     PROJECT#<id>    INBOX#<commentId>  an annotation addressed to an agent, until an agent replies (#15 NOTE-17)
//   Node with a sync state, or new in a refinement   PENDING#<id> <itemKey>  sparse: only nodes not yet in line with their store
//   Sync job  PROJECT#<id>    JOB#<savedAt>#<itemKey>   the outbox: a saved item still to reach its store
//   Lease     PROJECT#<id>    LEASE#sync         who is syncing this project, until when
//   Budget    PROJECT#<id>    LEASE#budget       the project's recent writes to its store (SYNC-10)
//   Report    PROJECT#<id>    AUDIT#<at>         what a reconciliation with the store fixed
//   Error     ERRORS          ERROR#<at>#<id>    an error a browser caught and sent, kept 30 days (#71 SHIP-14)
//   Store link STORE#<store key>  PROJECT#<id>  which projects live in a store, e.g. github:owner/name (for its events)
//   Agent     PROJECT#<id>    AGENT#<agentId>    an agent that may use the project through MCP (#4)
//   Seen      PROJECT#<id>    AGENT#<agentId>#SEEN  when the agent last called, at most every few minutes (CONN-07)
//   Token     TOKEN#<sha256>  TOKEN              an agent's token, by its hash; the token itself is never stored
//   Claim     PROJECT#<id>    CLAIM#<behaviourId>  who is coding a behaviour, until when (MCP-04)
//   Handoff   PROJECT#<id>    HANDOFF#<itemKey>#<at>#<id>  where work on an item stands, when a claim ends (MCP-09)
//   Fact      PROJECT#<id>    FACT#<at>#<id>     a standing decision or correction, remembered (MCP-10)
//   Build     PROJECT#<id>    BUILD#<itemKey>#<id>  a person's request to build behaviours, until a builder claims them (#14 HANDOFF-05)
//   Action    PROJECT#<id>    ACTION#<at>#<id>   ACTIONS#<id>#<agentId> <at>   what an agent changed (MCP-14)
//   Request   PROJECT#<id>    KEY#<agentId>#<requestKey>  a change's result, kept a day for repeats (MCP-12)
//   Limit     PROJECT#<id>    LIMIT#<agentId>#<minute>    an agent's calls this minute (MCP-13)
//   Finding   PROJECT#<id>    COHERE#<pairKey>   two behaviours close in meaning, the model that found them, and a judgement (#36 COHERE-04)
//   Coverage  PROJECT#<id>    COVERAGE           the latest coverage report from CI, compressed (#20 COVER-03)
//   Photo     PROJECT#<id>    IMAGE#<itemKey>#<photoId>  a screenshot in an item's Photos: what it is, not its bytes (#16)
//   Photo part PROJECT#<id>   IMGPART#<photoId>#<version>#<n>  a piece of a screenshot's bytes, each well inside an item's size limit
//   Upload    UPLOAD#<sha256>  UPLOAD             a one-time link an agent sends a screenshot's bytes to, for 15 minutes (SHOT-04)
//
// A project and its nodes share a partition (an item collection): one query reads a
// whole map, and one query finds everything to delete. The map's entities sort last: every prefix in a
// project's partition other than NODE# (ASK#, CHANGESET#, COMMENT#, JOB#, LEASE#, AUDIT#) sorts before it, and
// PROJECT after it, so opening a map is one range query from NODE# on, and never reads the changesets,
// comments or sync's records: those load when they're asked for (DATA-02). A new entity in the partition
// must sort before NODE#, or every map open would read it. Changesets and comments are keyed by the item
// they concern (an issue number, or a node id for items made here). GSI1 is sparse: projects carry its keys,
// so it lists projects, most recently updated first; and so do nodes that are unsaved, saving, in conflict
// or failed, so a save or a refresh finds them without reading the map. Agents' records (AGENT#, BUILD#, CLAIM#, HANDOFF#,
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
  build: (projectId, { itemKey, id }) => ({ PK: projectPartition(projectId), SK: `BUILD#${itemKey}#${id}` }),
  buildsOf: (projectId) => ({ pk: projectPartition(projectId), skBeginsWith: 'BUILD#' }),
  fact: (projectId, { at, id }) => ({ PK: projectPartition(projectId), SK: `${FACT_PREFIX}${at}#${id}` }),
  factsOf: (projectId) => ({ pk: projectPartition(projectId), skBeginsWith: FACT_PREFIX }),
  action: (projectId, { at, id }) => ({ PK: projectPartition(projectId), SK: `ACTION#${at}#${id}` }),
  actionsSince: (projectId, at) => ({ pk: projectPartition(projectId), skFrom: `ACTION#${at}`, skTo: 'ACTION#~' }),
  agentActions: (projectId, agentId, at) => ({ GSI1PK: `ACTIONS#${projectId}#${agentId}`, GSI1SK: at }),
  actionsOf: (projectId, agentId) => ({ index: 'GSI1', pk: `ACTIONS#${projectId}#${agentId}` }),
  request: (projectId, agentId, requestKey) => ({ PK: projectPartition(projectId), SK: `KEY#${agentId}#${requestKey}` }),
  limit: (projectId, agentId, minute) => ({ PK: projectPartition(projectId), SK: `LIMIT#${agentId}#${minute}` }),
  photo: (projectId, { itemKey, id }) => ({ PK: projectPartition(projectId), SK: `IMAGE#${itemKey}#${id}` }),
  photosOf: (projectId, itemKey = '') => ({ pk: projectPartition(projectId), skBeginsWith: `IMAGE#${itemKey ? `${itemKey}#` : ''}` }),
  photoPart: (projectId, { id, version }, n) => ({ PK: projectPartition(projectId), SK: `IMGPART#${id}#${String(version).padStart(4, '0')}#${String(n).padStart(3, '0')}` }),
  photoPartsOf: (projectId, { id, version }) => ({ pk: projectPartition(projectId), skBeginsWith: `IMGPART#${id}#${String(version).padStart(4, '0')}#` }),
  upload: (hash) => ({ PK: `UPLOAD#${hash}`, SK: 'UPLOAD' }),
  coverage: (projectId) => ({ PK: projectPartition(projectId), SK: 'COVERAGE' }),
  clientError: ({ at, id }) => ({ PK: 'ERRORS', SK: `ERROR#${at}#${id}` }),
  clientErrorsSince: (at) => ({ pk: 'ERRORS', skFrom: `ERROR#${at}`, skTo: 'ERROR#~' }),
  question: (projectId, { itemKey, id }) => ({ PK: projectPartition(projectId), SK: `ASK#${itemKey}#${id}` }),
  questionsOf: (projectId, itemKey = '') => ({ pk: projectPartition(projectId), skBeginsWith: `ASK#${itemKey ? `${itemKey}#` : ''}` }),
  inbox: (projectId, id) => ({ PK: projectPartition(projectId), SK: `INBOX#${id}` }),
  inboxOf: (projectId) => ({ pk: projectPartition(projectId), skBeginsWith: 'INBOX#' }),
  finding: (projectId, key) => ({ PK: projectPartition(projectId), SK: `COHERE#${key}` }),
  findingsOf: (projectId) => ({ pk: projectPartition(projectId), skBeginsWith: 'COHERE#' }),
  commentsOf: (projectId, itemKey = '') => ({ pk: projectPartition(projectId), skBeginsWith: `${COMMENT_PREFIX}${itemKey ? `${itemKey}#` : ''}` }),
};

/** Drop the table's bookkeeping, leaving the entity as the API knows it. */
export const strip = ({ PK, SK, GSI1PK, GSI1SK, entity, ...rest }) => rest;
