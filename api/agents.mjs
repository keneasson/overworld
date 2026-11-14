// The core of agents' work on a project (#4, #34): their tokens, claims and handoffs, what the project remembers,
// what each agent changed, and the rules that keep an agent's calls safe to repeat and within its limit.
// The MCP server (mcp.mjs) and the API's routes for people (app.mjs) both call this; neither has a path of its own.

import { createHash, randomBytes } from 'node:crypto';
import { ValidationError, newId } from '../shared/schema.js';
import { nextWork, behavioursOf, blockersOf, isWork, keyOf } from './work.mjs';

const CALLS_PER_MINUTE = 120;
const CLAIM_MINUTES = { default: 120, max: 480 };
const TOKEN_PREFIX = 'owk_';
const SEEN_EVERY_MS = 5 * 60 * 1000;
// A standup regroups (CONN-05) after this long away, or after this many changes by others since the last one.
const REGROUP_AFTER_HOURS = 8;
const REGROUP_AFTER_CHANGES = 10;
const SHOWN = 8;

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
  const lastWritten = new Map(); // agent → when its seen row was last written by this instance

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
    // When it last called, for "connected" in the app (CONN-07): written at most every few minutes, never per call.
    const key = `${found.projectId}/${agent.id}`;
    if (!(clock() - (lastWritten.get(key) ?? -Infinity) < SEEN_EVERY_MS)) {
      lastWritten.set(key, clock());
      await model.agents.seen(found.projectId, agent.id, iso());
    }
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

  /**
   * The start of a session (CONN-03 to CONN-05): what's addressed to the agent, what it holds and what's next, how its
   * local copy and GitHub differ (from the facts its agent gathered, since only it can see them), its work in progress,
   * and a first step. The first standup onboards; one after a while away regroups; otherwise it says they're up to date.
   * Nothing has to be done at the end of a session: where the work stood is rebuilt from claims, notes and git.
   */
  async function standup(projectId, agent, local = {}) {
    const now = clock();
    const self = (await model.agents.get(projectId, agent.id)) ?? agent;
    const last = self.lastStandup;
    const me = `${agent.name} (${agent.id})`;
    const data = await model.projects.getWithNodes(projectId);
    const { live, expired } = await liveClaims(projectId);
    const mine = [...live.values()].filter((c) => c.owner === agent.id);
    const [comments, changesets, pending, actions] = await Promise.all([
      model.comments.list(projectId),
      model.changesets.list(projectId),
      model.nodes.pending(projectId),
      last ? model.actions.since(projectId, last.at) : [],
    ]);
    const held = [...new Set(mine.map((c) => c.item))];
    // Items this agent cares about: what it holds now, what it held last time, and where it asked questions.
    const asked = comments.filter((c) => c.author === me && c.anchor?.section === 'Open questions');
    const watched = new Set([...held, ...(last?.items ?? []), ...asked.map((c) => c.itemKey)]);
    const notesOn = Object.fromEntries(await Promise.all([...watched].map(async (i) => [i, await model.handoffs.list(projectId, i)])));
    const title = (key) => data.nodes.find((n) => keyOf(n) === key)?.title ?? key;

    // Answered: open at the last standup, or asked since, and resolved now. Each is reported once.
    const answered = last ? asked.filter((c) => c.resolved && ((last.openQuestions ?? []).includes(c.id) || c.createdAt > last.at)) : [];
    const fresh = last ? comments.filter((c) => c.author !== me && c.createdAt > last.at) : [];
    // Claims that ran out: noticed just now, or since the last standup (each left a note on its item).
    const ranOut = [...new Map([...expired.filter((c) => c.owner === agent.id).map((c) => ({ behaviour: c.behaviour, item: c.item, at: c.until })),
      ...Object.values(notesOn).flat().filter((n) => n.reason === 'expired' && n.agentId === agent.id && last && n.at > last.at).map((n) => ({ behaviour: n.behaviours[0], item: n.itemKey, at: n.at }))]
      .map((c) => [`${c.behaviour}@${c.at}`, c])).values()];
    const byOthers = actions.filter((a) => a.agentId !== agent.id && a.at > last.at);
    const behind = Math.max(0, Number(local.behind) || 0);
    const changes = byOthers.length + fresh.length + behind;
    const awayHours = last ? (now - Date.parse(last.at)) / 3_600_000 : 0;
    const mode = !last ? 'onboarding' : awayHours > REGROUP_AFTER_HOURS || changes >= REGROUP_AFTER_CHANGES ? 'regroup' : 'up_to_date';

    const { work } = nextWork(data.nodes, live);
    const git = gitOf(local);
    const refinements = changesets.filter((cs) => cs.status === 'open' && cs.author === me).map((cs) => ({ refinement: cs.id, place: data.nodes.find((n) => n.id === cs.scopeId)?.title ?? cs.scopeId, items: cs.items.length }));
    const unsaved = pending.filter((n) => n.sync && n.sync !== 'saving').map((n) => ({ item: keyOf(n), title: n.title, state: n.sync }));
    const holding = held.map((item) => ({ item, title: title(item), behaviours: mine.filter((c) => c.item === item).map((c) => c.behaviour), until: mine.find((c) => c.item === item).until }));

    const report = {
      mode,
      ...(last ? { last_connected: last.at, away: span(now - Date.parse(last.at)) } : {}),
      addressed_to_you: {
        ...(answered.length ? { answered: answered.map((c) => ({ item: c.itemKey, title: title(c.itemKey), question: c.text })) } : {}),
        ...(fresh.filter((c) => watched.has(c.itemKey)).length ? { new_comments: fresh.filter((c) => watched.has(c.itemKey)).slice(-SHOWN).map((c) => ({ item: c.itemKey, by: c.author, said: c.text.length > 300 ? `${c.text.slice(0, 300)}…` : c.text })) } : {}),
      },
      you_hold: holding,
      ready_next: work.slice(0, 3).map((w) => ({ item: w.item, title: w.title, priority: w.priority || undefined, behaviours: w.behaviours.map((b) => b.id) })),
      ...(git ? { local_and_github: git } : {}),
      work_in_progress: {
        ...(refinements.length ? { your_open_refinements: refinements } : {}),
        ...(unsaved.length ? { not_saved_to_github: unsaved.slice(0, SHOWN), ...(unsaved.length > SHOWN ? { more_not_saved: unsaved.length - SHOWN } : {}) } : {}),
      },
    };
    if (mode === 'regroup') {
      report.while_you_were_away = {
        changes,
        ...(byOthers.length ? { by_other_agents: byOthers.slice(-SHOWN).map((a) => ({ at: a.at, by: `${a.agentName} (${a.agentId})`, did: a.tool })) } : {}),
        ...(fresh.length ? { comments: fresh.length } : {}),
        ...(behind ? { commits_on_github: behind } : {}),
      };
      report.where_you_left_off = {
        ...(self.lastHandoff ? { last_handoff: self.lastHandoff } : {}),
        notes: Object.values(notesOn).flat().filter((n) => !last || n.at > last.at).slice(-SHOWN).map((n) => ({ item: n.itemKey, at: n.at, by: `${n.agentName} (${n.agentId})`, note: n.note })),
      };
      if (ranOut.length) report.claims_ran_out = ranOut;
    } else if (ranOut.length) report.claims_ran_out = ranOut;
    if (mode === 'onboarding') {
      const project = data.project ?? (await model.projects.get(projectId));
      report.onboarding = {
        project: project.title,
        conventions: project.guide?.conventions?.length ? `Read ${project.guide.conventions.join(' and ')} in the repository.` : undefined,
        standing_decisions: project.guide?.standingDecisions || undefined,
        remembered: (await model.facts.list(projectId)).map((f) => ({ fact: f.text, by: f.by?.name, at: f.at.slice(0, 10) })),
      };
    }
    report.first_step = firstStep({ mode, git, ranOut, answered, holding, work, refinements, title });

    await model.agents.put(projectId, { ...self, lastStandup: { at: iso(now), items: held, openQuestions: asked.filter((c) => !c.resolved).map((c) => c.id) } });
    return report;
  }

  return { callsPerMinute, standup, issueToken, revoke, authenticate, liveClaims, claim, handoff, remember, record, withinLimit, once };
}

/** How the local copy and GitHub differ, from what the agent saw: null when it sent nothing. */
function gitOf(local) {
  const f = local ?? {};
  if (![f.branch, f.ahead, f.behind, f.unpushed, f.uncommitted, f.pull_requests].some((v) => v != null)) return null;
  const n = (v) => Math.max(0, Number(v) || 0);
  const unpushed = Array.isArray(f.unpushed) ? f.unpushed.map(String).slice(0, SHOWN) : [];
  const uncommitted = Array.isArray(f.uncommitted) ? f.uncommitted.map(String) : [];
  const ahead = Math.max(n(f.ahead), unpushed.length);
  return {
    branch: f.branch ? String(f.branch).slice(0, 200) : undefined,
    ...(f.upstream ? { upstream: String(f.upstream).slice(0, 200) } : {}),
    ahead, behind: n(f.behind),
    ...(unpushed.length ? { unpushed } : {}),
    ...(uncommitted.length ? { uncommitted: uncommitted.slice(0, 25), ...(uncommitted.length > 25 ? { more_uncommitted: uncommitted.length - 25 } : {}) } : {}),
    ...(Array.isArray(f.pull_requests) && f.pull_requests.length ? { pull_requests: f.pull_requests.slice(0, SHOWN).map((p) => ({ number: Number(p?.number) || undefined, title: p?.title ? String(p.title).slice(0, 200) : undefined, state: p?.state ? String(p.state) : undefined })) } : {}),
    in_line: !ahead && !n(f.behind) && !uncommitted.length,
  };
}

/** One suggestion: unfinished local work first, then catching up, then answers, then held work, then the next work. */
function firstStep({ mode, git, ranOut, answered, holding, work, refinements, title }) {
  const local = git && (git.uncommitted?.length || git.unpushed?.length || git.ahead);
  if (local && ranOut.length && !holding.length) return `You have local work on ${git.branch ?? 'this branch'} and your claim on ${ranOut.map((c) => c.behaviour).join(', ')} ran out: claim it again, or hand it off, before you carry on.`;
  if (git?.behind) return `Pull first: ${git.behind} commit${git.behind === 1 ? '' : 's'} on GitHub you don't have yet.`;
  if (local) return `Finish what's local on ${git.branch ?? 'this branch'}: ${git.uncommitted?.length ? 'commit, then ' : ''}push.`;
  if (answered.length) return `Read the answer${answered.length === 1 ? '' : 's'} on ${[...new Set(answered.map((a) => a.title))].join(', ')}.`;
  if (holding.length) return `Carry on with ${holding[0].title} (${holding[0].behaviours.join(', ')}); your claim holds until ${holding[0].until}.`;
  if (refinements.length) return `Finish your refinement over ${refinements[0].place}.`;
  if (work.length) return `Claim the next work: ${work[0].title} (${work[0].behaviours.map((b) => b.id).join(', ')}).`;
  return mode === 'onboarding' ? 'Nothing is ready to build yet: zoom() around the map, and ask() where things are unclear.' : 'Nothing is ready and unclaimed: ask() or refine() where the map is unclear.';
}

const span = (ms) => {
  const h = ms / 3_600_000;
  return h < 1 ? `${Math.max(1, Math.round(ms / 60_000))} minutes` : h < 48 ? `${Math.round(h)} hours` : `${Math.round(h / 24)} days`;
};
