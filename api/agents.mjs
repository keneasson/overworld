// The core of agents' work on a project (#4, #34): their tokens, claims and handoffs, what the project remembers,
// what each agent changed, and the rules that keep an agent's calls safe to repeat and within its limit.
// The MCP server (mcp.mjs) and the API's routes for people (app.mjs) both call this; neither has a path of its own.

import { createHash, randomBytes } from 'node:crypto';
import { ValidationError, newId } from '../shared/schema.js';
import { nextWork, behavioursOf, blockersOf, isWork, keyOf } from './work.mjs';

const CALLS_PER_MINUTE = 120;
const CLAIM_MINUTES = { default: 120, max: 480 };
const TOKEN_PREFIX = 'owk_';

export const tokenHash = (token) => createHash('sha256').update(String(token)).digest('hex');

export class Refused extends Error {
  constructor(message, details = {}) {
    super(message);
    this.status = 409;
    this.details = details;
  }
}

const said = (v, max, what) => {
  if (typeof v !== 'string' || !v.trim()) throw new ValidationError(`${what}: required`);
  if (v.length > max) throw new ValidationError(`${what}: at most ${max} characters`);
  return v.trim();
};

/** @param {{ model: object, clock?: () => number, callsPerMinute?: number }} o */
export function createAgents({ model, clock = Date.now, callsPerMinute = CALLS_PER_MINUTE }) {
  const iso = (ms = clock()) => new Date(ms).toISOString();

  /** A new agent for one project, and its token, shown this once (MCP-07). */
  async function issueToken(projectId, name) {
    const token = `${TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
    const agent = { name: said(name ?? '', 80, 'name'), createdAt: iso(), revokedAt: null };
    for (let i = 0; i < 5; i++) {
      // A short id an agent and a person can both say (AGENT-01); taken ones are tried again.
      const id = `a${newId().slice(0, 4)}`;
      if (await model.agents.create(projectId, { ...agent, id }, tokenHash(token))) return { agent: { ...agent, id }, token };
    }
    throw new Error('Could not find a free agent id');
  }

  /** The token stops working; every other agent's keeps working. */
  async function revoke(projectId, agentId) {
    const agent = await model.agents.get(projectId, agentId);
    if (!agent) return null;
    if (agent.tokenHash) await model.agents.revokeToken(agent.tokenHash);
    const { tokenHash: _, ...kept } = { ...agent, revokedAt: agent.revokedAt ?? iso() };
    await model.agents.put(projectId, kept);
    return kept;
  }

  /** The project and agent a token belongs to, or null. */
  async function authenticate(token) {
    if (!String(token ?? '').startsWith(TOKEN_PREFIX)) return null;
    const found = await model.agents.byToken(tokenHash(token));
    if (!found) return null;
    const agent = await model.agents.get(found.projectId, found.agentId);
    if (!agent || agent.revokedAt) return null;
    const { tokenHash: _, ...plain } = agent;
    return { projectId: found.projectId, agent: plain };
  }

  /** Live claims by behaviour. A claim that ran out is released here, and its item gets a note saying so (MCP-09). */
  async function liveClaims(projectId) {
    const now = iso();
    const live = new Map();
    const expired = [];
    for (const c of await model.claims.list(projectId)) {
      if (c.until >= now) {
        live.set(c.behaviour, c);
        continue;
      }
      // Noticing the same expiry twice writes the same note: its id comes from the claim.
      await model.handoffs.put(projectId, {
        itemKey: c.item,
        at: c.until,
        id: `expired-${c.owner}-${c.behaviour}`,
        agentId: c.owner,
        agentName: c.agentName,
        behaviours: [c.behaviour],
        reason: 'expired',
        note: `${c.agentName} (${c.owner})'s claim on ${c.behaviour} ran out at ${c.until} without a handoff.`,
      });
      await model.claims.release(projectId, c.behaviour, { owner: c.owner, until: c.until });
      expired.push(c);
    }
    return { live, expired };
  }

  const holders = (ids, live) => ids.filter((id) => live.has(id)).map((id) => ({ behaviour: id, agent: `${live.get(id).agentName} (${live.get(id).owner})`, until: live.get(id).until }));

  /**
   * Claim behaviours for a while, all or none (MCP-04). With none named, the top of next_work() is claimed in the same step.
   * A behaviour the agent already holds is held for longer.
   */
  async function claim(projectId, agent, { behaviours = [], minutes } = {}) {
    const span = Math.min(CLAIM_MINUTES.max, Math.max(1, Number(minutes) || CLAIM_MINUTES.default));
    for (let attempt = 0; attempt < 3; attempt++) {
      const data = await model.projects.getWithNodes(projectId);
      const { live } = await liveClaims(projectId);
      const othersHold = new Map([...live].filter(([, c]) => c.owner !== agent.id));
      let wanted;
      if (!behaviours.length) {
        const top = nextWork(data.nodes, live).work[0];
        if (!top) return { claimed: [], message: 'Nothing is ready and unclaimed.' };
        wanted = top.behaviours.map((b) => ({ id: b.id, node: data.nodes.find((n) => keyOf(n) === top.item) }));
      } else {
        wanted = placeBehaviours(data.nodes, behaviours.map(String));
        const held = holders(behaviours, othersHold);
        if (held.length) throw new Refused(`Already claimed: ${held.map((h) => `${h.behaviour} by ${h.agent} until ${h.until}`).join('; ')}`, { held_by: held });
      }
      const now = clock();
      const until = iso(now + span * 60_000);
      const list = wanted.map(({ id, node }) => ({ behaviour: id, item: keyOf(node), title: node.title, agentName: agent.name, until, claimedAt: live.get(id)?.claimedAt ?? iso(now) }));
      if (await model.claims.take(projectId, list, { owner: agent.id, now: iso(now) })) {
        return { claimed: list.map((c) => c.behaviour), items: [...new Set(list.map((c) => c.item))], until };
      }
      // Someone took one first. Named behaviours say who; "the next work" looks again.
      if (behaviours.length) {
        const again = (await liveClaims(projectId)).live;
        const held = holders(behaviours, new Map([...again].filter(([, c]) => c.owner !== agent.id)));
        throw new Refused(`Already claimed: ${held.map((h) => `${h.behaviour} by ${h.agent} until ${h.until}`).join('; ') || 'by another agent, just now'}`, { held_by: held });
      }
    }
    throw new Refused('Other agents kept taking the next work first; ask again.');
  }

  /** Each named behaviour's item, if it is work an agent may claim, or a refusal saying why not. */
  function placeBehaviours(nodes, ids) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const out = [];
    for (const id of ids) {
      const node = nodes.find((n) => behavioursOf(n).some((b) => b.id === id));
      if (!node) throw new Refused(`${id} isn't a behaviour on the map`);
      if (!isWork(node)) throw new Refused(`${id} belongs to ${node.title}, which is ${node.status.replace('_', ' ')}, not ready`);
      if (behavioursOf(node).find((b) => b.id === id).fog) throw new Refused(`${id} isn't worked out yet, so it can't be built`);
      const by = blockersOf(node, byId);
      if (by.length) throw new Refused(`${node.title} waits on ${by.map((b) => `${b.title} (${b.state.replace('_', ' ')})`).join(', ')}`, { blocked_by: by });
      out.push({ id, node });
    }
    return out;
  }

  /** Release claims with a note on where the work stands; the next agent reads it in context() and prime() (MCP-09). */
  async function handoff(projectId, agent, { behaviours = [], note }) {
    const text = said(note ?? '', 4000, 'note');
    const { live } = await liveClaims(projectId);
    const mine = [...live.values()].filter((c) => c.owner === agent.id && (!behaviours.length || behaviours.includes(c.behaviour)));
    const missing = behaviours.filter((id) => !mine.some((c) => c.behaviour === id));
    if (missing.length) throw new Refused(`You hold no claim on ${missing.join(', ')}`);
    if (!mine.length) throw new Refused('You hold no claims to hand off');
    const at = iso();
    const released = [];
    for (const c of mine) if (await model.claims.release(projectId, c.behaviour, { owner: agent.id })) released.push(c);
    const items = [...new Set(released.map((c) => c.item))];
    for (const item of items) {
      await model.handoffs.put(projectId, { itemKey: item, at, id: newId(), agentId: agent.id, agentName: agent.name, behaviours: released.filter((c) => c.item === item).map((c) => c.behaviour), reason: 'handoff', note: text });
    }
    const current = await model.agents.get(projectId, agent.id);
    await model.agents.put(projectId, { ...current, lastHandoff: { at, items, behaviours: released.map((c) => c.behaviour), note: text } });
    return { released: released.map((c) => c.behaviour), items };
  }

  /** A standing decision or correction for the project, attributed to whoever made it (MCP-10). */
  async function remember(projectId, by, text) {
    const fact = { id: newId(), at: iso(), text: said(text ?? '', 2000, 'fact'), by };
    await model.facts.put(projectId, fact);
    return fact;
  }

  /** What an agent changed, with its ID and the time (MCP-14). */
  async function record(projectId, agent, tool, change) {
    await model.actions.put(projectId, { id: newId(), at: iso(), agentId: agent.id, agentName: agent.name, tool, change });
  }

  /** One more call this minute, or the time to try again; each agent has its own count (MCP-13). */
  async function withinLimit(projectId, agent) {
    const now = iso();
    const minute = now.slice(0, 16);
    if ((await model.limits.count(projectId, agent.id, minute, callsPerMinute)) != null) return null;
    return new Date(Date.parse(`${minute}:00Z`) + 60_000).toISOString();
  }

  /** Run a change once per request key: a repeat returns the first result and changes nothing (MCP-12). */
  async function once(projectId, agent, requestKey, change) {
    if (requestKey == null || requestKey === '') return change();
    const key = String(requestKey);
    if (!/^[\w.:-]{1,100}$/.test(key)) throw new ValidationError('request_key: letters, digits and . _ : - only, at most 100');
    if (!(await model.requests.start(projectId, agent.id, key, clock()))) {
      const first = await model.requests.get(projectId, agent.id, key);
      if (first?.state === 'done') return first.result;
      throw new Refused('The first call with this request key is still running; try again in a moment.');
    }
    try {
      const result = await change();
      await model.requests.finish(projectId, agent.id, key, result, clock());
      return result;
    } catch (err) {
      await model.requests.forget(projectId, agent.id, key);
      throw err;
    }
  }

  return { callsPerMinute, issueToken, revoke, authenticate, liveClaims, claim, handoff, remember, record, withinLimit, once };
}
