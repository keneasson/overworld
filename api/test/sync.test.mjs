// Sync with GitHub (#3): only a save reaches GitHub; saved items arrive in order and once, within a write
// budget; conflicts go back to a person, and the map keeps up with GitHub. GitHub here is the fake shop,
// behind a stand-in for the App client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../app.mjs';
import { createModel } from '../model/index.mjs';
import { createSync } from '../sync.mjs';
import { PermanentError, TransientError } from '../github-app.mjs';
import { fakeShop } from './fake-github.mjs';

const SECRET = 'webhook-secret';
const REPO = 'octo/shop';
const note = /\n\n---\n📍[^\n]*$/;

/** The App client, on the fake shop's issues. `failNext` queues failures; `crashAfter` dies right after a write lands. */
function fakeApp(shop, clock) {
  const calls = [];
  const writeTimes = [];
  const failNext = [];
  let crashAfter = null;
  const find = (n) => shop.issues.find((i) => i.number === n);
  const step = (kind, n) => {
    const e = failNext.shift();
    if (e) throw e;
    calls.push(`${kind} ${n ?? ''}`.trim());
    if (kind === 'update' || kind === 'create') writeTimes.push(clock());
  };
  const crash = (kind) => {
    if (crashAfter === kind) {
      crashAfter = null;
      throw new Error('worker killed');
    }
  };
  return {
    calls,
    failNext,
    writeTimes,
    crashAfter: (kind) => (crashAfter = kind),
    writes: () => calls.filter((c) => /^(update|create)/.test(c)),
    async token() {
      return undefined;
    },
    async getIssue(repo, n) {
      step('get', n);
      if (!find(n)) throw new PermanentError('GitHub 404');
      return structuredClone(find(n));
    },
    async updateIssue(repo, n, { labels, ...patch }) {
      step('update', n);
      Object.assign(find(n), patch, labels ? { labels: labels.map((name) => ({ name })) } : {});
      crash('update');
    },
    async createIssue(repo, { title, body, labels }) {
      step('create');
      const number = Math.max(...shop.issues.map((i) => i.number)) + 1;
      shop.issues.push(shop.issue(number, title, body, { labels: labels.map((name) => ({ name })) }));
      crash('create');
      return { number };
    },
    async findCreated(repo, marker) {
      step('find');
      return shop.issues.find((i) => i.body.includes(marker)) ?? null;
    },
  };
}

/** @param {{ strict?: boolean, budget?: object }} [o] strict: the shop's open issues carry status: labels, so states are written as labels */
async function setup({ strict = false, budget } = {}) {
  const shop = fakeShop();
  if (strict) for (const i of shop.issues.filter((x) => x.state === 'open' && !x.pull_request)) i.labels.push({ name: 'status:ready' });
  let now = Date.parse('2026-11-09T12:00:00Z');
  const app = fakeApp(shop, () => now);
  const model = await createModel({ DATA_FILE: join(await mkdtemp(join(tmpdir(), 'overworld-')), 'db.json') });
  const booked = [];
  const sync = createSync({ model, github: app, fetchImpl: shop.fetch, clock: () => new Date(now), schedule: async (pid, at) => booked.push(at), log: {}, ...(budget ? { budget } : {}) });
  const api = createApi({ model, accessKey: 'k', fetchImpl: shop.fetch, sync, webhookSecret: async () => SECRET, log: { error() {} } });
  const call = (method, path, body, headers = { 'x-projectmap-key': 'k' }) => api({ method, path, body, headers, rawBody: body == null ? null : JSON.stringify(body) });
  const { project } = (await call('POST', '/api/import/github', { repo: REPO })).body;
  const pid = project.id;
  const nodeOf = async (n) => (await call('GET', `/api/projects/${pid}`)).body.nodes.find((x) => x.id === `issue-${n}`);
  const textOf = async (n) => (await nodeOf(n)).body.replace(note, '');
  const gh = (n) => shop.issues.find((i) => i.number === n);
  /** Accept one changeset of edits: [[number, newBody], …]. */
  async function accept(edits) {
    const cs = (await call('POST', `/api/projects/${pid}/changesets`, {})).body.changeset;
    for (const [n, markdown, title] of edits) {
      const node = await nodeOf(n);
      await call('PUT', `/api/projects/${pid}/changesets/${cs.id}/items`, { key: `issue-${n}`, title: title ?? node.title.replace(/^#\d+ /, ''), markdown });
    }
    const res = await call('POST', `/api/projects/${pid}/changesets/${cs.id}/accept`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.changeset;
  }
  const save = async (keys) => {
    const res = await call('POST', `/api/projects/${pid}/save`, keys ? { keys } : {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.saved;
  };
  const later = (minutes) => (now += minutes * 60_000);
  return { shop, gh, app, model, sync, call, pid, nodeOf, textOf, accept, save, booked, later, clock: () => now };
}

const signed = (event, payload) => ({
  'x-github-event': event,
  'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(JSON.stringify(payload)).digest('hex')}`,
});

test('SYNC-07 accepted edits stay in Overworld, through a refresh, until a save', async () => {
  const { gh, app, sync, call, pid, accept, save, textOf } = await setup();
  await accept([[4, 'Tokens, never card numbers.']]);
  assert.equal((await sync.drain(pid)).status, 'synced');
  assert.deepEqual(app.writes(), [], 'accepting writes nothing to GitHub');
  assert.equal(gh(4).body, 'Part of #1. See `apps/web/app/api/payments/route.ts`.');

  await call('POST', `/api/projects/${pid}/refresh`, {});
  assert.equal(await textOf(4), 'Tokens, never card numbers.', 'a refresh from GitHub keeps the work in progress');

  assert.deepEqual(await save(), ['issue-4']);
  await sync.drain(pid);
  assert.deepEqual(app.writes(), ['update 4']);
  assert.equal(gh(4).body, 'Tokens, never card numbers.');
});

test('SYNC-08 a save writes each item as it is, with its state as GitHub labels and open or closed', async () => {
  const { gh, call, sync, pid, accept, save } = await setup({ strict: true });
  await accept([[4, 'Tokens.\n\n## Open questions\n\n- Which vault?']]);
  await call('PATCH', `/api/projects/${pid}/nodes/issue-5`, { status: 'done' });
  await call('PATCH', `/api/projects/${pid}/nodes/issue-3`, { status: 'rejected' });
  await save();
  await sync.drain(pid);

  assert.deepEqual([gh(4).state, gh(4).labels.map((l) => l.name)], ['open', ['status:needs-decision']], 'an open question needs a decision');
  assert.deepEqual([gh(5).state, gh(5).state_reason, gh(5).body], ['closed', 'completed', 'Hmm.'], 'done is closed as completed, its text untouched');
  assert.deepEqual([gh(3).state, gh(3).state_reason], ['closed', 'not_planned'], 'rejected is closed as not planned');
  assert.deepEqual(gh(3).labels.map((l) => l.name), ['bug', 'P1'], 'labels that are not states are kept');
});

test('SYNC-09 several saves of one item before sync writes it become one write, of the latest', async () => {
  const { gh, app, sync, pid, accept, save, later } = await setup();
  for (const text of ['One.', 'Two.', 'Three.']) {
    await accept([[4, text]]);
    await save();
    later(1);
  }
  await sync.drain(pid);
  assert.deepEqual(app.writes(), ['update 4']);
  assert.equal(gh(4).body, 'Three.');
});

test('SYNC-10 a burst of saves keeps to the write budget, spread out instead of refused', async () => {
  const { gh, app, sync, pid, accept, save, later, booked, clock } = await setup({ budget: { perMinute: 2, perHour: 3 } });
  await accept([2, 3, 4, 5].map((n) => [n, `Edit ${n}.`]));
  await save();

  const first = await sync.drain(pid);
  assert.deepEqual([first.status, app.writes().length], ['waiting', 2], 'two a minute');
  assert.equal(booked.at(-1), new Date(clock() + 60_000).toISOString(), 'and it books the next minute itself');
  later(1);
  assert.deepEqual([(await sync.drain(pid)).status, app.writes().length], ['waiting', 3], 'three an hour');
  later(59);
  assert.deepEqual([(await sync.drain(pid)).status, app.writes().length], ['synced', 4]);
  assert.deepEqual([2, 3, 4, 5].map((n) => gh(n).body), ['Edit 2.', 'Edit 3.', 'Edit 4.', 'Edit 5.']);
  const inAnyMinute = Math.max(...app.writeTimes.map((t) => app.writeTimes.filter((u) => u >= t && u < t + 60_000).length));
  assert.ok(inAnyMinute <= 2, 'never more than the budget in any minute');
});

test('SYNC-02 saved edits reach GitHub in order, once each, through outages and rate limits', async () => {
  const { gh, app, sync, pid, accept, save, booked, later, clock, nodeOf } = await setup();
  await accept([[4, 'Tokens, never card numbers.']]);
  await save();
  later(1);
  await accept([[3, 'Rejects valid codes.']]);
  await save();

  app.failNext.push(new TransientError('GitHub 502'));
  assert.equal((await sync.drain(pid)).status, 'retrying', 'GitHub down');
  assert.equal(booked.length, 1, 'it books its own retry');
  assert.equal((await sync.drain(pid)).status, 'waiting', 'and waits for it');
  assert.equal(app.writes().length, 0);

  later(2);
  const reset = new Date(clock() + 3_600_000).toISOString();
  app.failNext.push(undefined, undefined, new TransientError('rate limited', reset));
  assert.equal((await sync.drain(pid)).status, 'retrying', 'rate-limited part-way through');
  assert.ok(booked.at(-1) >= reset, 'not before the rate limit resets');

  later(61);
  assert.equal((await sync.drain(pid)).status, 'synced');
  assert.deepEqual(app.writes(), ['update 4', 'update 3'], 'in the order saved, and each once');
  assert.deepEqual([gh(4).body, gh(3).body], ['Tokens, never card numbers.', 'Rejects valid codes.']);
  assert.equal((await nodeOf(4)).sync, undefined, 'and the map knows they are on GitHub');
  assert.equal((await sync.drain(pid)).status, 'synced');
  assert.equal(app.writes().length, 2, 'nothing left to send');
});

test('SYNC-02 a worker killed mid-sync finishes after a restart, writing nothing twice', async () => {
  const { gh, app, model, sync, pid, accept, save, later, clock, nodeOf } = await setup();
  await accept([
    [3, 'Three.'],
    [4, 'Four.'],
    [5, 'Five.'],
  ]);
  await save();
  app.crashAfter('update'); // dies after #3 reaches GitHub, before it is written down
  await assert.rejects(sync.drain(pid), /worker killed/);
  // A killed worker never lets go of its lease: it runs out instead.
  await model.leases.claim(pid, 'dead worker', new Date(clock() + 120_000).toISOString(), new Date(clock()).toISOString());
  assert.equal((await sync.drain(pid)).status, 'busy', 'nobody else syncs while the lease holds');
  later(3);
  assert.equal((await sync.drain(pid)).status, 'synced');
  assert.deepEqual(app.writes(), ['update 3', 'update 4', 'update 5']);
  assert.deepEqual([3, 4, 5].map((n) => gh(n).body), ['Three.', 'Four.', 'Five.']);
  assert.deepEqual(await Promise.all([3, 4, 5].map(async (n) => (await nodeOf(n)).sync)), [undefined, undefined, undefined], 'what arrived before the crash is recognised, not taken for a conflict');
});

test('SYNC-06 an item changed on GitHub since it was last read is written nothing and goes back as a conflict, while the rest syncs', async () => {
  const { gh, app, sync, pid, accept, save, nodeOf, textOf } = await setup();
  await accept([
    [3, 'Ours for three.'],
    [4, 'Ours for four.'],
  ]);
  await save();
  gh(4).body = 'Theirs, edited on GitHub after the save.';
  await sync.drain(pid);
  assert.deepEqual(app.writes(), ['update 3'], 'only the item that GitHub left alone');
  assert.equal(gh(4).body, 'Theirs, edited on GitHub after the save.', 'theirs is untouched');
  const four = await nodeOf(4);
  assert.equal(four.sync, 'conflict');
  assert.deepEqual([four.conflict.ours.markdown, four.conflict.theirs.markdown], ['Ours for four.', 'Theirs, edited on GitHub after the save.'], 'both versions, for a person to resolve');
  assert.equal(await textOf(4), 'Theirs, edited on GitHub after the save.', 'GitHub is the store: the map shows theirs');
});

test('SYNC-03 a signed webhook updates the map, and an open or unsaved edit of the same item becomes a conflict', async () => {
  const { gh, call, pid, nodeOf, textOf, accept } = await setup();
  const cs = (await call('POST', `/api/projects/${pid}/changesets`, {})).body.changeset;
  await call('PUT', `/api/projects/${pid}/changesets/${cs.id}/items`, { key: 'issue-4', title: 'Card tokens', markdown: 'Ours.' });
  const four = { ...gh(4), body: 'Edited on GitHub.\n\n## Open questions\n\n- Which vault?', labels: [{ name: 'status:ready' }] };
  const payload = { action: 'edited', issue: four, repository: { full_name: REPO } };

  assert.equal((await call('POST', '/api/github/webhook', payload, { 'x-github-event': 'issues', 'x-hub-signature-256': 'sha256=forged' })).status, 401);
  assert.equal(await textOf(4), gh(4).body, 'a forged delivery changes nothing');

  const res = await call('POST', '/api/github/webhook', payload, signed('issues', payload));
  assert.equal(res.status, 200);
  assert.equal(await textOf(4), four.body);
  assert.equal((await nodeOf(4)).status, 'needs_decision', 'its open question puts it in the Fog');
  assert.match((await nodeOf(4)).body, /\n\n---\n📍 /, 'it keeps its place and the reason for it');
  const [open] = (await call('GET', `/api/projects/${pid}/changesets`)).body.changesets;
  assert.deepEqual([open.items[0].conflict, open.items[0].theirs.markdown], [true, four.body]);
  assert.equal((await call('POST', `/api/projects/${pid}/changesets/${cs.id}/accept`)).status, 409, 'nothing is written until a person resolves it');

  await accept([[3, 'Ours, not saved yet.']]);
  const three = { ...gh(3), body: 'Theirs.' };
  const edited = { action: 'edited', issue: three, repository: { full_name: REPO } };
  await call('POST', '/api/github/webhook', edited, signed('issues', edited));
  assert.deepEqual([(await nodeOf(3)).sync, (await nodeOf(3)).conflict.ours.markdown, await textOf(3)], ['conflict', 'Ours, not saved yet.', 'Theirs.']);

  const pr = { action: 'opened', pull_request: { number: 12, state: 'open', title: 'Vault', body: 'Closes #4' }, repository: { full_name: REPO } };
  await call('POST', '/api/github/webhook', pr, signed('pull_request', pr));
  assert.equal((await nodeOf(4)).status, 'in_progress', 'a pull request that closes it puts it in progress');

  const elsewhere = { action: 'edited', issue: four, repository: { full_name: 'someone/else' } };
  assert.deepEqual((await call('POST', '/api/github/webhook', elsewhere, signed('issues', elsewhere))).body, { handled: true, touched: [] });
});

test('SYNC-04 the nightly reconciliation brings the map back in line with GitHub, and reports what it fixed', async () => {
  const { shop, gh, app, sync, call, pid, nodeOf, accept, save, later } = await setup();
  // Drift no webhook told us about, and a save stuck waiting for a retry.
  gh(3).title = 'Coupon field rejects valid codes';
  shop.issues.push(shop.issue(7, 'Cart badge shows the wrong count', 'On /cart the badge lags.'));
  await accept([[5, 'Think about the vibe, properly.']]);
  await save();
  app.failNext.push(new TransientError('GitHub 502'));
  await sync.drain(pid);
  later(1);

  const [report] = await sync.reconcile();
  assert.deepEqual([report.added, report.changed, report.removed], [[7], [3], []]);
  assert.equal(report.sync, 'synced', 'the stuck save went too');
  assert.equal((await nodeOf(3)).title, '#3 Coupon field rejects valid codes');
  assert.ok(await nodeOf(7));
  assert.equal(gh(5).body, 'Think about the vibe, properly.');
  const { reports } = (await call('GET', `/api/projects/${pid}/sync`)).body;
  assert.deepEqual(reports[0].added, [7], 'the report is kept with the project');

  const [again] = await sync.reconcile();
  assert.deepEqual([again.added, again.changed, again.removed], [[], [], []], 'once they agree, there is nothing to fix');
});

test('NEW-04 new items become GitHub issues with their labels, and references between items point at the real numbers', async () => {
  const { shop, gh, app, model, sync, pid, accept, save } = await setup({ strict: true });
  await model.nodes.put(pid, [
    { id: 'refunds', parentId: 'root', kind: 'area', title: 'Epic: Refunds', body: 'Kind: Epic · Place: checkout\n\n## Why\n\nMoney back.', status: 'idea', tags: [], sync: 'unsaved' },
    { id: 'to-card', parentId: 'refunds', kind: 'task', title: 'Refund to the saved card', body: 'Part of #new-refunds\nKind: Task · Place: checkout\n\n## Why\n\nFastest.', status: 'idea', tags: [], sync: 'unsaved' },
  ]);
  await accept([[4, 'Tokens also refund: see #new-to-card.']]);
  assert.equal((await save()).length, 3);

  app.crashAfter('create'); // the first issue reaches GitHub, and the worker dies before it writes its number down
  await assert.rejects(sync.drain(pid), /worker killed/);
  assert.equal((await sync.drain(pid)).status, 'synced');

  const made = shop.issues.filter((i) => i.title === 'Epic: Refunds' || i.title === 'Refund to the saved card');
  assert.equal(made.length, 2, 'the crash made no duplicate');
  const [a, b] = made;
  assert.deepEqual(a.labels.map((l) => l.name), ['status:draft', 'epic']);
  assert.deepEqual(b.labels.map((l) => l.name), ['status:draft']);
  assert.match(b.body, new RegExp(`^Part of #${a.number}\\n`));
  assert.equal(gh(4).body, `Tokens also refund: see #${b.number}.`);
  assert.ok(made.every((i) => !i.body.includes('overworld-new-item')), 'the marker that guards against duplicates is gone');
  assert.equal(app.writes().filter((w) => w === 'create').length, 2);
});
