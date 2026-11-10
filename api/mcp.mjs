// The MCP server (#4): agents use the map the way people do. Streamable HTTP, stateless: every call is one POST of
// JSON-RPC, answered with JSON, signed in with an agent's token (MCP-07), and acting only on that token's project.
//
// Tools read through the same model as the web app, and change things through the API's own routes (`call`) or the
// agents' core (agents.mjs), so a rule like "a claim is atomic" holds however a request arrives.

import { APP_NAME } from '../shared/brand.js';
import { ROOT_ID, ValidationError } from '../shared/schema.js';
import { editableOf, parseIssue, sectionText } from '../shared/issue-shape.js';
import { Refused } from './agents.mjs';
import { behavioursOf, blockersOf, buildingOf, isFinished, keyOf, nextWork, stateOf } from './work.mjs';

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const CHILDREN_SHOWN = 100;

const HOW_TO_WORK = [
  'Find work with next_work(), and claim() it before you start: a claim keeps other agents off it, and runs out after two hours unless you claim it again.',
  'context(issue) has everything about one issue in one read.',
  'When you stop, planned or not, handoff(behaviours, note) says where the work stands. Handoff notes belong on the issue, never only in chat.',
  'Raise questions with ask(place, question), so they stay on the map until someone answers them.',
  'Change behaviours through refine(place) and propose(...). You can mark behaviours ready for adoption; only a person adopts.',
  'Pass a request_key with every change, so a retry never does it twice.',
];

const place = { type: 'string', description: 'An item key (issue-12, node-<id>) or a node id. Leave it out for the whole project.' };
const requestKey = { type: 'string', description: 'Any string unique to this change. Repeating a call with the same key returns the first result and changes nothing.' };
const ids = (what) => ({ type: 'array', items: { type: 'string' }, description: what });

/** @param {{ model: object, agents: object, call: (method: string, path: string, body?: object) => Promise<{ status: number, body: object }>, log?: object }} o */
export function createMcp({ model, agents, call, log = console }) {
  const author = (agent) => `${agent.name} (${agent.id})`;

  async function api(method, path, body) {
    const res = await call(method, path, body);
    if (res.status >= 400) throw Object.assign(new Error(res.body?.error ?? 'Failed'), { status: res.status });
    return res.body;
  }

  async function mapOf(pid) {
    const data = await model.projects.getWithNodes(pid);
    if (!data) throw Object.assign(new Error('Project not found'), { status: 404 });
    return data;
  }

  function find(nodes, where) {
    const key = String(where ?? '').trim();
    const node = !key ? nodes.find((n) => n.id === ROOT_ID) : (nodes.find((n) => n.id === key) ?? nodes.find((n) => keyOf(n) === key) ?? (/^#?\d+$/.test(key) ? nodes.find((n) => keyOf(n) === `issue-${key.replace('#', '')}`) : null));
    if (!node) throw new ValidationError(`No place called ${key} on the map`);
    return node;
  }

  /** Each node's rolled-up counts, worked out once, bottom up. */
  function rollups(nodes, live) {
    const kids = new Map();
    for (const n of nodes) if (n.parentId != null) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n]);
    const claimedIn = new Map();
    for (const c of live.values()) claimedIn.set(c.item, (claimedIn.get(c.item) ?? 0) + 1);
    const memo = new Map();
    const visit = (n, seen = new Set()) => {
      if (memo.has(n.id)) return memo.get(n.id);
      seen.add(n.id);
      const own = behavioursOf(n).filter((b) => !b.fog).length + (n.kind === 'behavior' ? 1 : 0);
      const c = { items: 1, open: !isFinished(n) && !(n.tags ?? []).includes('code') ? 1 : 0, done: n.status === 'done' && !(n.tags ?? []).includes('code') ? 1 : 0, behaviours: own, claimed: claimedIn.get(keyOf(n)) ?? 0, questions: n.status === 'needs_decision' ? 1 : 0 };
      for (const k of kids.get(n.id) ?? []) {
        if (seen.has(k.id)) continue;
        const s = visit(k, seen);
        for (const f of Object.keys(c)) c[f] += s[f];
      }
      memo.set(n.id, c);
      return c;
    };
    return (n) => visit(n);
  }

  const brief = (n, counts) => ({ key: keyOf(n), kind: n.kind, title: n.title, summary: n.summary || undefined, state: stateOf(n), counts: counts(n) });

  const tools = {
    prime: {
      description: 'Start here, once a session: who you are, how this project works, its standing decisions, what it has remembered, and your own claims and handoff notes.',
      input: {},
      async run({ pid, agent }) {
        const project = await model.projects.get(pid);
        const { live } = await agents.liveClaims(pid);
        const mine = [...live.values()].filter((c) => c.owner === agent.id);
        const items = [...new Set(mine.map((c) => c.item))];
        const notes = (await Promise.all(items.map((i) => model.handoffs.list(pid, i)))).flatMap((list) => list.slice(-3));
        const self = await model.agents.get(pid, agent.id);
        return {
          you: { id: agent.id, name: agent.name },
          project: project.title,
          how_to_work: HOW_TO_WORK,
          conventions: project.guide?.conventions?.length ? `Read ${project.guide.conventions.join(' and ')} in the repository.` : undefined,
          standing_decisions: project.guide?.standingDecisions || undefined,
          remembered: (await model.facts.list(pid)).map((f) => ({ fact: f.text, by: f.by?.name, at: f.at.slice(0, 10) })),
          your_claims: items.map((item) => ({ item, title: mine.find((c) => c.item === item).title, behaviours: mine.filter((c) => c.item === item).map((c) => c.behaviour), until: mine.find((c) => c.item === item).until })),
          handoff_notes: notes.map(noteOf),
          your_last_handoff: self?.lastHandoff,
        };
      },
    },

    zoom: {
      description: 'An area of the map and what is directly inside it, each with its title, summary, state and counts: the zoom people get.',
      input: { place },
      async run({ pid }, args) {
        const { nodes } = await mapOf(pid);
        const node = find(nodes, args.place);
        const counts = rollups(nodes, (await agents.liveClaims(pid)).live);
        const byId = new Map(nodes.map((n) => [n.id, n]));
        const path = [];
        for (let p = byId.get(node.parentId); p && path.length < 20; p = byId.get(p.parentId)) path.unshift(p.title);
        const children = nodes.filter((n) => n.parentId === node.id && n.id !== node.id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title));
        return {
          place: brief(node, counts),
          path,
          children: children.slice(0, CHILDREN_SHOWN).map((n) => brief(n, counts)),
          ...(children.length > CHILDREN_SHOWN ? { more: children.length - CHILDREN_SHOWN } : {}),
        };
      },
    },

    next_work: {
      description: 'Behaviours ready to build that nobody has claimed, grouped by issue and in priority order. Work waiting on an unfinished dependency is left out; context(issue) says what blocks it.',
      input: { limit: { type: 'number', description: 'How many issues, at most (default 5).' } },
      async run({ pid }, args) {
        const { nodes } = await mapOf(pid);
        const { work, blocked } = nextWork(nodes, (await agents.liveClaims(pid)).live);
        const limit = Math.min(50, Math.max(1, Number(args.limit) || 5));
        return { work: work.slice(0, limit), ...(work.length > limit ? { more: work.length - limit } : {}), ...(blocked.length ? { blocked: blocked.length } : {}) };
      },
    },

    context: {
      description: 'Everything about one issue in one read: its parents and siblings, behaviours and who is building them, decisions, open questions, handoff notes, files and pull requests. Old discussion comes summarised.',
      input: { issue: { ...place, description: 'The issue: issue-12, 12, or a node id.' } },
      required: ['issue'],
      async run({ pid }, args) {
        const { nodes } = await mapOf(pid);
        const node = find(nodes, args.issue);
        const key = keyOf(node);
        const byId = new Map(nodes.map((n) => [n.id, n]));
        const { live } = await agents.liveClaims(pid);
        const [comments, notes] = await Promise.all([model.comments.list(pid, key), model.handoffs.list(pid, key)]);
        const shape = parseIssue(editableOf(node).markdown);
        const why = sectionText(shape, 'Why');
        const parents = [];
        for (let p = byId.get(node.parentId); p && parents.length < 20; p = byId.get(p.parentId)) parents.unshift({ key: keyOf(p), kind: p.kind, title: p.title });
        const siblings = nodes.filter((n) => n.parentId === node.parentId && n.id !== node.id);
        const finished = siblings.filter(isFinished);
        const open = comments.filter((c) => !c.resolved);
        return {
          issue: { key, kind: node.kind, title: node.title, state: stateOf(node), priority: node.priority || undefined, url: node.url || undefined, summary: node.summary || undefined },
          parents,
          siblings: {
            open: siblings.filter((n) => !isFinished(n)).slice(0, 30).map((n) => ({ key: keyOf(n), title: n.title, state: stateOf(n) })),
            ...(finished.length ? { finished: `${finished.length} finished: ${finished.slice(0, 8).map((n) => n.title).join('; ')}${finished.length > 8 ? '; …' : ''}` } : {}),
          },
          why: why || undefined,
          decisions: why.split(/\n\s*\n/).filter((p) => /\bdecided\b/i.test(p)).map((p) => p.trim()),
          behaviours: behavioursOf(node).map((b) => {
            const c = live.get(b.id);
            return { id: b.id, text: b.text, state: b.fog ? 'not worked out yet' : buildingOf(node, c), ...(c ? { claimed_by: `${c.agentName} (${c.owner}) until ${c.until}` } : {}) };
          }),
          acceptance: sectionText(shape, 'Acceptance') || undefined,
          out_of_scope: sectionText(shape, 'Out of scope') || undefined,
          open_questions: [sectionText(shape, 'Open questions'), ...open.filter((c) => c.anchor?.section === 'Open questions').map((c) => `${c.text} (${c.author})`)].filter((q) => q && !/^none\.?$/i.test(q)),
          discussion: {
            open: open.filter((c) => c.anchor?.section !== 'Open questions').slice(-10).map((c) => ({ on: c.anchor?.behaviour ?? c.anchor?.section, by: c.author, said: c.text.length > 300 ? `${c.text.slice(0, 300)}…` : c.text })),
            ...(comments.length - open.length ? { resolved: `${comments.length - open.length} resolved comments` } : {}),
          },
          handoff_notes: notes.slice(-5).map(noteOf),
          ...(notes.length > 5 ? { older_handoffs: notes.length - 5 } : {}),
          files: filesOf(node, byId),
          pull_requests: (node.pulls ?? []).map((n) => `#${n}`),
          blocked_by: blockersOf(node, byId),
          links: (node.links ?? []).filter((l) => l.type !== 'depends' && byId.has(l.to)).map((l) => ({ type: l.type, key: keyOf(byId.get(l.to)), title: byId.get(l.to).title })),
        };
      },
    },

    claim: {
      description: 'Claim behaviours before you build them: they become being coded, in one atomic step, and anyone else is refused and told who holds them. With no behaviours, claims the top of next_work(). Claim again to hold them longer.',
      input: { behaviours: ids('Behaviour IDs, e.g. ["MCP-04"]. Leave out to take the next work.'), minutes: { type: 'number', description: 'How long to hold them (default 120, at most 480).' }, request_key: requestKey },
      changes: true,
      run: ({ pid, agent }, args) => agents.claim(pid, agent, { behaviours: list(args.behaviours), minutes: args.minutes }),
    },

    handoff: {
      description: 'Release claims with a note saying where the work stands: what is done, what is next, anything the next agent must know. With no behaviours, releases all of yours.',
      input: { behaviours: ids('The behaviour IDs to release; leave out for all of yours.'), note: { type: 'string', description: 'Where the work stands.' }, request_key: requestKey },
      required: ['note'],
      changes: true,
      run: ({ pid, agent }, args) => agents.handoff(pid, agent, { behaviours: list(args.behaviours), note: args.note }),
    },

    ask: {
      description: 'Raise an open question on a place on the map. It shows there until someone answers it.',
      input: { place, question: { type: 'string' }, request_key: requestKey },
      required: ['place', 'question'],
      changes: true,
      async run({ pid, agent }, args) {
        const node = find((await mapOf(pid)).nodes, args.place);
        const { comment } = await api('POST', `/api/projects/${pid}/comments`, { itemKey: keyOf(node), anchor: { section: 'Open questions' }, text: String(args.question ?? ''), author: author(agent) });
        return { question: comment.id, place: keyOf(node), title: node.title };
      },
    },

    refine: {
      description: 'Open a refinement over a place (or return yours that is already open there). Changes inside it leave the spec alone until a person adopts them.',
      input: { place },
      changes: true,
      async run({ pid, agent }, args) {
        const node = find((await mapOf(pid)).nodes, args.place);
        const mine = (await model.changesets.list(pid)).find((cs) => cs.status === 'open' && cs.scopeId === node.id && cs.author === author(agent));
        const cs = mine ?? (await api('POST', `/api/projects/${pid}/changesets`, { scopeId: node.id, author: author(agent) })).changeset;
        return { refinement: cs.id, scope: { key: keyOf(node), title: node.title }, items: cs.items.map((it) => it.key) };
      },
    },

    propose: {
      description: "Propose an item's new text inside a refinement: its title and the whole markdown, in the strict issue shape. Optionally mark behaviours ready for adoption. Nothing changes on the map until a person adopts it.",
      input: {
        refinement: { type: 'string', description: 'From refine().' },
        item: { ...place, description: 'The item to change.' },
        title: { type: 'string', description: 'Leave out to keep it.' },
        markdown: { type: 'string', description: 'The full new markdown. Leave out to keep it.' },
        ready_for_adoption: ids('Behaviour IDs whose conversation has converged.'),
        request_key: requestKey,
      },
      required: ['refinement', 'item'],
      changes: true,
      async run({ pid }, args) {
        const node = find((await mapOf(pid)).nodes, args.item);
        const current = editableOf(node);
        const before = await model.changesets.get(pid, String(args.refinement));
        const pending = before?.items.find((it) => it.key === keyOf(node))?.after ?? current;
        const title = args.title ?? pending.title;
        const markdown = args.markdown ?? pending.markdown;
        const { changeset } = await api('PUT', `/api/projects/${pid}/changesets/${encodeURIComponent(String(args.refinement))}/items`, { key: keyOf(node), title, markdown });
        const ready = list(args.ready_for_adoption);
        const item = changeset.items.find((it) => it.key === keyOf(node));
        if (ready.length) {
          if (!item) throw new Refused('Nothing is proposed for this item, so nothing can be ready for adoption');
          const known = new Set(behavioursOf({ ...node, title: item.after.title, body: item.after.markdown, url: '' }).map((b) => b.id));
          const unknown = ready.filter((id) => !known.has(id));
          if (unknown.length) throw new ValidationError(`Not behaviours of this item: ${unknown.join(', ')}`);
          if (sectionText(parseIssue(item.after.markdown), 'Open questions').replace(/^none\.?$/i, '')) throw new Refused('It still has open questions, so its behaviours can\'t be ready for adoption yet');
          item.readyForAdoption = ready;
          await model.changesets.put(pid, changeset);
        }
        return { refinement: changeset.id, item: keyOf(node), proposed: Boolean(item), ready_for_adoption: item?.readyForAdoption ?? [] };
      },
    },

    remember: {
      description: 'Record a standing decision or correction for this project. Every agent gets it from prime() from then on, and people see it on the map.',
      input: { fact: { type: 'string' }, request_key: requestKey },
      required: ['fact'],
      changes: true,
      async run({ pid, agent }, args) {
        const fact = await agents.remember(pid, { agentId: agent.id, name: author(agent) }, args.fact);
        return { remembered: fact.id };
      },
    },
  };

  const definitions = Object.entries(tools).map(([name, t]) => ({
    name,
    description: t.description,
    inputSchema: { type: 'object', properties: t.input, ...(t.required ? { required: t.required } : {}) },
    annotations: { readOnlyHint: !t.changes, idempotentHint: !t.changes, openWorldHint: false },
  }));

  const result = (data, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, ...(isError ? { isError: true } : {}) });

  async function callTool(ctx, name, args = {}) {
    const tool = tools[name];
    if (!tool) return { error: { code: -32602, message: `No tool called ${name}` } };
    const retryAt = await agents.withinLimit(ctx.pid, ctx.agent);
    if (retryAt) return { result: result({ error: `Too many calls: at most ${agents.callsPerMinute} a minute. Try again after ${retryAt}.`, retry_after: retryAt }, true) };
    try {
      const run = () => tool.run(ctx, args ?? {});
      const out = tool.changes
        ? await agents.once(ctx.pid, ctx.agent, args?.request_key, async () => {
            const done = await run();
            const { request_key, ...said } = args ?? {};
            await agents.record(ctx.pid, ctx.agent, name, { args: said, result: done });
            return done;
          })
        : await run();
      return { result: result(out) };
    } catch (err) {
      const status = err.status ?? 500;
      if (status >= 500) log.error?.(err);
      return { result: result({ error: status >= 500 ? 'Internal error' : err.message, ...(err.details ?? {}) }, true) };
    }
  }

  async function respond(ctx, msg) {
    const reply = (r) => ({ jsonrpc: '2.0', id: msg.id, ...r });
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.protocolVersion;
        return reply({
          result: {
            protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: APP_NAME, version: '0.1.0' },
            instructions: `You are ${ctx.agent.name} (${ctx.agent.id}) on ${ctx.project.title}. Call prime() first.`,
          },
        });
      }
      case 'ping':
        return reply({ result: {} });
      case 'tools/list':
        return reply({ result: { tools: definitions } });
      case 'tools/call':
        return reply(await callTool(ctx, msg.params?.name, msg.params?.arguments));
      default:
        return reply({ error: { code: -32601, message: `Unknown method ${msg.method}` } });
    }
  }

  /** One HTTP request to the MCP endpoint: { method, headers, body } -> { status, body }. */
  return async function handleMcp({ method, headers = {}, body }) {
    if (method !== 'POST') return { status: 405, body: { error: 'Send JSON-RPC messages with POST. This server is stateless and keeps no streams.' } };
    const token = String(headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const who = token ? await agents.authenticate(token) : null;
    if (!who) return { status: 401, body: { error: 'An agent token is required: make one for your agent in the project, then send it as "Authorization: Bearer <token>"' } };
    const project = await model.projects.get(who.projectId);
    if (!project) return { status: 401, body: { error: "This token's project is gone" } };
    const ctx = { pid: who.projectId, agent: who.agent, project };
    const batch = Array.isArray(body);
    const replies = [];
    for (const msg of batch ? body : [body]) {
      if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
        replies.push({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Not a JSON-RPC 2.0 request' } });
        continue;
      }
      if (msg.id === undefined) continue; // a notification: nothing to answer
      replies.push(await respond(ctx, msg));
    }
    if (!replies.length) return { status: 202, body: null };
    return { status: 200, body: batch ? replies : replies[0] };
  };
}

const list = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : v ? [String(v)] : []);

const noteOf = (n) => ({ item: n.itemKey, at: n.at, by: `${n.agentName} (${n.agentId})`, behaviours: n.behaviours, ...(n.reason === 'expired' ? { expired: true } : {}), note: n.note });

/** The code an item lives in: the files it names, then its nearest code area's files. */
function filesOf(node, byId) {
  const named = [...editableOf(node).markdown.matchAll(/`([\w@.()[\]/-]+\/[\w@.()[\]-]+\.\w{1,6})`/g)].map((m) => m[1]);
  let area = [];
  for (let p = byId.get(node.parentId); p; p = byId.get(p.parentId)) {
    if (!(p.tags ?? []).includes('code')) continue;
    area = [...String(p.body ?? '').matchAll(/^- \[(.+?)\]\(/gm)].map((m) => m[1].replace(/\\([[\]*_`])/g, '$1'));
    break;
  }
  return [...new Set([...named, ...area])].slice(0, 25);
}
