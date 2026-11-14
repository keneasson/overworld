// The MCP server's behaviours (MCP-01 to MCP-10, MCP-12 to MCP-14, #4) and the standup (CONN-03 to CONN-05, #34), tested the way an agent uses it: JSON-RPC over HTTP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../app.mjs';
import { modelFor } from '../model/index.mjs';
import { fileTable } from '../model/table.mjs';
import { fakeShop } from './fake-github.mjs';

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
  return { api, rest, pid, agent, post, clock, file, shop };
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
  const { agent, rest, pid } = await setup();
  const a = await agent('Builder');
  await rest('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-10', anchor: { behaviour: 'ZOOM-01' }, text: 'Children in order?' });
  const old = (await rest('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-10', text: 'Settled long ago.' })).comment;
  await rest('PATCH', `/api/projects/${pid}/comments/issue-10/${old.id}`, { resolved: true });
  await a.use('claim', { behaviours: ['ZOOM-01'] });
  await a.use('handoff', { note: 'Children render; counts next.' });
  const c = await a.use('context', { issue: 'issue-10' });
  assert.deepEqual(c.parents.map((p) => p.title), ['App', 'Web']);
  assert.match(c.siblings.finished, /^1 finished: #14 Finished/);
  assert.ok(c.siblings.open.some((s) => s.key === 'issue-11'));
  assert.deepEqual(c.decisions, ['Decided by the maintainer: zoom is semantic.']);
  assert.deepEqual(c.behaviours.map((x) => [x.id, x.state]), [['ZOOM-01', 'new'], ['ZOOM-02', 'new'], ['ZOOM-03', 'not worked out yet']]);
  assert.deepEqual(c.discussion.open.map((d) => [d.on, d.said]), [['ZOOM-01', 'Children in order?']]);
  assert.equal(c.discussion.resolved, '1 resolved comments');
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
  const { agent, rest, pid } = await setup();
  const a = await agent('Builder');
  const asked = await a.use('ask', { place: 'issue-11', question: 'How long should a claim last?' });
  assert.deepEqual((await a.use('context', { issue: 'issue-11' })).open_questions, [`How long should a claim last? (Builder (${a.id}))`]);
  await rest('PATCH', `/api/projects/${pid}/comments/issue-11/${asked.question}`, { resolved: true });
  assert.deepEqual((await a.use('context', { issue: 'issue-11' })).open_questions, []);
});

test('MCP-06 refine and propose open and fill a refinement; an agent marks behaviours ready, and never adopts', async () => {
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
  assert.ok((await a.refused('propose', { refinement, item: 'issue-11', markdown: body({ behaviours: ['CL-01 x'], questions: 'How long?' }), ready_for_adoption: ['CL-01'] })).error, 'not ready while it has open questions');
  assert.ok(!(await a.rpc('tools/list')).result.tools.some((t) => /adopt|accept/.test(t.name)), 'no tool adopts');
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

test('CONN-03 the standup prompt asks the agent for its local state, and the standup tool reports it beside what is waiting', async () => {
  const { rest, pid, agent, clock } = await setup();
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
  await rest('PATCH', `/api/projects/${pid}/comments/issue-10/${question}`, { resolved: true });
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
