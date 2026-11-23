// The MCP server (#4): agents use the map the way people do. Streamable HTTP, stateless: every call is one POST of
// JSON-RPC, answered with JSON, signed in with an agent's token (MCP-07), and acting only on that token's project.
//
// Tools read through the same model as the web app, and change things through the API's own routes (`call`) or the
// agents' core (agents.mjs), so a rule like "a claim is atomic" holds however a request arrives.

import { APP_NAME } from '../shared/brand.js';
import { ROOT_ID, ValidationError } from '../shared/schema.js';
import { editableOf, parseIssue, sectionText } from '../shared/issue-shape.js';
import { Refused, buildOf, noteOf as addressedOf } from './agents.mjs';
import { awaitsApplying, questionsOnMap } from './answers.mjs';
import { isOpen, threadsOf, toAgent, whereOf } from '../shared/annotations.js';
import { notePrompt } from './notes.mjs';
import { behavioursOf, blockersOf, buildingOf, childrenOf, isAdopted, isFinished, keyOf, nextWork, splitOf, stateOf } from './work.mjs';
import { skeletonsOf } from './skeletons.mjs';

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const CHILDREN_SHOWN = 100;

// When an agent may dismiss a comment (NOTE-05): said in HOW_TO_WORK and in the dismiss tool's description.
const DISMISSING = "Don't dismiss a comment whose conversation is still unresolved, unless there's a clear follow-up and a new place has taken the conversation on (a task made from it, say). Never dismiss a person's comment just because you replied.";

const HOW_TO_WORK = [
  'Start each session with standup(), passing your local git state: it says what is waiting for you and where to begin. There is nothing to do at the end of a session.',
  'Find work with next_work(), and claim() it before you start: a claim keeps other agents off it, and runs out after two hours unless you claim it again. A build request is a person asking for work to be built: take it before anything else, by claiming its behaviours, and build it from its prompt.',
  'context(issue) has everything about one issue in one read.',
  'When you stop, planned or not, handoff(behaviours, note) says where the work stands. Handoff notes belong on the issue, never only in chat. But when your pull request opens, don\'t hand off: claim(behaviours, pull_request: its number), and the claim holds through review and merge and is released for you once the production deploy that carries it succeeds. Done is when people can use it.',
  'Once work is claimed, build it to a pull request without waiting for a person. Raise what you can\'t settle alone with ask(place, question), where the team answers it, and keep building what doesn\'t depend on the answer. Never ask in your own window, and never leave a claim idle.',
  'Change behaviours through refine(place) and propose(...). You can mark behaviours ready for adoption; only a person adopts.',
  `People address you in comments with @Claude. Any tool's result can carry addressed_to_you_now: act on it first, through a refinement, and reply() in its thread naming what you changed. Nothing clears a comment by itself: it stays on the item until someone dismiss()es it into the conversation log. ${DISMISSING}`,
  'An open question is a line in its item\'s Open questions section, with its answer written directly under it as "Answer: …". A comment is never one, wherever it is anchored, and a reply to a comment is not an answer. An answered question comes to you with a prompt: write the decision into the spec through a refinement, taking the question and its answer out of Open questions, and pass its id in propose(answers). Open questions never block proposing, marking behaviours ready, or adoption.',
  'Pass a request_key with every change, so a retry never does it twice.',
];

// The standup prompt (CONN-03): clients like Claude Code show it as a slash command. Only the agent can see the local
// copy, so the prompt asks it to look, and the standup tool puts that beside what Overworld knows.
const STANDUP_PROMPT = [
  'Start the session with a standup on this project.',
  '',
  'First gather the local facts, quietly, in this repository:',
  '- the current branch and its upstream (git rev-parse --abbrev-ref HEAD; git rev-parse --abbrev-ref @{upstream});',
  '- after git fetch, how far ahead and behind the upstream it is (git rev-list --left-right --count HEAD...@{upstream});',
  '- the subjects of unpushed commits (git log --format=%s @{upstream}..HEAD);',
  '- uncommitted changes, as file paths (git status --porcelain);',
  '- open pull requests from this branch, if the gh CLI is available (gh pr list --head <branch> --json number,title,state).',
  'Leave out anything you can\'t find; nothing is required.',
  '',
  'Then call the standup tool with them. Present its report briefly, in plain words: what is addressed to me, what I hold and what is ready next, how my copy and GitHub differ, my work in progress, and, after a while away, what changed and where I left off. Then act on its first step yourself, without waiting for me (CONN-08): carry on with what you hold, or claim what is ready, and build it to a pull request. Raise anything you can\'t settle alone with ask() on the item and keep building what doesn\'t depend on the answer; if nothing can go on, handoff() with a note. Never leave a claim idle.',
].join('\n');

const PROMPTS = {
  standup: { title: 'Standup', description: 'Start a session: what is waiting for you, how your copy and GitHub differ, and where to begin. After a while away it regroups.', text: STANDUP_PROMPT },
};

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

    standup: {
      description: 'Start each session here, with your local git state: what is addressed to you, what you hold and what is ready next, how your copy and GitHub differ, your work in progress, and a first step. The first time it onboards; after a while away it regroups: what changed and where you left off.',
      input: {
        branch: { type: 'string' },
        upstream: { type: 'string' },
        ahead: { type: 'number', description: 'Commits on this branch not on its upstream.' },
        behind: { type: 'number', description: 'Commits on the upstream not here, after a fetch.' },
        unpushed: { type: 'array', items: { type: 'string' }, description: 'Subjects of unpushed commits.' },
        uncommitted: { type: 'array', items: { type: 'string' }, description: 'Paths with uncommitted changes.' },
        pull_requests: { type: 'array', items: { type: 'object', properties: { number: { type: 'number' }, title: { type: 'string' }, state: { type: 'string' } } }, description: 'Open pull requests from this branch.' },
      },
      writes: true,
      async run({ pid, agent }, args) {
        const report = await agents.standup(pid, agent, args);
        if (report.mode === 'onboarding') report.onboarding = { ...report.onboarding, how_to_work: HOW_TO_WORK };
        return report;
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
      description: 'Behaviours ready to build that nobody has claimed, grouped by issue and in priority order. Only leaf issues are work: a parent is built through its children. Work waiting on an unfinished dependency is left out; context(issue) says what blocks it. Issues that need a split first are listed by key; context(issue) says why. Answered questions waiting to be written into the spec come first, each with its prompt; then build requests, behaviours a person asked to be built, each with its prompt: claim them to take it.',
      input: { limit: { type: 'number', description: 'How many issues, at most (default 5).' } },
      async run({ pid }, args) {
        const { project, nodes } = await mapOf(pid);
        const [{ live }, report] = await Promise.all([agents.liveClaims(pid), model.coverage.get(pid)]);
        const { work, blocked, needsSplit, toVerify } = nextWork(nodes, live, { tested: project?.tested, report });
        // What people asked to be built comes first (#14 HANDOFF-10): claiming it takes the request.
        const builds = (await agents.buildRequests(pid, { nodes, live })).map(buildOf);
        const limit = Math.min(50, Math.max(1, Number(args.limit) || 5));
        // An answer its asker hasn't come back for is anyone's to apply (ANSWER-03).
        const answers = (await agents.answersToApply(pid, { nodes })).filter((a) => a.forAnyone).slice(0, limit).map(answerOf);
        return { ...(answers.length ? { answers_to_apply: answers } : {}), ...(builds.length ? { build_requests: builds.slice(0, limit) } : {}), work: work.slice(0, limit), ...(work.length > limit ? { more: work.length - limit } : {}), ...(blocked.length ? { blocked: blocked.length } : {}), ...(needsSplit.length ? { need_a_split: needsSplit.map((x) => x.item) } : {}), ...(toVerify.length ? { to_verify: toVerify.map((x) => x.item) } : {}) };
      },
    },

    context: {
      description: 'Everything about one issue in one read: its parents and siblings, behaviours and who is building them, decisions, open questions, handoff notes, files and pull requests. Old discussion comes summarised.',
      input: { issue: { ...place, description: 'The issue: issue-12, 12, or a node id.' } },
      required: ['issue'],
      async run({ pid }, args) {
        const { project, nodes } = await mapOf(pid);
        const node = find(nodes, args.issue);
        const key = keyOf(node);
        const byId = new Map(nodes.map((n) => [n.id, n]));
        const { live } = await agents.liveClaims(pid);
        const [comments, notes, questions, report] = await Promise.all([model.comments.list(pid, key), model.handoffs.list(pid, key), questionsOnMap(model, pid, [node], key), model.coverage.get(pid)]);
        const shape = parseIssue(editableOf(node).markdown);
        const why = sectionText(shape, 'Why');
        const parents = [];
        for (let p = byId.get(node.parentId); p && parents.length < 20; p = byId.get(p.parentId)) parents.unshift({ key: keyOf(p), kind: p.kind, title: p.title });
        const siblings = nodes.filter((n) => n.parentId === node.parentId && n.id !== node.id);
        const finished = siblings.filter(isFinished);
        const threads = threadsOf(comments);
        const open = threads.map((t) => t.root).filter(isOpen);
        const dismissed = threads.length - open.length;
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
            return { id: b.id, text: b.text, state: b.fog ? 'not worked out yet' : buildingOf(node, c, b, report), ...(c ? { claimed_by: `${c.agentName} (${c.owner}) until ${c.until}` } : {}) };
          }),
          acceptance: sectionText(shape, 'Acceptance') || undefined,
          out_of_scope: sectionText(shape, 'Out of scope') || undefined,
          // The questions in its Open questions section, each saying whether it is answered (ANSWER-01); comments are discussion (NOTE-22).
          open_questions: questions.map((q) => ({ question_id: q.id, question: q.text, ...(q.asked ? { asked_by: q.asked.by } : {}), ...(q.answer ? { answered: true, answer: q.answer, ...(q.answered ? { answered_by: q.answered.by } : {}), ...(q.applied ? { applied: true } : {}) } : { answered: false }) })),
          ...(questions.some((q) => awaitsApplying(q, node)) ? { answers_to_apply: (await agents.answersToApply(pid, { nodes })).filter((a) => a.question.itemKey === key).map(answerOf) } : {}),
          discussion: {
            open: open.slice(-10).map((c) => ({ annotation: c.id, on: whereOf(c.anchor), ...(c.anchor?.quote ? { quoting: c.anchor.quote.slice(0, 300) } : {}), by: c.author, said: c.text.length > 300 ? `${c.text.slice(0, 300)}…` : c.text })),
            ...(dismissed ? { dismissed: `${dismissed} dismissed comment${dismissed === 1 ? '' : 's'}, in the conversation log` } : {}),
          },
          handoff_notes: notes.slice(-5).map(noteOf),
          ...(notes.length > 5 ? { older_handoffs: notes.length - 5 } : {}),
          files: filesOf(node, byId),
          pull_requests: (node.pulls ?? []).map((n) => `#${n}`),
          blocked_by: blockersOf(node, byId),
          ...((split) => (split ? { needs_split: split } : {}))(splitOf(node, childrenOf(nodes).get(node.id) ?? [], new Set(project?.tested ?? []))),
          links: (node.links ?? []).filter((l) => l.type !== 'depends' && byId.has(l.to)).map((l) => ({ type: l.type, key: keyOf(byId.get(l.to)), title: byId.get(l.to).title })),
        };
      },
    },

    skeletons: {
      description: "Test skeletons for an issue's adopted behaviours (#23): a test per behaviour, named by its ID, with its Given / When / Then, in the style of the project's existing tests (best practice for its language if it has none), failing until you fill it in. Write the body; keep the name. A behaviour that already has a test points to it instead.",
      input: { issue: { ...place, description: 'The issue: issue-12, 12, or a node id.' }, behaviours: ids('Behaviour IDs to sketch; leave out for all of the issue\'s.') },
      required: ['issue'],
      async run({ pid }, args) {
        const { project, nodes } = await mapOf(pid);
        const node = find(nodes, args.issue);
        if (!isAdopted(node)) throw new Refused(`${node.title} is ${stateOf(node)}: its behaviours aren't adopted yet, so there is nothing to sketch a test for`);
        const own = behavioursOf(node).filter((b) => !b.fog).map((b) => b.id);
        const stray = list(args.behaviours).filter((id) => !own.includes(id));
        if (stray.length) throw new Refused(`${stray.join(', ')} ${stray.length === 1 ? "isn't a behaviour" : "aren't behaviours"} of ${node.title} that are worked out`);
        const { how, skeletons, existing } = skeletonsOf({ node, testing: project?.testing, tested: project?.tested, ids: list(args.behaviours) });
        return { issue: keyOf(node), style: how, skeletons, ...(existing.length ? { already_tested: existing } : {}) };
      },
    },

    claim: {
      description: 'Claim behaviours before you build them: they become being coded, in one atomic step, and anyone else is refused and told who holds them. With no behaviours, claims the oldest build request, or else the top of next_work(). Claiming what a build request asked for takes it. Claim again to hold them longer.',
      input: {
        behaviours: ids('Behaviour IDs, e.g. ["MCP-04"]. Leave out to take the next work.'),
        minutes: { type: 'number', description: 'How long to hold them (default 120, at most 480).' },
        pull_request: { type: 'number', description: 'The pull request that carries them, once it has opened: the claim then holds until the production deploy that carries it succeeds, and is released for you.' },
        built_with: { type: 'string', description: 'With pull_request: which agent and model built it, and why that one when it stood in for another. The card shows it.' },
        request_key: requestKey,
      },
      changes: true,
      run: ({ pid, agent }, args) => agents.claim(pid, agent, { behaviours: list(args.behaviours), minutes: args.minutes, pullRequest: args.pull_request, builtWith: args.built_with }),
    },

    handoff: {
      description: 'Release claims with a note saying where the work stands: what is done, what is next, anything the next agent must know. With no behaviours, releases all of yours.',
      input: { behaviours: ids('The behaviour IDs to release; leave out for all of yours.'), note: { type: 'string', description: 'Where the work stands.' }, request_key: requestKey },
      required: ['note'],
      changes: true,
      run: ({ pid, agent }, args) => agents.handoff(pid, agent, { behaviours: list(args.behaviours), note: args.note }),
    },

    ask: {
      description: 'Raise an open question on a place on the map: it is added at once as a line in that item\'s Open questions section, in place of "None.", and reaches GitHub with the next save. A person answers it under the question, and the answer comes back to you, at your standup, with a prompt to apply it. For a remark that isn\'t a question for the spec, comment instead.',
      input: { place, question: { type: 'string' }, request_key: requestKey },
      required: ['place', 'question'],
      changes: true,
      async run({ pid, agent }, args) {
        const node = find((await mapOf(pid)).nodes, args.place);
        const { question } = await api('POST', `/api/projects/${pid}/questions`, { itemKey: keyOf(node), text: String(args.question ?? ''), author: author(agent), agentId: agent.id });
        return { question: question.id, place: keyOf(node), title: node.title };
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

    split: {
      description: "Split an item that needs it before it can be built (it is partly built, or has child issues and behaviours of its own still to build): the behaviours it still has to build move, word for word with their IDs, into a new child task, and the item keeps what's built and says where the rest went. Both go into your refinement for a person to adopt. Then build the child.",
      input: {
        refinement: { type: 'string', description: 'From refine().' },
        item: { ...place, description: 'The item that needs a split.' },
        request_key: requestKey,
      },
      required: ['refinement', 'item'],
      changes: true,
      async run({ pid, agent }, args) {
        const node = find((await mapOf(pid)).nodes, args.item);
        const res = await api('POST', `/api/projects/${pid}/items/${keyOf(node)}/split`, { changeset: String(args.refinement), by: author(agent) });
        return { refinement: res.changeset.id, item: keyOf(node), child: keyOf(res.node), title: res.node.title, moved: res.moved };
      },
    },

    propose: {
      description: "Propose an item's new text inside a refinement: its title and the whole markdown, in the strict issue shape. Optionally mark behaviours ready for adoption. Nothing changes in the spec until a person adopts it. To propose a new item, give `parent` and `kind` in place of `item`: it appears on the map at once, in the refinement, needing improvement.",
      input: {
        refinement: { type: 'string', description: 'From refine().' },
        item: { ...place, description: 'The item to change. Leave out for a new item.' },
        parent: { ...place, description: 'For a new item: where it goes. Its markdown starts from the template, already Part of the parent.' },
        kind: { type: 'string', enum: ['epic', 'feature', 'story', 'task', 'bug'], description: 'For a new item: what it is (default task).' },
        title: { type: 'string', description: 'Leave out to keep it.' },
        markdown: { type: 'string', description: 'The full new markdown. Leave out to keep it.' },
        ready_for_adoption: ids('Behaviour IDs whose conversation has converged.'),
        answers: ids('Ids of the answered open questions this proposal applies (question_id, from the prompt or context()); take each question and its answer out of Open questions in the markdown. Adopting it records the answers as applied.'),
        annotations: ids('Ids of the comments this proposal acts on, linked from it for the log and your reply; adopting it doesn\'t dismiss them. reply() in each thread with what you changed.'),
        item_ready: { type: 'boolean', description: 'With answers: the item is ready once adopted, because nothing else is open.' },
        request_key: requestKey,
      },
      required: ['refinement'],
      changes: true,
      async run({ pid }, args) {
        const cid = encodeURIComponent(String(args.refinement));
        let node;
        if (args.item == null) {
          // A new item arrives in the refinement the same way a person's does (NEW-05).
          if (args.parent == null) throw new ValidationError('Give the item to change, or a parent and kind for a new one');
          const parent = find((await mapOf(pid)).nodes, args.parent);
          node = (await api('POST', `/api/projects/${pid}/changesets/${cid}/new`, { parentId: parent.id, kind: args.kind, title: args.title, markdown: args.markdown })).node;
        } else node = find((await mapOf(pid)).nodes, args.item);
        const current = editableOf(node);
        const before = await model.changesets.get(pid, String(args.refinement));
        const pending = before?.items.find((it) => it.key === keyOf(node))?.after ?? current;
        const title = args.title ?? pending.title;
        const markdown = args.markdown ?? pending.markdown;
        const res = await api('PUT', `/api/projects/${pid}/changesets/${cid}/items`, { key: keyOf(node), title, markdown, rebase: args.markdown != null });
        const { changeset } = res;
        const ready = list(args.ready_for_adoption);
        const item = changeset.items.find((it) => it.key === keyOf(node));
        const proposed = item?.new ? editableOf(res.node) : item?.after;
        if (ready.length) {
          if (!item) throw new Refused('Nothing is proposed for this item, so nothing can be ready for adoption');
          const known = new Set(behavioursOf({ ...node, title: proposed.title, body: proposed.markdown, url: '' }).map((b) => b.id));
          const unknown = ready.filter((id) => !known.has(id));
          if (unknown.length) throw new ValidationError(`Not behaviours of this item: ${unknown.join(', ')}`);
          item.readyForAdoption = ready;
          await model.changesets.put(pid, changeset);
        }
        const applies = { ...(await agents.applyAnswers(pid, changeset, item, { answers: list(args.answers), ready: args.item_ready })), ...(await agents.applyNotes(pid, changeset, item, { annotations: list(args.annotations) })) };
        return { refinement: changeset.id, item: keyOf(node), ...(item?.new ? { new: true } : {}), ...(res.rebased ? { rebased: 'The item changed since this refinement opened: your text is now proposed against it as it is, so check you kept what changed.' } : {}), proposed: Boolean(item), ready_for_adoption: item?.readyForAdoption ?? [], ...applies };
      },
    },

    inbox: {
      description: 'What people have addressed to you with @Claude, handed to you now: each comment with the prompt to act on it. Every other tool\'s result carries these too, as addressed_to_you_now; a channel or a watch can call this alone to hear them within seconds.',
      input: {},
      writes: true,
      async run({ pid, agent }) {
        return { addressed_to_you_now: (await agents.addressed(pid, agent)).map(addressedOf) };
      },
    },

    annotations: {
      description: 'Comments, read the way a person reads them: with an item, its open (not dismissed) threads (what they are about, who is addressed, and the replies); without one, every comment addressed to you, each with its prompt.',
      input: { item: { ...place, description: 'The item: issue-12, 12, or a node id. Leave out for what is addressed to you.' } },
      async run({ pid, agent }, args) {
        if (args.item == null) return { addressed_to_you: (await agents.addressed(pid, agent, { fresh: false })).map(addressedOf) };
        const { nodes } = await mapOf(pid);
        const node = find(nodes, args.item);
        const comments = await model.comments.list(pid, keyOf(node));
        const open = threadsOf(comments).filter((t) => isOpen(t.root));
        return {
          item: keyOf(node),
          annotations: await Promise.all(open.map(async ({ root: c, replies }) => ({
            annotation: c.id,
            on: whereOf(c.anchor),
            ...(c.anchor?.quote ? { quoting: c.anchor.quote } : {}),
            by: c.author,
            said: c.text,
            ...(c.to?.length ? { to: c.to.map((t) => t.name) } : {}),
            ...(c.delivery ? { delivery: c.delivery.state } : {}),
            replies: replies.map((r) => ({ by: r.author, said: r.text })),
            ...(c.anchor?.refinement ? { refinement: c.anchor.refinement } : {}),
            ...(toAgent(c) ? { prompt: notePrompt({ nodes, comments, note: c, refinement: c.anchor?.refinement ? await model.changesets.get(pid, c.anchor.refinement) : null }) } : {}),
          }))),
        };
      },
    },

    reply: {
      description: 'Reply in a comment\'s thread, the way a person does: say what you changed, or what you found. Name the refinement that carries your change, if there is one. Replying never dismisses the comment.',
      input: {
        annotation: { type: 'string', description: 'The comment\'s id.' },
        item: { ...place, description: 'The item it is on.' },
        text: { type: 'string' },
        refinement: { type: 'string', description: 'The refinement your change is in, from refine().' },
        request_key: requestKey,
      },
      required: ['annotation', 'item', 'text'],
      changes: true,
      async run({ pid, agent }, args) {
        const node = find((await mapOf(pid)).nodes, args.item);
        const body = { itemKey: keyOf(node), replyTo: String(args.annotation), text: String(args.text ?? ''), author: author(agent), fromAgent: agent.id, ...(args.refinement ? { refinement: String(args.refinement) } : {}) };
        const { comment } = await api('POST', `/api/projects/${pid}/comments`, body);
        return { replied: comment.id, annotation: comment.replyTo, item: keyOf(node) };
      },
    },

    dismiss: {
      description: `Dismiss a comment: its thread moves to the item's conversation log, still readable, naming you, and anyone can restore it. ${DISMISSING}`,
      input: {
        annotation: { type: 'string', description: 'The comment\'s id: the first in its thread.' },
        item: { ...place, description: 'The item it is on.' },
        note: { type: 'string', description: 'Why, in a line: where the conversation went.' },
        request_key: requestKey,
      },
      required: ['annotation', 'item'],
      changes: true,
      async run({ pid, agent }, args) {
        const node = find((await mapOf(pid)).nodes, args.item);
        const { comment } = await api('POST', `/api/projects/${pid}/comments/${keyOf(node)}/${encodeURIComponent(String(args.annotation))}/dismiss`, { by: author(agent), ...(args.note ? { note: String(args.note) } : {}) });
        return { dismissed: comment.id, item: keyOf(node), by: comment.dismissed.by };
      },
    },

    coherence: {
      description: 'What the spec says against itself (#36): behaviour IDs used in two items, two words for one thing, and pairs of behaviours in different items that sit close in meaning, found by an embedding model. Judge each pair in to_judge: read both behaviours and their items, then judge(pair, verdict). A duplicate or contradiction becomes an open question on both items, naming the other.',
      input: {},
      async run({ pid }) {
        const found = await api('GET', `/api/projects/${pid}/coherence`);
        const open = found.pairs.filter((p) => !p.judged);
        return {
          how: 'For each pair in to_judge, decide: duplicate (they say the same thing), contradiction (both can\'t hold), related (close, and both fine) or unrelated. Use context(item) when the behaviour alone doesn\'t settle it, and say why in a note. Then judge(pair, verdict, note). Drift and duplicate IDs are fixed through refine() and propose().',
          duplicate_ids: found.duplicate_ids,
          drift: found.drift,
          to_judge: open.slice(0, 20),
          more_to_judge: Math.max(0, open.length - 20) || undefined,
          judged: found.pairs.length - open.length,
        };
      },
    },

    judge: {
      description: 'Judge a pair from coherence(): duplicate, contradiction, related or unrelated, with a note saying why. A duplicate or contradiction becomes an open question on both items, each naming the other; related and unrelated just take the pair off the list.',
      input: {
        pair: { type: 'string', description: 'The pair\'s key, from coherence().' },
        verdict: { type: 'string', enum: ['duplicate', 'contradiction', 'related', 'unrelated'] },
        note: { type: 'string', description: 'Why, in a line: what each says.' },
        request_key: requestKey,
      },
      required: ['pair', 'verdict'],
      changes: true,
      async run({ pid, agent }, args) {
        return api('POST', `/api/projects/${pid}/coherence/judge`, { pair: String(args.pair ?? ''), verdict: String(args.verdict ?? ''), note: String(args.note ?? ''), by: author(agent), agentId: agent.id });
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
    annotations: { readOnlyHint: !t.changes && !t.writes, idempotentHint: !t.changes && !t.writes, openWorldHint: false },
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
      // Whatever was addressed to this agent since its last call comes with this one, so it hears at once (NOTE-17).
      const now = name === 'standup' || name === 'inbox' ? [] : await agents.addressed(ctx.pid, ctx.agent);
      return { result: result(now.length ? { ...out, addressed_to_you_now: now.map(addressedOf), first: 'Someone addressed you just now: act on addressed_to_you_now before anything else.' } : out) };
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
            capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
            serverInfo: { name: APP_NAME, version: '0.1.0' },
            instructions: `You are ${ctx.agent.name} (${ctx.agent.id}) on ${ctx.project.title}. Start each session with standup(), passing your local git state.`,
          },
        });
      }
      case 'ping':
        return reply({ result: {} });
      case 'tools/list':
        return reply({ result: { tools: definitions } });
      case 'prompts/list':
        return reply({ result: { prompts: Object.entries(PROMPTS).map(([name, p]) => ({ name, title: p.title, description: p.description, arguments: [] })) } });
      case 'prompts/get': {
        const p = PROMPTS[msg.params?.name];
        if (!p) return reply({ error: { code: -32602, message: `No prompt called ${msg.params?.name}` } });
        return reply({ result: { description: p.description, messages: [{ role: 'user', content: { type: 'text', text: p.text } }] } });
      }
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

const answerOf = (a) => ({ item: a.question.itemKey, question_id: a.question.id, question: a.question.text, answer: a.question.answer, ...(a.question.answered ? { answered_by: a.question.answered.by } : {}), ...(a.asker && !a.forAnyone ? { held_for: a.asker } : {}), prompt: a.prompt() });

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
