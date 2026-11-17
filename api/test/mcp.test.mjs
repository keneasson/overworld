// The MCP server's behaviours (MCP-01 to MCP-10, MCP-12 to MCP-14, #4), the standup (CONN-03 to CONN-05, #34), applying an answer (ANSWER-01 to ANSWER-05, #68), annotations addressed to agents (NOTE-08, NOTE-14, NOTE-17 to NOTE-19, #15) and leaf-only work (STATE-09, STATE-10, #32), tested the way an agent uses it: JSON-RPC over HTTP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../app.mjs';
import { modelFor } from '../model/index.mjs';
import { fileTable } from '../model/table.mjs';
import { fakeShop } from './fake-github.mjs';
import { refinementThreads } from '../../shared/annotations.js';

const issue = (n, title, extra = {}) => ({ id: `i${n}`, url: `https://github.com/octo/app/issues/${n}`, title: `#${n} ${title}`, kind: 'story', status: 'ready', order: n, parentId: 'web', ...extra });
const body = ({ why = 'Because.', behaviours, questions = 'None' }) => `Part of #1\n\n## Why\n\n${why}\n\n## Behaviours\n\n${behaviours.map((b) => `- ${b}`).join('\n')}\n\n## Acceptance\n\nIt works.\n\n## Out of scope\n\nNothing.\n\n## Open questions\n\n${questions}\n`;

/** A small project: ready work at two priorities, work blocked by a dependency, a finished sibling and an epic. */
const PROJECT = {
  nodes: [
    { id: 'root', title: 'App', kind: 'project' },
    { id: 'web', parentId: 'root', title: 'Web', kind: 'area', tags: ['code'], status: 'in_progress', body: '**Code here** (2 files):\n\n- [web/zoom.js](https://x/zoom.js)\n- [web/claims.js](https://x/claims.js)' },
    issue(10, 'Zoom', { priority: 'P1', body: body({ why: 'Agents need the map.\n\nDecided by the maintainer: zoom is semantic.', behaviours: ['ZOOM-01 Given a place, when zoomed, then its children show.', 'ZOOM-02 Given a child, when shown, then it has counts.', 'ZOOM-03 Not worked out yet: zooming by date.'] }) }),
    issue(11, 'Claims', { priority: 'P0', body: body({ behaviours: ['CL-01 Given work, when claimed, then it is held.', 'CL-02 Given a claim, when it ends, then it says so.'] }) }),
    issue(12, 'Blocked', { body: body({ behaviours: ['BL-01 Given a dependency, when unfinished, then this waits.'] }), links: [{ to: 'i13', type: 'depends' }] }),
    issue(13, 'Dependency', { status: 'planned', body: body({ behaviours: ['DEP-01 Given time, when spent, then it is done.'] }) }),
    issue(14, 'Finished', { status: 'done', body: body({ behaviours: ['FIN-01 Given done, when looked at, then done.'] }) }),
    issue(15, 'Epic', { kind: 'epic', body: body({ behaviours: ['EP-01 Given an epic, when big, then not work.'] }) }),
  ],
};

/** @param {object} [o] @param {number} [o.racing] hold the first this-many claim writes until they have all arrived, so they truly race */
async function setup({ callsPerMinute, racing = 0 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'overworld-mcp-'));
  const file = join(dir, 'table.json');
  const table = fileTable(file);
  const waiting = [];
  const model = modelFor(!racing ? table : {
    ...table,
    async claimAll(...args) {
      if (racing && waiting.length < racing - 1) await new Promise((go) => waiting.push(go));
      else if (racing) (racing = 0), waiting.splice(0).forEach((go) => go());
      return table.claimAll(...args);
    },
  });
  const clock = { now: Date.parse('2030-01-07T10:00:00Z') };
  const shop = fakeShop();
  const api = createApi({ model, accessKey: 'k', fetchImpl: shop.fetch, log: { error() {} }, clock: () => clock.now, agentCallsPerMinute: callsPerMinute });
  const rest = async (method, path, b) => (await api({ method, path, body: b, headers: { 'x-projectmap-key': 'k' } })).body;
  const pid = (await rest('POST', '/api/import/json', PROJECT)).project.id;
  const post = (token, msg) => api({ method: 'POST', path: '/api/mcp', body: msg, headers: token ? { authorization: `Bearer ${token}` } : {} });
  /** A new agent on a project, and its MCP client. */
  async function agent(name, project = pid) {
    const { agent: me, token } = await rest('POST', `/api/projects/${project}/agents`, { name });
    let id = 0;
    const rpc = async (method, params) => (await post(token, { jsonrpc: '2.0', id: ++id, method, params })).body;
    const tool = async (n, args = {}) => (await rpc('tools/call', { name: n, arguments: args })).result;
    const use = async (n, args) => {
      const r = await tool(n, args);
      assert.ok(!r.isError, `${n}: ${r.content[0].text}`);
      return r.structuredContent;
    };
    return { id: me.id, token, rpc, tool, use, refused: async (n, args) => (await tool(n, args)).structuredContent };
  }
  // A comment a person dismissed into the conversation log (NOTE-05).
  const clear = async (itemKey, id) => rest('POST', `/api/projects/${pid}/comments/${itemKey}/${id}/dismiss`, { by: 'Ken' });
  return { api, rest, pid, agent, post, clock, file, shop, clear };
}

test('MCP-07 an agent signs in with its own token, acts only in its project, and its token can be revoked alone', async () => {
  const { rest, pid, agent, post, file } = await setup();
  assert.equal((await post(null, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);
  assert.equal((await post('owk_made-up', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);
  const a = await agent('Builder');
  const b = await agent('Reviewer');
  const init = await a.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.ok(init.result.capabilities.tools);
  assert.ok((await a.rpc('tools/list')).result.tools.some((t) => t.name === 'claim'));

  const other = (await rest('POST', '/api/import/json', { nodes: [{ id: 'root', title: 'Elsewhere', kind: 'project' }, { id: 'x', parentId: 'root', title: 'Secret plans' }] })).project.id;
  const c = await agent('Outsider', other);
  assert.equal((await c.use('zoom')).place.title, 'Elsewhere');
  assert.ok((await c.refused('context', { issue: 'issue-10' })).error, "another project's items can't be reached");
  assert.equal((await a.use('zoom')).place.title, 'App');

  assert.ok(!(await readFile(file, 'utf8')).includes(a.token), 'the token itself is never stored');
  await rest('DELETE', `/api/projects/${pid}/agents/${a.id}`);
  assert.equal((await post(a.token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401, 'revoked');
  assert.equal((await b.use('zoom')).place.title, 'App', 'every other token still works');
});

test('MCP-01 zoom returns a place and its children, each with title, summary, state and counts', async () => {
  const { agent } = await setup();
  const a = await agent('Builder');
  const top = await a.use('zoom');
  assert.deepEqual(top.children.map((c) => c.title), ['Web']);
  assert.equal(top.place.counts.behaviours, 8, 'behaviours in the Fog are not counted');
  const web = await a.use('zoom', { place: top.children[0].key });
  assert.deepEqual(web.path, ['App']);
  const zoom = web.children.find((c) => c.key === 'issue-10');
  assert.equal(zoom.state, 'ready');
  assert.deepEqual(zoom.counts, { items: 1, open: 1, done: 0, behaviours: 2, claimed: 0, questions: 0 });
});

test('MCP-02 next_work returns new, unclaimed behaviours by issue in priority order, leaving out blocked work', async () => {
  const { agent } = await setup();
  const a = await agent('Builder');
  const b = await agent('Other');
  const { work, blocked } = await a.use('next_work');
  assert.deepEqual(work.map((w) => w.item), ['issue-11', 'issue-10'], 'P0 first; not the epic, the blocked, the planned or the finished');
  assert.deepEqual(work[1].behaviours.map((x) => x.id), ['ZOOM-01', 'ZOOM-02'], 'not the behaviour still in the Fog');
  assert.equal(blocked, 1);
  assert.deepEqual((await a.use('context', { issue: 'issue-12' })).blocked_by.map((x) => x.key), ['issue-13'], 'asking about blocked work says what blocks it');
  await b.use('claim', { behaviours: ['CL-01', 'CL-02'] });
  assert.deepEqual((await a.use('next_work')).work.map((w) => w.item), ['issue-10'], 'claimed work is no longer offered');
});

test('MCP-03 context gives one issue whole, with finished siblings and old discussion summarised', async () => {
  const { agent, rest, pid, clear } = await setup();
  const a = await agent('Builder');
  await rest('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-10', anchor: { behaviour: 'ZOOM-01' }, text: 'Children in order?' });
  const old = (await rest('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-10', text: 'Settled long ago.' })).comment;
  await clear('issue-10', old.id);
  await a.use('claim', { behaviours: ['ZOOM-01'] });
  await a.use('handoff', { note: 'Children render; counts next.' });
  const c = await a.use('context', { issue: 'issue-10' });
  assert.deepEqual(c.parents.map((p) => p.title), ['App', 'Web']);
  assert.match(c.siblings.finished, /^1 finished: #14 Finished/);
  assert.ok(c.siblings.open.some((s) => s.key === 'issue-11'));
  assert.deepEqual(c.decisions, ['Decided by the maintainer: zoom is semantic.']);
  assert.deepEqual(c.behaviours.map((x) => [x.id, x.state]), [['ZOOM-01', 'new'], ['ZOOM-02', 'new'], ['ZOOM-03', 'not worked out yet']]);
  assert.deepEqual(c.discussion.open.map((d) => [d.on, d.said]), [['ZOOM-01', 'Children in order?']]);
  assert.equal(c.discussion.dismissed, '1 dismissed comment, in the conversation log');
  assert.deepEqual(c.handoff_notes.map((n) => n.note), ['Children render; counts next.']);
  assert.deepEqual(c.files, ['web/zoom.js', 'web/claims.js']);
  assert.deepEqual(c.open_questions, []);

  // From a repository: the pull requests that close an issue, and where it lives in the code.
  const shopId = (await rest('POST', '/api/import/github', { repo: 'octo/shop' })).project.id;
  const s = await agent('Shopper', shopId);
  assert.deepEqual((await s.use('context', { issue: '5' })).pull_requests, ['#9']);
  assert.ok((await s.use('context', { issue: 'issue-4' })).files.includes('apps/web/app/api/payments/route.ts'));
});

test('MCP-04 a claim is atomic and time-limited; a second claimant is refused and told who holds it', async () => {
  const { agent } = await setup();
  const a = await agent('Builder');
  const b = await agent('Rival');
  const mine = await a.use('claim', { behaviours: ['ZOOM-01'] });
  assert.deepEqual(mine.claimed, ['ZOOM-01']);
  assert.equal(mine.until, '2030-01-07T12:00:00.000Z');
  const no = await b.refused('claim', { behaviours: ['ZOOM-02', 'ZOOM-01'] });
  assert.match(no.error, /ZOOM-01 by Builder/);
  assert.equal(no.held_by[0].behaviour, 'ZOOM-01');
  assert.equal((await a.use('context', { issue: 'issue-10' })).behaviours.find((x) => x.id === 'ZOOM-02').state, 'new', 'a refused claim takes nothing');
  assert.equal((await a.use('context', { issue: 'issue-10' })).behaviours.find((x) => x.id === 'ZOOM-01').state, 'being coded');

  assert.match((await b.refused('claim', { behaviours: ['BL-01'] })).error, /waits on #13 Dependency/);
});

test('MCP-04 two agents claiming the next work at the same moment never get the same work', async () => {
  const { agent } = await setup({ racing: 2 });
  const [a, b] = [await agent('One'), await agent('Two')];
  const [x, y] = await Promise.all([a.use('claim'), b.use('claim')]);
  assert.ok(x.claimed.length && y.claimed.length, 'both got work');
  assert.equal(new Set([...x.claimed, ...y.claimed]).size, x.claimed.length + y.claimed.length, 'none of it the same');
});

test('MCP-05 ask puts an open question on a place until it is answered', async () => {
  const { agent, clear } = await setup();
  const a = await agent('Builder');
  const asked = await a.use('ask', { place: 'issue-11', question: 'How long should a claim last?' });
  assert.deepEqual((await a.use('context', { issue: 'issue-11' })).open_questions, [`How long should a claim last? (Builder (${a.id}))`]);
  await clear('issue-11', asked.question);
  assert.deepEqual((await a.use('context', { issue: 'issue-11' })).open_questions, []);
});

test('MCP-06 ADOPT-08 refine and propose open and fill a refinement; an agent marks behaviours ready, and never adopts', async () => {
  const { agent, rest, pid } = await setup();
  const a = await agent('Builder');
  const { refinement } = await a.use('refine', { place: 'issue-11' });
  assert.equal((await a.use('refine', { place: 'issue-11' })).refinement, refinement, 'refining the same place again returns the open refinement');
  const markdown = body({ behaviours: ['CL-01 Given work, when claimed, then it is held for two hours.', 'CL-02 Given a claim, when it ends, then it says so.'] });
  const done = await a.use('propose', { refinement, item: 'issue-11', markdown, ready_for_adoption: ['CL-01'] });
  assert.deepEqual(done.ready_for_adoption, ['CL-01']);
  assert.match((await a.use('context', { issue: 'issue-11' })).behaviours[0].text, /then it is held\.$/, 'the spec is unchanged until a person adopts');
  const cs = (await rest('GET', `/api/projects/${pid}/changesets`)).changesets.find((x) => x.id === refinement);
  assert.equal(cs.status, 'open');
  assert.equal(cs.author, `Builder (${a.id})`);
  assert.match(cs.items[0].after.markdown, /two hours/);
  assert.deepEqual((await a.use('propose', { refinement, item: 'issue-11', markdown: body({ behaviours: ['CL-01 x'], questions: 'How long?' }), ready_for_adoption: ['CL-01'] })).ready_for_adoption, ['CL-01'], 'open questions never block it');
  assert.ok(!(await a.rpc('tools/list')).result.tools.some((t) => /adopt|accept/.test(t.name)), 'no tool adopts');
});

test("ADOPT-05 ADOPT-10 a person adopts or declines an agent's refinement, and the agent hears which, and why, at its standup", async () => {
  const { agent, rest, pid, clock } = await setup();
  const a = await agent('Builder');
  await a.use('standup');
  clock.now += 60_000;
  const { refinement } = await a.use('refine', { place: 'issue-10' });
  await a.use('propose', { refinement, item: 'issue-11', markdown: body({ behaviours: ['CL-01 Given work, when claimed, then it is held for two hours.'] }), ready_for_adoption: ['CL-01'] });
  await a.use('propose', { refinement, item: 'issue-12', markdown: body({ behaviours: ['BL-01 Given a dependency, when unfinished, then nothing waits.'] }) });
  await rest('POST', `/api/projects/${pid}/changesets/${refinement}/items/issue-11/adopt`, { by: 'Ken' });
  await rest('POST', `/api/projects/${pid}/changesets/${refinement}/items/issue-12/decline`, { by: 'Ken', reason: 'Work must wait for its dependency.' });
  assert.match((await a.use('context', { issue: 'issue-11' })).behaviours[0].text, /two hours/, 'adopted into the spec');
  assert.match((await a.use('context', { issue: 'issue-12' })).behaviours[0].text, /then this waits/, 'declined: the spec stays');
  const decided = (await a.use('standup')).addressed_to_you.your_refinements_decided;
  assert.deepEqual(decided.map((d) => [d.item, d.outcome, d.by, d.reason]), [['issue-11', 'adopted', 'Ken', undefined], ['issue-12', 'declined', 'Ken', 'Work must wait for its dependency.']]);
  assert.deepEqual(decided.map((d) => d.behaviours), [['CL-01', 'CL-02'], ['BL-01']], 'which behaviours, as people decide them one at a time: the proposal changed CL-01 and dropped CL-02');
  assert.ok(!(await a.rpc('tools/list')).result.tools.some((t) => /adopt|accept|decline/.test(t.name)), 'the agent itself never adopts');
});

test('ADOPT-03 ADOPT-05 ADOPT-06 ADOPT-14 a person reviews a refinement one behaviour at a time, asks about one, and the agent answers with a revision that is adopted later', async () => {
  const { agent, rest, pid, clock } = await setup();
  const a = await agent('Builder');
  await a.use('standup');
  clock.now += 60_000;
  const cl = (n, then) => `CL-0${n} Given work, when step ${n} happens, then ${then}.`;
  const { refinement } = await a.use('refine', { place: 'issue-11' });
  await a.use('propose', { refinement, item: 'issue-11', markdown: body({ behaviours: [cl(1, 'it is held for two hours'), cl(2, 'it says so'), cl(3, 'it lasts longer'), cl(4, 'it is logged'), cl(5, 'it expires in five minutes')] }) });
  const decide = (action, b) => rest('POST', `/api/projects/${pid}/changesets/${refinement}/items/issue-11/${action}`, { by: 'Ken', ...b });
  const spec = async () => (await a.use('context', { issue: 'issue-11' })).behaviours.map((b) => `${b.id} ${b.text}`).join('\n');

  // Three adopted, one declined with a reason, and a question on the fifth.
  await decide('adopt', { behaviours: ['CL-01', 'CL-02', 'CL-03'] });
  const declined = await decide('decline', { behaviours: ['CL-04'], reason: 'We log everything already.' });
  assert.equal(declined.changeset.status, 'open', 'one still to decide');
  const asked = (await rest('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-11', anchor: { on: 'behaviour', behaviour: 'CL-05', refinement }, text: 'Why five minutes? A long build takes longer.', author: 'Ken' })).comment;
  assert.deepEqual(asked.anchor, { on: 'behaviour', section: 'Behaviours', behaviour: 'CL-05', refinement }, 'on the behaviour as the refinement proposes it, not the adopted text');
  const threads = async () => refinementThreads((await rest('GET', `/api/projects/${pid}/comments/issue-11`)).comments, (await rest('GET', `/api/projects/${pid}/changesets`)).changesets.find((c) => c.id === refinement));
  assert.equal((await threads()).get('CL-05').unanswered, 1, 'it waits for the refinement\'s author: a badge on CL-05');

  // The author hears of it at standup, as other comments addressed to it, with what it proposed and how to answer.
  const report = await a.use('standup');
  const note = report.addressed_to_you.annotations.find((n) => n.annotation === asked.id);
  assert.ok(note, 'addressed to the refinement\'s author');
  assert.match(note.prompt, new RegExp(`CL-05, as your refinement ${refinement} proposes it`));
  assert.match(note.prompt, /You propose:\n> CL-05 .*five minutes/);
  assert.match(note.prompt, new RegExp(`propose\\(refinement: "${refinement}"`));
  assert.deepEqual(report.addressed_to_you.your_refinements_decided.map((d) => [d.outcome, d.behaviours, d.reason]), [['adopted', ['CL-01', 'CL-02', 'CL-03'], undefined], ['declined', ['CL-04'], 'We log everything already.']]);

  // The agent answers with a revision and a reply; the thread stays with CL-05 through it.
  await a.use('propose', { refinement, item: 'issue-11', markdown: body({ behaviours: [cl(1, 'it is held for two hours'), cl(2, 'it says so'), cl(3, 'it lasts longer'), cl(5, 'it expires when its build does')] }), annotations: [asked.id] });
  await a.use('reply', { annotation: asked.id, item: 'issue-11', text: 'It now lasts as long as the build.', refinement });
  const after = (await threads()).get('CL-05');
  assert.equal(after.unanswered, 0, 'answered');
  assert.deepEqual(after.threads[0].replies.map((r) => r.text), ['It now lasts as long as the build.']);
  assert.doesNotMatch(await spec(), /CL-05/, 'nothing adopted yet');

  // Adopted later: nothing is left, so the refinement closes.
  const done = await decide('adopt', { behaviours: ['CL-05'] });
  assert.equal(done.changeset.status, 'accepted');
  assert.match(await spec(), /CL-05 .*when its build does/);
  assert.doesNotMatch(await spec(), /CL-04/);
});

test('NEW-05 an agent proposes a new item, and it arrives in the refinement the way a person\'s does', async () => {
  const { agent, rest, pid } = await setup();
  const a = await agent('Builder');
  const { refinement } = await a.use('refine', { place: 'issue-15' });
  const made = await a.use('propose', { refinement, parent: 'issue-15', kind: 'feature', title: 'Epic part one' });
  assert.equal(made.new, true);
  const cs = (await rest('GET', `/api/projects/${pid}/changesets`)).changesets.find((x) => x.id === refinement);
  assert.deepEqual(cs.items.map((it) => [it.key, it.new]), [[made.item, true]]);
  const { nodes } = await rest('GET', `/api/projects/${pid}`);
  const node = nodes.find((n) => `node-${n.id}` === made.item);
  assert.equal(node.parentId, nodes.find((n) => n.title.startsWith('#15 ')).id);
  assert.ok(node.body.startsWith('Part of #15\nKind: Feature'), node.body);
  const markdown = body({ behaviours: ['PART-01 Given a part, when built, then it fits.'] });
  assert.deepEqual((await a.use('propose', { refinement, item: made.item, markdown, ready_for_adoption: ['PART-01'] })).ready_for_adoption, ['PART-01'], 'then it is refined like any item');
  assert.equal((await a.use('zoom', { place: 'issue-15' })).children.find((c) => c.key === made.item).state, 'needs improvement');
  assert.ok(!(await a.use('next_work', {})).work.some((w) => w.item === made.item), 'not work until a person adopts it');
});

test('MCP-08 prime returns the conventions, standing decisions, remembered facts, and your own claims and handoff notes', async () => {
  const { agent, rest, shop } = await setup();
  shop.tree.push({ path: 'CONTRIBUTING.md', type: 'blob' }, { path: 'CLAUDE.md', type: 'blob' });
  shop.docs['CONTRIBUTING.md'] = '# Contributing\n\n## Standing decisions\n\n1. Test behaviour, never mechanics.\n\n## Lifecycle\n\nLabels.\n';
  const shopId = (await rest('POST', '/api/import/github', { repo: 'octo/shop' })).project.id;
  const a = await agent('Builder', shopId);
  const p = await a.use('prime');
  assert.equal(p.you.name, 'Builder');
  assert.equal(p.standing_decisions, '1. Test behaviour, never mechanics.');
  assert.equal(p.conventions, 'Read CONTRIBUTING.md and CLAUDE.md in the repository.');
  assert.ok(p.how_to_work.length < 10, 'short');
  assert.deepEqual(p.your_claims, []);
});

test('MCP-09 handoff releases a claim with a note the next agent reads; a claim that runs out is released and says so', async () => {
  const { agent, clock } = await setup();
  const a = await agent('Builder');
  const b = await agent('Successor');
  await a.use('claim', { behaviours: ['CL-01', 'CL-02'] });
  const out = await a.use('handoff', { behaviours: ['CL-01'], note: 'Held in a transaction; tests next.' });
  assert.deepEqual(out.released, ['CL-01']);
  await b.use('claim', { behaviours: ['CL-01'] });
  const p = await b.use('prime');
  assert.deepEqual(p.your_claims.map((c) => c.behaviours), [['CL-01']]);
  assert.deepEqual(p.handoff_notes.map((n) => n.note), ['Held in a transaction; tests next.']);
  assert.equal((await a.use('prime')).your_last_handoff.note, 'Held in a transaction; tests next.');

  clock.now += 3 * 60 * 60 * 1000; // past both claims
  const c = await b.use('context', { issue: 'issue-11' });
  assert.deepEqual(c.behaviours.map((x) => x.state), ['new', 'new'], 'released');
  assert.equal(c.handoff_notes.filter((n) => n.expired).length, 2);
  assert.match(c.handoff_notes.find((n) => n.expired && n.behaviours[0] === 'CL-02').note, /ran out .* without a handoff/);
  assert.equal((await b.use('context', { issue: 'issue-11' })).handoff_notes.length, 3, 'noticing an expiry again adds nothing');
});

test('MCP-10 remember records a fact, attributed, that every agent gets from prime and people can see', async () => {
  const { agent, rest, pid, clock } = await setup();
  const a = await agent('Builder');
  const b = await agent('Later');
  await a.use('remember', { fact: 'Claims last two hours.' });
  clock.now += 1000;
  await rest('POST', `/api/projects/${pid}/facts`, { text: 'Never merge.', author: 'Ken' });
  assert.deepEqual((await b.use('prime')).remembered.map((f) => [f.fact, f.by]), [['Claims last two hours.', `Builder (${a.id})`], ['Never merge.', 'Ken']]);
  assert.equal((await rest('GET', `/api/projects/${pid}/facts`)).facts.length, 2);
});

test('MCP-12 a repeated call with the same request key changes nothing more and returns the first result', async () => {
  const { agent, rest, pid } = await setup();
  const a = await agent('Builder');
  const first = await a.use('ask', { place: 'issue-10', question: 'Order?', request_key: 'q-1' });
  const again = await a.use('ask', { place: 'issue-10', question: 'Order?', request_key: 'q-1' });
  assert.deepEqual(again, first);
  assert.equal((await rest('GET', `/api/projects/${pid}/comments/issue-10`)).comments.length, 1);
  await a.use('remember', { fact: 'Once.', request_key: 'f-1' });
  await a.use('remember', { fact: 'Once.', request_key: 'f-1' });
  assert.equal((await rest('GET', `/api/projects/${pid}/facts`)).facts.length, 1);
});

test('MCP-13 an agent past its limit is refused with when to try again, and nobody else is slowed', async () => {
  const { agent, clock } = await setup({ callsPerMinute: 3 });
  const a = await agent('Busy');
  const b = await agent('Calm');
  for (let i = 0; i < 3; i++) await a.use('next_work');
  const no = await a.refused('next_work');
  assert.match(no.error, /Too many calls/);
  assert.equal(no.retry_after, '2030-01-07T10:01:00.000Z');
  await b.use('next_work');
  clock.now += 60_000;
  await a.use('next_work');
});

test('MCP-14 every change is recorded with the agent, the time and what changed', async () => {
  const { agent, rest, pid } = await setup();
  const a = await agent('Builder');
  await a.use('claim', { behaviours: ['ZOOM-01'] });
  await a.use('zoom');
  await a.use('handoff', { note: 'Done for today.' });
  const { actions } = await rest('GET', `/api/projects/${pid}/agents/${a.id}/actions`);
  assert.deepEqual(actions.map((x) => x.tool), ['handoff', 'claim'], 'newest first; reads are not changes');
  assert.ok(actions.every((x) => x.agentId === a.id && x.at === '2030-01-07T10:00:00.000Z'));
  assert.deepEqual(actions[1].change.result.claimed, ['ZOOM-01']);
});

/** An agent's question on #11, answered by a person in the app. */
async function answered({ prompt } = {}) {
  const s = await setup();
  const a = await s.agent('Builder');
  await a.use('standup');
  const { question } = await a.use('ask', { place: 'issue-11', question: 'How long should a claim last?' });
  const path = `/api/projects/${s.pid}/comments/issue-11/${question}`;
  const sent = await s.rest('POST', `/api/projects/${s.pid}/comments`, { itemKey: 'issue-11', replyTo: question, text: 'Two hours, renewable.', author: 'Ken', prompt });
  return { ...s, a, question, path, sent };
}

test('ANSWER-01 ANSWER-02 ANSWER-05 a person\'s reply to a question is its answer, waiting to be applied, with one prompt the person can read and change first', async () => {
  const { rest, pid, path, sent, question } = await answered();
  const seen = await rest('POST', `${path}/prompt`, { text: 'Two hours, renewable.', author: 'Ken' });
  assert.equal(seen.prompt, sent.prompt, 'the person sees the prompt that goes');
  for (const part of [/How long should a claim last\?/, /in Open questions/, /Two hours, renewable\./, /## Behaviours\n\n- CL-01/, /parent: Web/, /#10 Zoom \(issue-10\), ready/, /would be ready/, /Write the decision where it belongs/, /Clear the question from Open questions/, /behaviours to add/, /Mark the item ready/]) assert.match(sent.prompt, part);
  const [c, reply] = (await rest('GET', `/api/projects/${pid}/comments/issue-11`)).comments;
  assert.deepEqual([reply.replyTo, reply.text], [question, 'Two hours, renewable.'], 'the answer is a reply in its thread');
  assert.deepEqual([c.dismissed, c.answer.text, c.answer.by, c.answer.appliedAt], [undefined, 'Two hours, renewable.', 'Ken', undefined], 'answered, waiting to be applied');
  const own = (await rest('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-11', anchor: { section: 'Open questions' }, text: 'Weekends too?', author: 'Ken' })).comment;
  assert.ok(!(await rest('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-11', replyTo: own.id, text: 'Thinking aloud.', author: 'Ken' })).thread.answer, 'the asker talking in their own thread is not an answer');
  assert.ok((await rest('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-11', replyTo: own.id, text: 'Yes.', author: 'Ana' })).thread.answer, 'anyone else\'s reply is');

  const edited = await answered({ prompt: `${sent.prompt}\n\nKeep the wording short.` });
  assert.match(edited.sent.prompt, /Keep the wording short\.$/);
  assert.match((await edited.a.use('standup')).addressed_to_you.answered[0].prompt, /Keep the wording short\.$/, 'the changed prompt is the one that goes');
});

test("ANSWER-03 the agent that asked gets the prompt as its first step; once it stays away a claim's length, any agent gets it from next_work", async () => {
  const { a, agent, clock, question } = await answered();
  const b = await agent('Reviewer');
  assert.ok(!(await b.use('next_work')).answers_to_apply, 'it waits for the agent that asked');
  const r = await a.use('standup');
  assert.equal(r.addressed_to_you.answered[0].question_id, question);
  assert.match(r.addressed_to_you.answered[0].prompt, /Two hours, renewable/);
  assert.match(r.first_step, /^Apply the answer to your question on #11 Claims/);
  clock.now += 121 * 60_000;
  const open = (await b.use('next_work')).answers_to_apply;
  assert.deepEqual(open.map((x) => [x.item, x.question_id]), [['issue-11', question]]);
  assert.match(open[0].prompt, /propose\(/);
});

test('ANSWER-04 NOTE-05 the answer is applied through a refinement; adopting it applies the answer, which stops it going to agents, the thread stays, and the item comes back ready', async () => {
  const { a, rest, pid, question } = await answered();
  await rest('PATCH', `/api/projects/${pid}/nodes/i11`, { status: 'needs_decision' });
  const { refinement } = await a.use('refine', { place: 'issue-11' });
  const markdown = body({ behaviours: ['CL-01 Given work, when claimed, then it is held for two hours, and can be held again.', 'CL-02 Given a claim, when it ends, then it says so.'] });
  const done = await a.use('propose', { refinement, item: 'issue-11', markdown, answers: [question], item_ready: true });
  assert.deepEqual([done.answers, done.item_ready], [[question], true]);
  assert.equal((await rest('GET', `/api/projects/${pid}/comments/issue-11`)).comments[0].answer.appliedAt, undefined, 'not applied until adopted');
  const adopted = await rest('POST', `/api/projects/${pid}/changesets/${refinement}/accept`);
  assert.equal(adopted.nodes[0].status, 'ready');
  assert.match(adopted.nodes[0].body, /two hours, and can be held again/);
  const [c] = (await rest('GET', `/api/projects/${pid}/comments/issue-11`)).comments;
  assert.deepEqual([c.answer.appliedBy, c.dismissed], [refinement, undefined], 'applied, naming the refinement, and the thread stays where it is');
  assert.ok(!(await a.use('standup')).addressed_to_you.answered?.some((x) => x.prompt), 'and it no longer goes to agents');
  assert.deepEqual((await a.use('context', { issue: 'issue-11' })).open_questions, [], 'nor is it an open question');
});

/** A person's annotation on #11's Why, with an @mention in it. */
const annotate = (rest, pid, body) => rest('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-11', anchor: { on: 'word', section: 'Why', quote: 'Because', prefix: '', suffix: '.' }, author: 'Ken', ...body });

test('NOTE-14 NOTE-17 an @Claude annotation is addressed to an agent, reaches the next agent to call in whatever it calls, and the thread says where it went', async () => {
  const { rest, pid, agent } = await setup();
  const a = await agent('Builder');
  const b = await agent('Reviewer');
  const { comment } = await annotate(rest, pid, { text: '@Claude this says nothing. @Ken agrees.' });
  assert.deepEqual(comment.to, [{ name: 'Claude', agent: true }, { name: 'Ken' }]);
  assert.equal(comment.delivery.state, 'waiting');
  const now = (await a.use('zoom')).addressed_to_you_now;
  assert.deepEqual(now.map((n) => [n.annotation, n.from]), [[comment.id, 'Ken']]);
  assert.match(now[0].prompt, /this says nothing/);
  assert.ok(!(await a.use('zoom')).addressed_to_you_now, 'handed over once');
  assert.ok(!(await b.use('zoom')).addressed_to_you_now, 'it is the first agent’s');
  const [c] = (await rest('GET', `/api/projects/${pid}/comments/issue-11`)).comments;
  assert.deepEqual([c.delivery.state, c.delivery.to], ['delivered', `Builder (${a.id})`]);
  const up = await a.use('standup');
  assert.equal(up.addressed_to_you.annotations[0].annotation, c.id, 'and the standup keeps it as the first step');
  assert.match(up.first_step, /^Act on what Ken addressed to you/);
  const named = (await annotate(rest, pid, { text: '@Reviewer have a look' })).comment;
  assert.ok(!(await a.use('zoom')).addressed_to_you_now, 'one named agent: nobody else');
  assert.equal((await b.use('inbox')).addressed_to_you_now[0].annotation, named.id);
});

test('NOTE-18 a comment reaches the agent with everything needed to act on it: what it says and quotes, where, its thread, the other open comments, the whole item and its place on the map', async () => {
  const { rest, pid, agent } = await setup();
  const a = await agent('Builder');
  const { comment } = await annotate(rest, pid, { text: '@Claude make this blue' });
  await annotate(rest, pid, { replyTo: comment.id, text: 'Only the heading, mind.' });
  await rest('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-11', anchor: { behaviour: 'CL-02' }, text: 'Say how long.', author: 'Ana' });
  const gone = (await rest('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-11', anchor: { section: 'Why' }, text: 'Old news.', author: 'Ana' })).comment;
  await rest('POST', `/api/projects/${pid}/comments/issue-11/${gone.id}/dismiss`, { by: 'Ana' });
  const [{ prompt }] = (await a.use('inbox')).addressed_to_you_now;
  for (const part of [/^Ken addressed you in a comment on #11 Claims \(issue-11\)/, /The comment, on these words in Why:\n> Because/, /> @Claude make this blue/, /- Ken: Only the heading, mind\./, /- Ana, on CL-02: Say how long\./, /## Behaviours\n\n- CL-01/, /parent: Web/, /#10 Zoom \(issue-10\), ready/, new RegExp(`annotations: \\["${comment.id}"\\]`), /reply\(annotation:/])
    assert.match(prompt, part);
  assert.doesNotMatch(prompt, /Old news|Question|Problem|Refactor/, 'only open comments, and no kinds');
});

test('NOTE-19 NOTE-08 NOTE-05 the agent acts through a refinement and replies in the thread naming it; adopting the refinement dismisses nothing, and an agent dismisses by name', async () => {
  const { rest, pid, agent } = await setup();
  const a = await agent('Builder');
  const { comment } = await annotate(rest, pid, { text: '@Claude this Why says nothing' });
  const id = comment.id;
  assert.equal((await a.use('inbox')).addressed_to_you_now[0].annotation, id);
  const read = await a.use('annotations', { item: 'issue-11' });
  assert.deepEqual(read.annotations.map((n) => [n.annotation, n.kind, n.quoting, n.delivery]), [[id, undefined, 'Because', 'delivered']], 'read the way a person reads it, with no kind');
  const { refinement } = await a.use('refine', { place: 'issue-11' });
  const markdown = body({ why: 'Agents must not build the same thing twice.', behaviours: ['CL-01 Given work, when claimed, then it is held.', 'CL-02 Given a claim, when it ends, then it says so.'] });
  assert.deepEqual((await a.use('propose', { refinement, item: 'issue-11', markdown, annotations: [id] })).annotations, [id]);
  await a.use('reply', { annotation: id, item: 'issue-11', text: 'The Why now says what claims prevent.', refinement });
  let [root, reply] = (await rest('GET', `/api/projects/${pid}/comments/issue-11`)).comments;
  assert.deepEqual([reply.replyTo, reply.author, reply.refinement], [id, `Builder (${a.id})`, refinement]);
  assert.deepEqual([root.delivery.state, root.dismissed], ['replied', undefined], 'replied, and still there');
  assert.ok(!(await a.use('standup')).addressed_to_you.annotations, 'nothing left addressed to it');
  await rest('POST', `/api/projects/${pid}/changesets/${refinement}/accept`);
  [root] = (await rest('GET', `/api/projects/${pid}/comments/issue-11`)).comments;
  assert.equal(root.dismissed, undefined, 'adopting dismisses nothing');
  assert.equal((await a.use('annotations', { item: 'issue-11' })).annotations.length, 1);
  const { tools } = (await a.rpc('tools/list')).result;
  assert.match(tools.find((t) => t.name === 'dismiss').description, /Never dismiss a person's comment just because you replied/, 'the tool says when not to');
  assert.ok((await a.use('prime')).how_to_work.some((l) => /Never dismiss a person's comment just because you replied/.test(l)));
  const gone = await a.use('dismiss', { annotation: id, item: 'issue-11', note: 'Settled by the refinement.' });
  assert.equal(gone.by, `Builder (${a.id})`);
  [root] = (await rest('GET', `/api/projects/${pid}/comments/issue-11`)).comments;
  assert.deepEqual([root.dismissed.by, root.dismissed.note], [`Builder (${a.id})`, 'Settled by the refinement.'], 'an agent’s dismissal names it');
  assert.deepEqual((await a.use('annotations', { item: 'issue-11' })).annotations, []);
});

test('CONN-07 the agents list shows when each agent last called, written at most every few minutes', async () => {
  const { rest, pid, agent, clock } = await setup();
  const a = await agent('Builder');
  const seen = async () => (await rest('GET', `/api/projects/${pid}/agents`)).agents.find((x) => x.id === a.id).lastSeenAt;
  assert.equal(await seen(), null, 'not connected until its first call');
  await a.use('zoom');
  const first = await seen();
  assert.equal(first, new Date(clock.now).toISOString(), 'connected after its first call');
  clock.now += 60 * 1000;
  await a.use('zoom');
  assert.equal(await seen(), first, 'a minute later, nothing new is written');
  clock.now += 10 * 60 * 1000;
  await a.use('zoom');
  assert.equal(await seen(), new Date(clock.now).toISOString(), 'later calls move it on');
  await rest('DELETE', `/api/projects/${pid}/agents/${a.id}`);
  const after = (await rest('GET', `/api/projects/${pid}/agents`)).agents.find((x) => x.id === a.id);
  assert.ok(after.revokedAt && after.lastSeenAt, 'a revoked agent keeps its last call, and its revocation');
});

test('CONN-03 the standup prompt asks the agent for its local state, and the standup tool reports it beside what is waiting', async () => {
  const { rest, pid, agent, clock, clear } = await setup();
  const a = await agent('Builder');
  const b = await agent('Reviewer');
  const init = await a.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.ok(init.result.capabilities.prompts);
  assert.deepEqual((await a.rpc('prompts/list')).result.prompts.map((p) => p.name), ['standup']);
  const prompt = (await a.rpc('prompts/get', { name: 'standup' })).result.messages[0].content.text;
  assert.match(prompt, /git status/);
  assert.match(prompt, /standup tool/);

  await a.use('standup');
  clock.now += 60_000;
  const { question } = await a.use('ask', { place: 'issue-10', question: 'Semantic or geometric?' });
  await a.use('claim', { behaviours: ['CL-01'] });
  clock.now += 10 * 60_000;
  await rest('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-11', anchor: { behaviour: 'CL-01' }, text: 'Hold it for a day?', author: 'Ken' });
  await clear('issue-10', question);
  await b.use('standup');

  const r = await a.use('standup', { branch: 'claims', ahead: 1, behind: 2, unpushed: ['Hold claims'], uncommitted: ['api/claims.mjs'], pull_requests: [{ number: 7, title: 'Claims', state: 'OPEN' }] });
  assert.equal(r.mode, 'up_to_date');
  assert.deepEqual(r.addressed_to_you.answered.map((q) => q.question), ['Semantic or geometric?']);
  assert.deepEqual(r.addressed_to_you.new_comments.map((c) => c.said), ['Hold it for a day?']);
  assert.deepEqual(r.you_hold.map((h) => [h.item, h.behaviours]), [['issue-11', ['CL-01']]]);
  assert.ok(r.ready_next.length && !r.ready_next.some((w) => w.behaviours.includes('CL-01')), 'what is ready leaves out what is held');
  assert.deepEqual([r.local_and_github.branch, r.local_and_github.ahead, r.local_and_github.behind, r.local_and_github.in_line], ['claims', 1, 2, false]);
  assert.equal(r.local_and_github.pull_requests[0].number, 7);
  assert.match(r.first_step, /^Pull first: 2 commits/);
  assert.ok(!(await a.use('standup')).addressed_to_you.answered, 'an answer is reported once');
});

test('CONN-04 the first standup on a machine onboards; the next one stays short', async () => {
  const { agent } = await setup();
  const a = await agent('Builder');
  const first = await a.use('standup');
  assert.equal(first.mode, 'onboarding');
  assert.equal(first.onboarding.project, 'App');
  assert.ok(first.onboarding.how_to_work.some((line) => /standup\(\)/.test(line)));
  assert.match(first.first_step, /Claim the next work: #11 Claims/);
  const next = await a.use('standup');
  assert.equal(next.mode, 'up_to_date');
  assert.ok(!next.onboarding && !next.while_you_were_away);
});

test('CONN-05 after a while away, or many changes by others, the standup regroups: what changed, where you left off, what ran out', async () => {
  const { agent, clock } = await setup();
  const a = await agent('Builder');
  const b = await agent('Reviewer');
  await a.use('standup');
  await a.use('claim', { behaviours: ['ZOOM-01'] });
  await a.use('standup');
  clock.now += 9 * 3_600_000;
  const back = await a.use('standup', { branch: 'zoom', uncommitted: ['web/zoom.js'] });
  assert.equal(back.mode, 'regroup');
  assert.equal(back.away, '9 hours');
  assert.deepEqual(back.claims_ran_out.map((c) => c.behaviour), ['ZOOM-01']);
  assert.ok(back.where_you_left_off.notes.some((n) => /ran out/.test(n.note)));
  assert.match(back.first_step, /claim on ZOOM-01 ran out/);

  clock.now += 10 * 60_000;
  for (let i = 0; i < 10; i++) await b.use('remember', { fact: `Fact ${i}` });
  const busy = await a.use('standup');
  assert.equal(busy.mode, 'regroup', 'ten changes by others regroup even after a short break');
  assert.equal(busy.while_you_were_away.changes, 10);
  assert.ok(busy.while_you_were_away.by_other_agents.every((x) => x.by.startsWith('Reviewer')));
  assert.equal((await a.use('standup')).mode, 'up_to_date');
});

test('CONN-08 after the standup the agent builds unassisted: blockers go to ask() on the item, never a wait in its own window', async () => {
  const { agent } = await setup();
  const a = await agent('Builder');
  const prompt = (await a.rpc('prompts/get', { name: 'standup' })).result.messages[0].content.text;
  assert.doesNotMatch(prompt, /wait for me/i);
  assert.match(prompt, /without waiting/);
  assert.match(prompt, /ask\(\)/);
  assert.match(prompt, /handoff\(\)/);
  const { how_to_work } = await a.use('prime');
  assert.ok(how_to_work.some((line) => /without waiting/.test(line) && /ask\(/.test(line)), 'how work goes here says so too');
});

test('STATE-09 only leaf issues are offered as work; a parent with behaviours of its own needs them moved into a child', async () => {
  const { rest, agent } = await setup();
  const leafy = (await rest('POST', '/api/import/json', {
    nodes: [
      { id: 'root', title: 'App', kind: 'project' },
      { id: 'web', parentId: 'root', title: 'Web', kind: 'area' },
      issue(20, 'Parent', { body: body({ behaviours: ['PA-01 Given a parent, when big, then split.'] }) }),
      issue(21, 'Child', { parentId: 'i20', body: body({ behaviours: ['CH-01 Given a child, when small, then built.'] }) }),
    ],
  })).project.id;
  const a = await agent('Builder', leafy);
  const next = await a.use('next_work');
  assert.deepEqual(next.work.map((w) => w.item), ['issue-21'], 'the child is the work, not its parent');
  assert.deepEqual(next.need_a_split, ['issue-20']);
  assert.match((await a.use('context', { issue: 'issue-20' })).needs_split.reason, /child/);
  assert.match((await a.refused('claim', { behaviours: ['PA-01'] })).error, /needs a split/);
});

test('STATE-10 STATE-12 an issue partly built needs a split; one tested throughout is to verify, not done; neither is offered to build', async () => {
  const { rest, agent, shop } = await setup();
  const ready = { labels: [{ name: 'status:ready' }] };
  shop.issues.push(
    shop.issue(30, 'Half built', body({ behaviours: ['HB-01 Given one, when built, then tested.', 'HB-02 Given two, when not, then not.'] }), ready),
    shop.issue(31, 'All built', body({ behaviours: ['AB-01 Given all, when built, then tested.'] }), ready),
    shop.issue(32, 'Not started', body({ behaviours: ['NS-01 Given none, when started, then work.'] }), ready),
  );
  shop.tree.push({ path: 'test/app.test.mjs', type: 'blob' });
  shop.docs['test/app.test.mjs'] = "test('HB-01 one is built', () => {});\ntest('AB-01 all are built', () => {});\n";
  const pid = (await rest('POST', '/api/import/github', { repo: 'octo/shop' })).project.id;
  const a = await agent('Builder', pid);
  const next = await a.use('next_work');
  assert.ok(next.work.some((w) => w.item === 'issue-32'), 'untested work is still offered');
  assert.ok(!next.work.some((w) => ['issue-30', 'issue-31'].includes(w.item)), 'partly or wholly tested work is not');
  const s = await a.use('standup');
  const half = s.needs_split.find((x) => x.item === 'issue-30');
  assert.deepEqual(half.looks_built, ['HB-01']);
  assert.ok(!s.needs_split.some((x) => x.item === 'issue-31'), 'tested throughout is not a split');
  assert.deepEqual(s.to_verify.find((x) => x.item === 'issue-31').behaviours, ['AB-01']);
  assert.deepEqual(next.to_verify, ['issue-31']);
  assert.deepEqual((await a.use('context', { issue: '30' })).needs_split.still_to_build, ['HB-02']);
});
