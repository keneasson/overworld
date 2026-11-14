// Agents that use a project through MCP (#4): who they are, their tokens, their claims and handoffs, what the
// project has remembered, what each agent changed, and the bookkeeping that keeps a repeated or too-fast call harmless.
// All but tokens live in the project's partition, so deleting a project takes them with it.

import { keys, strip } from '../keys.mjs';

const DAY = 24 * 60 * 60;
const ACTIONS_KEPT_DAYS = 90;

export function agents(table) {
  return {
    /** A project's agents, revoked ones included, each with when it last called. Query begins_with(SK, AGENT#): the seen rows come with them. */
    async list(projectId) {
      const rows = await table.query(keys.agentsOf(projectId));
      const seen = new Map(rows.filter((r) => r.entity === 'agentSeen').map((r) => [r.agentId, r.at]));
      return rows.filter((r) => r.entity === 'agent').map((r) => ({ ...strip(r), lastSeenAt: seen.get(r.id) ?? null }));
    },
    /** PutItem of its own small row, so it never overwrites the agent's record (a revocation, say). */
    async seen(projectId, agentId, at) {
      await table.put({ ...keys.agentSeen(projectId, agentId), entity: 'agentSeen', agentId, at });
    },
    /** GetItem, or null. */
    async get(projectId, id) {
      const it = await table.get(keys.agent(projectId, id));
      return it ? strip(it) : null;
    },
    /** A new agent and its token's hash, unless the id is taken. Conditional PutItem, then PutItem. */
    async create(projectId, agent, tokenHash) {
      if (!(await table.create({ ...keys.agent(projectId, agent.id), entity: 'agent', ...agent, tokenHash }))) return false;
      await table.put({ ...keys.token(tokenHash), entity: 'token', agentId: agent.id, projectId });
      return true;
    },
    /** PutItem: the agent's own record (its last handoff, its revocation). */
    async put(projectId, agent) {
      await table.put({ ...keys.agent(projectId, agent.id), entity: 'agent', ...agent });
    },
    /** The agent a token belongs to: { projectId, agentId }, or null. GetItem by the token's hash. */
    async byToken(tokenHash) {
      const it = await table.get(keys.token(tokenHash));
      return it ? { projectId: it.projectId, agentId: it.agentId } : null;
    },
    /** The token stops working at once. DeleteItem. */
    async revokeToken(tokenHash) {
      await table.delete(keys.token(tokenHash));
    },
    /** Every token of a project's agents, before the project goes. Query, then batched deletes. */
    async revokeAll(projectId) {
      const list = await table.query(keys.agentsOf(projectId));
      await table.write({ deletes: list.filter((a) => a.tokenHash).map((a) => keys.token(a.tokenHash)) });
    },
  };
}

export function claims(table) {
  const item = (projectId, c) => ({ ...keys.claim(projectId, c.behaviour), entity: 'claim', ...c });
  return {
    /** A project's claims, live or run out. Query begins_with(SK, CLAIM#). */
    async list(projectId) {
      return (await table.query(keys.claimsOf(projectId))).map(strip);
    },
    /** Hold every behaviour for `owner`, or none of them. TransactWriteItems, each put conditional. */
    take: (projectId, list, { owner, now }) => table.claimAll(list.map((c) => item(projectId, c)), { owner, now }),
    /** Let one go, if it is still this owner's (and, for an expired one, still the hold that ran out). Conditional DeleteItem. */
    release: (projectId, behaviour, { owner, until }) => table.release(keys.claim(projectId, behaviour), { owner, until }),
  };
}

export function handoffs(table) {
  return {
    /** One item's handoff notes, oldest first. Query begins_with(SK, HANDOFF#<itemKey>#). */
    async list(projectId, itemKey) {
      return (await table.query(keys.handoffsOf(projectId, itemKey))).map(strip);
    },
    /** PutItem. An expiry's note has a fixed id, so noticing it twice writes it once. */
    async put(projectId, note) {
      await table.put({ ...keys.handoff(projectId, note), entity: 'handoff', ...note });
    },
  };
}

export function facts(table) {
  return {
    /** What the project has remembered, oldest first. Query begins_with(SK, FACT#). */
    async list(projectId) {
      return (await table.query(keys.factsOf(projectId))).map(strip);
    },
    async put(projectId, fact) {
      await table.put({ ...keys.fact(projectId, fact), entity: 'fact', ...fact });
    },
    async delete(projectId, fact) {
      await table.delete(keys.fact(projectId, fact));
    },
  };
}

export function actions(table) {
  return {
    /** PutItem, kept 90 days. */
    async put(projectId, action) {
      const expiresAt = Math.floor(Date.parse(action.at) / 1000) + ACTIONS_KEPT_DAYS * DAY;
      await table.put({ ...keys.action(projectId, action), ...keys.agentActions(projectId, action.agentId, action.at), entity: 'action', ...action, expiresAt });
    },
    /** Every agent's changes since a time, oldest first: for a standup's "while you were away". Query SK BETWEEN ACTION#<at> AND ACTION#~. */
    async since(projectId, at) {
      return (await table.query(keys.actionsSince(projectId, at))).map(({ expiresAt, ...a }) => strip(a));
    },
    /** One agent's changes, newest first. Query GSI1 PK = ACTIONS#<projectId>#<agentId>. */
    async list(projectId, agentId) {
      return (await table.query({ ...keys.actionsOf(projectId, agentId), newestFirst: true })).map(({ expiresAt, ...a }) => strip(a));
    },
  };
}

export function requests(table) {
  const key = (projectId, agentId, requestKey) => keys.request(projectId, agentId, requestKey);
  return {
    /** Mark a request key as in use; false if it already was. Conditional PutItem, kept a day. */
    start: (projectId, agentId, requestKey, now) =>
      table.create({ ...key(projectId, agentId, requestKey), entity: 'request', state: 'running', expiresAt: Math.floor(now / 1000) + DAY }),
    /** What became of a request key: { state, result }, or null. GetItem. */
    async get(projectId, agentId, requestKey) {
      const it = await table.get(key(projectId, agentId, requestKey));
      return it && it.expiresAt > Date.now() / 1000 ? { state: it.state, result: it.result } : null;
    },
    async finish(projectId, agentId, requestKey, result, now) {
      await table.put({ ...key(projectId, agentId, requestKey), entity: 'request', state: 'done', result, expiresAt: Math.floor(now / 1000) + DAY });
    },
    /** A call that failed changed nothing, so its key may be used again. DeleteItem. */
    async forget(projectId, agentId, requestKey) {
      await table.delete(key(projectId, agentId, requestKey));
    },
  };
}

export function limits(table) {
  return {
    /** Count one call in this minute: the count, or null once `limit` was reached. UpdateItem with ADD, conditional. */
    count: (projectId, agentId, minute, limit) => table.count(keys.limit(projectId, agentId, minute), { limit, expiresAt: Math.floor(Date.parse(`${minute}:00Z`) / 1000) + 120 }),
  };
}
