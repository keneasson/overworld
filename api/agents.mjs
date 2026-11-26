// The core of agents' work on a project (#4, #34): their tokens, claims and handoffs, what the project remembers,
// what each agent changed, and the rules that keep an agent's calls safe to repeat and within its limit.
// The MCP server (mcp.mjs) and the API's routes for people (app.mjs) both call this; neither has a path of its own.

import { createHash, randomBytes } from 'node:crypto';
import { ValidationError, newId } from '../shared/schema.js';
import { nextWork, behavioursOf, blockersOf, brokenOf, isFinished, isWork, keyOf } from './work.mjs';
import { awaitsApplying, promptOf, questionsOnMap } from './answers.mjs';
import { openQuestions } from './engine/lifecycle.mjs';
import { editPrompt, notePrompt } from './notes.mjs';
import { turnOf } from '../shared/turns.js';
import { buildPrompt } from './prompts.mjs';
import { isDismissed } from '../shared/annotations.js';


const CALLS_PER_MINUTE = 120;
const CLAIM_MINUTES = { default: 120, max: 480 };
// A claim whose pull request has opened holds until the deploy that carries it succeeds (#14 HANDOFF-11). It still has an
// end, so a claim nobody deploys is noticed in the end, but one far enough off that review, merge and deploy fit inside it.
const PULL_HOLD_MS = 30 * 24 * 3_600_000;
const TOKEN_PREFIX = 'owk_';
const SEEN_EVERY_MS = 5 * 60 * 1000;
// A standup regroups (CONN-05) after this long away, or after this many changes by others since the last one.
const REGROUP_AFTER_HOURS = 8;
const REGROUP_AFTER_CHANGES = 10;
const SHOWN = 8;
// A build request nobody has picked up in this long says so on the card (#14 HANDOFF-06).
const BUILD_STALE_MS = 60 * 60_000;
// A prompt a person changed before it went (#14 HANDOFF-02) is theirs to write, up to this long.
const PROMPT_MAX = 40_000;

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
  async function claim(projectId, agent, { behaviours = [], minutes, pullRequest, builtWith } = {}) {
    const span = Math.min(CLAIM_MINUTES.max, Math.max(1, Number(minutes) || CLAIM_MINUTES.default));
    const pull = pullRequest == null || pullRequest === '' ? null : Number(String(pullRequest).replace(/^#/, ''));
    if (pull !== null && !(Number.isInteger(pull) && pull > 0)) throw new ValidationError('pull_request: expected a pull request number');
    if (pull !== null && !behaviours.length) throw new ValidationError('pull_request: name the behaviours it carries');
    // Which agent built it, so the card can say when one stood in for the project's own (HANDOFF-08).
    const built = builtWith == null || builtWith === '' ? null : said(builtWith, 300, 'built_with');
    if (built && pull === null) throw new ValidationError('built_with: name the pull_request it built');
    for (let attempt = 0; attempt < 3; attempt++) {
      const [data, { live }, report] = await Promise.all([model.projects.getWithNodes(projectId), liveClaims(projectId), model.coverage.get(projectId)]);
      const othersHold = new Map([...live].filter(([, c]) => c.owner !== agent.id));
      let wanted;
      if (!behaviours.length) {
        // What a person asked to be built comes first (HANDOFF-10), oldest first; then the top of next_work().
        wanted = requestedWork(data, await buildRequests(projectId, { nodes: data.nodes, live }));
        if (!wanted) {
          const top = nextWork(data.nodes, live, { tested: data.project?.tested, report }).work[0];
          if (!top) return { claimed: [], message: 'Nothing is ready and unclaimed.' };
          wanted = top.behaviours.map((b) => ({ id: b.id, node: data.nodes.find((n) => keyOf(n) === top.item) }));
        }
      } else {
        // What this agent already holds it may claim again, to name its pull request, though its item is now in progress.
        const mine = new Set([...live].filter(([, c]) => c.owner === agent.id).map(([id]) => id));
        // Naming the pull request that carries them links work already done: its item has moved on (in progress once the PR
        // says it closes it, or needing a decision over a new question), and the claim may have run out meanwhile. Only
        // starting work needs the item to be ready; a finished item's deploy has already released what it carried.
        if (pull !== null) for (const id of behaviours.map(String)) {
          const node = data.nodes.find((n) => behavioursOf(n).some((b) => b.id === id));
          if (node && !isFinished(node)) mine.add(id);
        }
        wanted = placeBehaviours(data.nodes, behaviours.map(String), data.project?.tested, mine, report);
        const held = holders(behaviours, othersHold);
        if (held.length) throw new Refused(`Already claimed: ${held.map((h) => `${h.behaviour} by ${h.agent} until ${h.until}`).join('; ')}`, { held_by: held });
      }
      const now = clock();
      const until = iso(now + span * 60_000);
      // Naming the pull request holds the claim until its deploy (HANDOFF-11); claiming again later keeps what it said.
      const list = wanted.map(({ id, node }) => {
        const was = live.get(id)?.owner === agent.id ? live.get(id) : null;
        const pr = pull !== null ? { number: pull, state: 'open', at: iso(now), ...(built ? { builtWith: built } : {}) } : was?.pr;
        const held = pr && pr.state !== 'closed' ? [until, was?.until ?? '', pull !== null ? iso(now + PULL_HOLD_MS) : ''].sort().at(-1) : until;
        return { behaviour: id, item: keyOf(node), title: node.title, agentName: agent.name, until: held, claimedAt: was?.claimedAt ?? iso(now), ...(pr ? { pr } : {}) };
      });
      if (await model.claims.take(projectId, list, { owner: agent.id, now: iso(now) })) {
        const took = await takeBuilds(projectId, agent, list.map((c) => c.behaviour), iso(now));
        return { claimed: list.map((c) => c.behaviour), items: [...new Set(list.map((c) => c.item))], until: list.map((c) => c.until).sort()[0], ...(pull !== null ? { pull_request: pull, holds_until: 'the deploy that carries it succeeds' } : {}), ...(took.length ? { build_requests_taken: took } : {}) };
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
  function placeBehaviours(nodes, ids, tested = [], mine = new Set(), report = null) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const out = [];
    for (const id of ids) {
      const node = nodes.find((n) => behavioursOf(n).some((b) => b.id === id));
      if (!node) throw new Refused(`${id} isn't a behaviour on the map`);
      // A done item's behaviour whose proof now fails is work again (#21 PROVEN-07).
      if (mine.has(id) || brokenOf(node, report).some((b) => b.id === id)) {
        out.push({ id, node });
        continue;
      }
      if (!isWork(node)) throw new Refused(`${id} belongs to ${node.title}, which is ${node.status.replace('_', ' ')}, not ready`);
      if (behavioursOf(node).find((b) => b.id === id).fog) throw new Refused(`${id} isn't worked out yet, so it can't be built`);
      const by = blockersOf(node, byId);
      if (by.length) throw new Refused(`${node.title} waits on ${by.map((b) => `${b.title} (${b.state.replace('_', ' ')})`).join(', ')}`, { blocked_by: by });
      out.push({ id, node });
    }
    return out;
  }

  /**
   * Build requests still waiting for a builder (#14 HANDOFF-05), oldest first: each with the behaviours nobody has claimed
   * yet, and whether it has waited over an hour (HANDOFF-06). One whose item is no longer work, or whose behaviours are
   * all claimed or gone, isn't waiting.
   */
  async function buildRequests(projectId, { nodes, live } = {}) {
    nodes ??= (await model.projects.getWithNodes(projectId)).nodes;
    live ??= (await liveClaims(projectId)).live;
    const byKey = new Map(nodes.map((n) => [keyOf(n), n]));
    const out = [];
    for (const r of await model.builds.list(projectId)) {
      const node = r.state === 'waiting' && byKey.get(r.itemKey);
      if (!node || !isWork(node)) continue;
      const have = new Set(behavioursOf(node).map((b) => b.id));
      const taken = new Set((r.taken ?? []).map((t) => t.behaviour));
      const waiting = r.behaviours.filter((id) => have.has(id) && !taken.has(id) && !live.has(id));
      if (waiting.length) out.push({ ...r, title: node.title, waiting, stale: clock() - Date.parse(r.at) > BUILD_STALE_MS });
    }
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }

  /**
   * What builders said when they stopped (#14 HANDOFF-09), newest per item: for a request that was taken and whose
   * behaviours nobody holds now, the newest handoff note on them since it was taken: a runner that can't finish leaves one
   * saying why, and so does any agent that stops, or a claim that ran out. A week on, it is history.
   */
  async function buildNotes(projectId, { live } = {}) {
    live ??= (await liveClaims(projectId)).live;
    const recent = iso(clock() - 7 * 24 * 3_600_000);
    const taken = (await model.builds.list(projectId)).filter((r) => r.taken?.length);
    const out = [];
    for (const item of new Set(taken.map((r) => r.itemKey))) {
      const notes = await model.handoffs.list(projectId, item);
      let newest = null;
      for (const r of taken.filter((x) => x.itemKey === item)) {
        const ids = r.taken.map((t) => t.behaviour);
        if (ids.some((id) => live.has(id))) continue;
        const note = notes.filter((n) => n.at >= r.taken[0].at && n.at >= recent && n.behaviours?.some((b) => ids.includes(b))).at(-1);
        if (note && (!newest || note.at > newest.at)) newest = { request: r.id, itemKey: item, behaviours: ids, by: `${note.agentName} (${note.agentId})`, at: note.at, note: note.note, ...(note.reason === 'expired' ? { expired: true } : {}) };
      }
      if (newest) out.push(newest);
    }
    return out;
  }

  /** The first waiting request that can be claimed now, as claim() wants it, or null. */
  function requestedWork(data, requests) {
    for (const r of requests) {
      try {
        return placeBehaviours(data.nodes, r.waiting, data.project?.tested);
      } catch (err) {
        if (!(err instanceof Refused)) throw err;
      }
    }
    return null;
  }

  /** A claim takes the requests for what it claimed (HANDOFF-06): a request is taken once all of it is. */
  async function takeBuilds(projectId, agent, claimed, at) {
    const mine = new Set(claimed);
    const took = [];
    for (const r of await model.builds.list(projectId)) {
      if (r.state !== 'waiting') continue;
      const done = new Set((r.taken ?? []).map((t) => t.behaviour));
      const now = r.behaviours.filter((id) => mine.has(id) && !done.has(id));
      if (!now.length) continue;
      const taken = [...(r.taken ?? []), ...now.map((behaviour) => ({ behaviour, by: `${agent.name} (${agent.id})`, at }))];
      await model.builds.put(projectId, { ...r, taken, ...(taken.length >= r.behaviours.length ? { state: 'taken' } : {}) });
      took.push(r.id);
    }
    return took;
  }

  /**
   * What a build of these behaviours would be (#14 HANDOFF-05): the named ones, or every one of the item that is new and
   * unclaimed, each work an agent could claim. A refusal says why not.
   */
  async function planBuild(projectId, { item, behaviours = [] }) {
    const data = await model.projects.getWithNodes(projectId);
    const node = data.nodes.find((n) => keyOf(n) === item);
    if (!node) throw new ValidationError(`${item} isn't on the map`);
    const { live } = await liveClaims(projectId);
    const tested = new Set(data.project?.tested ?? []);
    const own = behavioursOf(node).filter((b) => !b.fog);
    const ids = behaviours.length ? behaviours.map(String) : own.filter((b) => !live.has(b.id) && !tested.has(b.id)).map((b) => b.id);
    if (!ids.length) throw new Refused(`${node.title} has no behaviours that are new and unclaimed, so there is nothing to build`);
    const stray = ids.filter((id) => !behavioursOf(node).some((b) => b.id === id));
    if (stray.length) throw new Refused(`${stray.join(', ')} ${stray.length === 1 ? "isn't a behaviour" : "aren't behaviours"} of ${node.title}`);
    placeBehaviours(data.nodes, ids, data.project?.tested);
    const held = holders(ids, live);
    if (held.length) throw new Refused(`Already being coded: ${held.map((h) => `${h.behaviour} by ${h.agent}`).join('; ')}`, { held_by: held });
    return { item, title: node.title, behaviours: ids, data, node, live, own };
  }

  /** The build planBuild() finds, with the prompt it would go out with (HANDOFF-01), for a person to read first (HANDOFF-02). */
  async function buildPlan(projectId, ask) {
    const { item, title, behaviours, data, node, own } = await planBuild(projectId, ask);
    return { item, title, behaviours, prompt: await buildPromptOf(projectId, { data, node, own, ids: behaviours }) };
  }

  /** The prompt Overworld builds for these behaviours (HANDOFF-01): the item, its open comments and how the project tests. */
  const buildPromptOf = async (projectId, { data, node, own, ids }) =>
    buildPrompt({ nodes: data.nodes, node, behaviours: own.filter((b) => ids.includes(b.id)), comments: await model.comments.list(projectId, keyOf(node)), testing: data.project?.testing, tested: data.project?.tested });

  /**
   * A person asks for behaviours to be built (#14 HANDOFF-05), as planBuild() finds them. It is recorded with the prompt it
   * goes out with: the one the person read and changed (HANDOFF-02), or else the one Overworld builds (HANDOFF-01). It
   * waits for a builder; asking again for what already waits returns that request.
   */
  async function requestBuild(projectId, { item, behaviours = [], by, prompt }) {
    const { title, behaviours: ids, data, node, live, own } = await planBuild(projectId, { item, behaviours });
    const theirs = prompt == null || prompt === '' ? null : said(prompt, PROMPT_MAX, 'prompt');
    const open = await buildRequests(projectId, { nodes: data.nodes, live });
    const fresh = ids.filter((id) => !open.some((r) => r.waiting.includes(id)));
    if (!fresh.length) return { request: open.find((r) => ids.some((id) => r.waiting.includes(id))), already: true };
    const request = {
      id: newId(),
      itemKey: item,
      title,
      behaviours: fresh,
      by: said(by ?? '', 80, 'by'),
      at: iso(),
      state: 'waiting',
      prompt: theirs ?? (await buildPromptOf(projectId, { data, node, own, ids: fresh })),
      ...(theirs ? { edited: true } : {}),
    };
    await model.builds.put(projectId, request);
    return { request: { ...request, waiting: fresh, stale: false } };
  }

  /**
   * A pull request closed (#14 HANDOFF-11). Merged, its claims hold on until the deploy that carries it. Closed without
   * merging, they stay with their builder, for a claim's length, to build again or hand off; the card says what happened.
   */
  async function pullClosed(projectId, { number, merged }) {
    const { live } = await liveClaims(projectId);
    const at = iso();
    const mine = [...live.values()].filter((c) => c.pr?.number === number);
    for (const c of mine) {
      const pr = { ...c.pr, state: merged ? 'merged' : 'closed', at };
      await model.claims.put(projectId, { ...c, pr, ...(merged ? {} : { until: iso(clock() + CLAIM_MINUTES.default * 60_000) }) });
    }
    return mine.map((c) => c.behaviour);
  }

  /**
   * A production deploy finished (#14 HANDOFF-11), carrying these merged pull requests. When it succeeded, the work is
   * where people can use it: each claim it carries is released, with a note saying so. When it failed, the claims stay
   * with their builders and say the deploy failed.
   */
  async function deployed(projectId, { sha, outcome, pulls }) {
    const { live } = await liveClaims(projectId);
    const at = iso();
    const carried = [...live.values()].filter((c) => c.pr && pulls.includes(c.pr.number));
    const released = [];
    for (const c of carried) {
      if (outcome !== 'success') {
        await model.claims.put(projectId, { ...c, pr: { ...c.pr, state: 'merged', deploy: { state: 'failed', sha, at } } });
        continue;
      }
      if (!(await model.claims.release(projectId, c.behaviour, { owner: c.owner }))) continue;
      released.push(c);
    }
    for (const [item, cs] of Object.entries(Object.groupBy(released, (c) => c.item))) {
      for (const [owner, own] of Object.entries(Object.groupBy(cs, (c) => c.owner))) {
        const pulls = [...new Set(own.map((c) => `#${c.pr.number}`))].join(', ');
        await model.handoffs.put(projectId, { itemKey: item, at, id: newId(), agentId: owner, agentName: own[0].agentName, behaviours: own.map((c) => c.behaviour), reason: 'deployed', note: `Deployed to production in ${String(sha).slice(0, 7)}, with ${pulls}: done.` });
      }
    }
    return { released: released.map((c) => c.behaviour), ...(outcome !== 'success' ? { held: carried.map((c) => c.behaviour) } : {}) };
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

  /**
   * Answers waiting to be written into the spec (ANSWER-03). Each is for the agent that asked it, for a claim's length
   * after it was answered or last handed to that agent; after that, or when a person asked it, it is any agent's work.
   * One already being applied in an open refinement is nobody else's.
   */
  async function answersToApply(projectId, { nodes, changesets } = {}) {
    [nodes, changesets] = await Promise.all([nodes ?? model.projects.getWithNodes(projectId).then((d) => d.nodes), changesets ?? model.changesets.list(projectId)]);
    const open = new Set(changesets.filter((cs) => cs.status === 'open').map((cs) => cs.id));
    const agentIds = new Set((await model.agents.list(projectId)).map((a) => a.id));
    const byKey = new Map(nodes.map((n) => [keyOf(n), n]));
    const hold = CLAIM_MINUTES.default * 60_000;
    return (await questionsOnMap(model, projectId, nodes)).filter((q) => awaitsApplying(q, byKey.get(q.itemKey)) && !open.has(q.refinement)).map((q) => {
      const asker = agentIds.has(q.asked?.agentId) ? q.asked.agentId : null;
      const heldUntil = asker ? Date.parse(q.handedAt ?? q.answered?.at ?? byKey.get(q.itemKey).updatedAt) + hold : 0;
      return { question: q, asker, forAnyone: clock() > heldUntil, prompt: () => promptOf({ nodes, question: q }) };
    });
  }

  /**
   * A proposal that applies answers (ANSWER-04): it names the questions it settles, by id, and can ask for the item to be
   * ready. Adopting it applies them (answers.mjs, settleAnswers). Returns what the proposal now applies.
   */
  async function applyAnswers(projectId, changeset, item, { answers = [], ready } = {}) {
    if (!answers.length && ready == null) return {};
    if (!item) throw new Refused('Nothing is proposed for this item, so it applies no answer');
    const { nodes } = await model.projects.getWithNodes(projectId);
    const questions = await questionsOnMap(model, projectId, nodes, item.key);
    const live = new Set((await model.changesets.list(projectId)).filter((cs) => cs.status === 'open').map((cs) => cs.id));
    const taken = [];
    for (const id of answers) {
      const q = questions.find((x) => x.id === id);
      if (!q || !q.answer || q.applied) throw new ValidationError(`${id} isn't an answered question in this item's Open questions`);
      if (q.refinement && q.refinement !== changeset.id && live.has(q.refinement)) throw new Refused(`${id} is already being applied in refinement ${q.refinement}`);
      taken.push(q);
    }
    // A new item (#26) keeps its text on its node, and adopting it already holds it back while questions are open.
    if (ready && item.after && openQuestions(item.after.markdown)) throw new Refused('Its Open questions section still has something in it, so it can\'t be ready');
    item.answers = [...new Set([...(item.answers ?? []), ...answers])];
    if (ready != null) item.itemReady = Boolean(ready);
    await model.changesets.put(projectId, changeset);
    for (const q of taken) {
      const meta = (await model.questions.get(projectId, { itemKey: item.key, id: q.id })) ?? { itemKey: item.key, id: q.id, text: q.text };
      await model.questions.put(projectId, { ...meta, refinement: changeset.id });
    }
    return { answers: item.answers, item_ready: Boolean(item.itemReady) };
  }

  /**
   * Annotations addressed to agents (#15 NOTE-17). Each goes to the first agent to call after it is posted, or to the
   * agent it names, and stays that agent's for a claim's length; after that it is any agent's again. With `fresh`,
   * only those handed over by this call; otherwise every one this agent holds. Each comes with its prompt (NOTE-18).
   */
  async function addressed(projectId, agent, { fresh = true } = {}) {
    const rows = await model.inbox.list(projectId);
    if (!rows.length) return [];
    const now = clock();
    const free = (r) => !r.deliveredTo || now - Date.parse(r.deliveredAt) > CLAIM_MINUTES.default * 60_000;
    const mine = rows.filter((r) => (!r.agentId || r.agentId === agent.id) && (free(r) || r.deliveredTo === agent.id));
    const handing = mine.filter(free);
    if (fresh && !handing.length) return [];
    const { nodes } = await model.projects.getWithNodes(projectId);
    const out = [];
    for (const r of fresh ? handing : mine) {
      if (r.kind === 'edit') {
        // A person's own edit in a refinement (#13 ADOPT-20): theirs until an agent has looked at it or it has gone.
        const cs = await model.changesets.get(projectId, r.changeset);
        const item = cs?.status === 'open' ? cs.items.find((it) => it.key === r.itemKey) : null;
        if (!item || turnOf(cs, item) !== 'agent') {
          await model.inbox.delete(projectId, r.id);
          continue;
        }
        if (handing.includes(r)) await model.inbox.put(projectId, { ...r, deliveredTo: agent.id, deliveredAt: iso(now) });
        out.push({ edit: { id: r.id, refinement: cs.id, itemKey: r.itemKey, author: cs.author }, prompt: editPrompt({ nodes, refinement: cs, item }) });
        continue;
      }
      const comments = await model.comments.list(projectId, r.itemKey);
      let note = comments.find((c) => c.id === r.id);
      if (!note || isDismissed(note)) {
        await model.inbox.delete(projectId, r.id);
        continue;
      }
      if (handing.includes(r)) {
        await model.inbox.put(projectId, { ...r, deliveredTo: agent.id, deliveredAt: iso(now) });
        note = { ...note, delivery: { ...note.delivery, state: 'delivered', to: `${agent.name} (${agent.id})`, at: iso(now) } };
        await model.comments.put(projectId, note);
      }
      const refinement = note.anchor?.refinement ? await model.changesets.get(projectId, note.anchor.refinement) : null;
      // A pin on a screenshot goes with its screenshot (#16 SHOT-03): the MCP server attaches the image.
      const photo = note.anchor?.photo ? await model.photos.get(projectId, { itemKey: r.itemKey, id: note.anchor.photo }) : null;
      out.push({ note, prompt: notePrompt({ nodes, comments, note, refinement, photo }), ...(photo ? { photo } : {}) });
    }
    return out;
  }

  /** A proposal that acts on comments (NOTE-19): it links them, for the log and the reply; adopting it dismisses nothing. */
  async function applyNotes(projectId, changeset, item, { annotations = [] } = {}) {
    if (!annotations.length) return {};
    if (!item) throw new Refused('Nothing is proposed for this item, so it applies no annotation');
    for (const id of annotations) {
      const c = await model.comments.get(projectId, { itemKey: item.key, id });
      if (!c || c.replyTo || isDismissed(c)) throw new ValidationError(`${id} isn't an open comment on this item`);
    }
    item.annotations = [...new Set([...(item.annotations ?? []), ...annotations])];
    await model.changesets.put(projectId, changeset);
    return { annotations: item.annotations };
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
    // Items this agent cares about: what it holds now, what it held last time, and where it asked questions. A question
    // is settled for its asker once its answer is applied, or it has left its item's Open questions.
    const [metas, onMap] = await Promise.all([model.questions.list(projectId), questionsOnMap(model, projectId, data.nodes)]);
    const asked = metas.filter((q) => q.asked?.agentId === agent.id);
    const settled = (q) => Boolean(q.applied) || !onMap.some((x) => x.itemKey === q.itemKey && x.id === q.id);
    const watched = new Set([...held, ...(last?.items ?? []), ...asked.map((c) => c.itemKey)]);
    const notesOn = Object.fromEntries(await Promise.all([...watched].map(async (i) => [i, await model.handoffs.list(projectId, i)])));
    const title = (key) => data.nodes.find((n) => keyOf(n) === key)?.title ?? key;

    // Answered and waiting to be applied: addressed to the agent that asked, with the prompt, until it is (ANSWER-03).
    // It is handed over again each standup, so it stays this agent's for a claim's length after it last came back.
    const toApply = (await answersToApply(projectId, { nodes: data.nodes, changesets })).filter((a) => a.asker === agent.id);
    for (const a of toApply) await model.questions.put(projectId, { ...metas.find((m) => m.itemKey === a.question.itemKey && m.id === a.question.id), handedAt: iso(now) });
    // Settled: open at the last standup, or asked since, and settled now. Each is reported once.
    const resolvedNow = last ? asked.filter((q) => settled(q) && ((last.openQuestions ?? []).includes(q.id) || q.asked.at > last.at)) : [];
    const answered = [...toApply.map((a) => ({ c: a.question, prompt: a.prompt() })), ...resolvedNow.map((c) => ({ c }))];
    // Annotations addressed to agents with @ (NOTE-17): the standup is where one waits when no agent was connected.
    const notes = await addressed(projectId, agent, { fresh: false });
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

    const { work, toVerify } = nextWork(data.nodes, live, { tested: data.project?.tested, report: await model.coverage.get(projectId) });
    // What people asked to be built and nobody has taken (HANDOFF-10): an open session can take it before a runner does.
    const builds = (await buildRequests(projectId, { nodes: data.nodes, live })).map(buildOf);
    const git = gitOf(local);
    const refinements = changesets.filter((cs) => cs.status === 'open' && cs.author === me).map((cs) => ({ refinement: cs.id, place: data.nodes.find((n) => n.id === cs.scopeId)?.title ?? cs.scopeId, items: cs.items.length }));
    // People's yes or no to this agent's refinements since the last standup (ADOPT-05): declined ones say why.
    const decided = changesets.filter((cs) => cs.author === me).flatMap((cs) => [...(cs.adopted ?? []).map((d) => ({ ...d, outcome: 'adopted' })), ...(cs.declined ?? []).map((d) => ({ ...d, outcome: 'declined' }))])
      .filter((d) => !last || d.at > last.at).map((d) => ({ item: d.key, title: title(d.key), outcome: d.outcome, ...(d.behaviours?.length ? { behaviours: d.behaviours } : {}), by: d.by, at: d.at, ...(d.reason ? { reason: d.reason } : {}) }));
    const unsaved = pending.filter((n) => n.sync && n.sync !== 'saving').map((n) => ({ item: keyOf(n), title: n.title, state: n.sync }));
    const holding = held.map((item) => ({ item, title: title(item), behaviours: mine.filter((c) => c.item === item).map((c) => c.behaviour), until: mine.find((c) => c.item === item).until }));

    const report = {
      mode,
      ...(last ? { last_connected: last.at, away: span(now - Date.parse(last.at)) } : {}),
      addressed_to_you: {
        ...(notes.some((n) => n.note) ? { annotations: notes.filter((n) => n.note).map(noteOf) } : {}),
        ...(notes.some((n) => n.edit) ? { edits: notes.filter((n) => n.edit).map(noteOf) } : {}),
        ...(answered.length ? { answered: answered.map(({ c, prompt }) => ({ item: c.itemKey, title: title(c.itemKey), question: c.text, ...(prompt ? { question_id: c.id, answer: c.answer, ...(c.answered ? { answered_by: c.answered.by } : {}), prompt } : {}) })) } : {}),
        ...(decided.length ? { your_refinements_decided: decided.slice(-SHOWN) } : {}),
        ...(fresh.filter((c) => watched.has(c.itemKey)).length ? { new_comments: fresh.filter((c) => watched.has(c.itemKey)).slice(-SHOWN).map((c) => ({ item: c.itemKey, by: c.author, said: c.text.length > 300 ? `${c.text.slice(0, 300)}…` : c.text })) } : {}),
      },
      you_hold: holding,
      ...(builds.length ? { build_requests: builds.slice(0, 3), ...(builds.length > 3 ? { more_build_requests: builds.length - 3 } : {}) } : {}),
      ready_next: work.slice(0, 3).map((w) => ({ item: w.item, title: w.title, priority: w.priority || undefined, behaviours: w.behaviours.map((b) => b.id) })),
      ...(toVerify.length ? { to_verify: toVerify.slice(0, SHOWN) } : {}),
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
    report.first_step = firstStep({ mode, git, ranOut, notes, answered: answered.map(({ c, prompt }) => ({ title: title(c.itemKey), prompt })), holding, builds, work, toVerify, refinements, title });

    await model.agents.put(projectId, { ...self, lastStandup: { at: iso(now), items: held, openQuestions: asked.filter((c) => !settled(c)).map((c) => c.id) } });
    return report;
  }

  return { callsPerMinute, standup, addressed, buildRequests, buildNotes, buildPlan, requestBuild, pullClosed, deployed, applyNotes, answersToApply, applyAnswers, issueToken, revoke, authenticate, liveClaims, claim, handoff, remember, record, withinLimit, once };
}

/** An annotation addressed to an agent, as its tools show it: who said what, where, and the prompt to act on it. */
export const noteOf = ({ note, edit, prompt }) => (edit ? editOf({ edit, prompt }) : { annotation: note.id, item: note.itemKey, from: note.author, said: note.text, ...(note.anchor?.photo ? { photo: note.anchor.photo } : {}), prompt });

/** A person's own edit handed to an agent (#13 ADOPT-20), as its tools show it: whose, where, and the prompt to answer it with. */
const editOf = ({ edit, prompt }) => ({ edit: edit.id, refinement: edit.refinement, item: edit.itemKey, from: edit.author, prompt });

/** A build request as agents' tools show it: what to build, who asked, since when, and the prompt to build it with (HANDOFF-10). */
export const buildOf = (r) => ({
  request: r.id,
  item: r.itemKey,
  title: r.title,
  behaviours: r.waiting,
  requested_by: r.by,
  at: r.at,
  ...(r.stale ? { waiting_over_an_hour: true } : {}),
  prompt: r.prompt,
});

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

/** One suggestion: unfinished local work first, then catching up, then answers to apply or read, then held work, then the next work. */
function firstStep({ mode, git, ranOut, notes = [], answered, holding, builds = [], work, toVerify = [], refinements, title }) {
  const apply = answered.filter((a) => a.prompt);
  const local = git && (git.uncommitted?.length || git.unpushed?.length || git.ahead);
  if (local && ranOut.length && !holding.length) return `You have local work on ${git.branch ?? 'this branch'} and your claim on ${ranOut.map((c) => c.behaviour).join(', ')} ran out: claim it again, or hand it off, before you carry on.`;
  if (git?.behind) return `Pull first: ${git.behind} commit${git.behind === 1 ? '' : 's'} on GitHub you don't have yet.`;
  const comments = notes.filter((n) => n.note);
  const edits = notes.filter((n) => n.edit);
  if (comments.length) return `Act on what ${comments[0].note.author} addressed to you on ${comments[0].note.itemKey}: follow its prompt in addressed_to_you.annotations${notes.length > 1 ? `, then the other ${notes.length - 1}` : ''}.`;
  if (edits.length) return `Answer ${edits[0].edit.author}'s change to ${title(edits[0].edit.itemKey)} in their refinement: follow its prompt in addressed_to_you.edits${edits.length > 1 ? `, then the other ${edits.length - 1}` : ''}.`;
  if (apply.length) return `Apply the answer to your question on ${apply[0].title}: follow its prompt in addressed_to_you.answered${apply.length > 1 ? `, then the other ${apply.length - 1}` : ''}.`;
  if (local) return `Finish what's local on ${git.branch ?? 'this branch'}: ${git.uncommitted?.length ? 'commit, then ' : ''}push.`;
  if (answered.length) return `Read the answer${answered.length === 1 ? '' : 's'} on ${[...new Set(answered.map((a) => a.title))].join(', ')}.`;
  if (holding.length) return `Carry on with ${holding[0].title} (${holding[0].behaviours.join(', ')}); your claim holds until ${holding[0].until}.`;
  if (refinements.length) return `Finish your refinement over ${refinements[0].place}.`;
  if (builds.length) return `${builds[0].requested_by} asked for ${builds[0].title} to be built: claim(behaviours: [${builds[0].behaviours.map((id) => `"${id}"`).join(', ')}]), then follow its prompt in build_requests.`;
  if (work.length) return `Claim the next work: ${work[0].title} (${work[0].behaviours.map((b) => b.id).join(', ')}).`;
  if (toVerify.length) return `Nothing is ready to build. ${toVerify[0].title} has a test for every behaviour: verify it does what it says, and record what you saw on the issue; a person's yes closes it (STATE-12).`;
  return mode === 'onboarding' ? 'Nothing is ready to build yet: zoom() around the map, and ask() where things are unclear.' : 'Nothing is ready and unclaimed: ask() or refine() where the map is unclear.';
}

const span = (ms) => {
  const h = ms / 3_600_000;
  return h < 1 ? `${Math.max(1, Math.round(ms / 60_000))} minutes` : h < 48 ? `${Math.round(h)} hours` : `${Math.round(h / 24)} days`;
};
