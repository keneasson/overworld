// Sync with GitHub (#3): accepted changesets reach GitHub in order and once, conflicts go back to a
// person, and the map keeps up with GitHub. GitHub here is the fake shop, behind a stand-in for the App client.
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
function fakeApp(shop) {
  const calls = [];
  const failNext = [];
  let crashAfter = null;
  const find = (n) => shop.issues.find((i) => i.number === n);
  const step = (kind, n) => {
    const e = failNext.shift();
    if (e) throw e;
    calls.push(`${kind} ${n ?? ''}`.trim());
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
    async updateIssue(repo, n, { title, body }) {
      step('update', n);
      Object.assign(find(n), { title, body });
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

async function setup() {
  const shop = fakeShop();
  const app = fakeApp(shop);
  const model = await createModel({ DATA_FILE: join(await mkdtemp(join(tmpdir(), 'overworld-')), 'db.json') });
  let now = Date.parse('2026-11-09T12:00:00Z');
  const booked = [];
  const sync = createSync({ model, github: app, fetchImpl: shop.fetch, clock: () => new Date(now), schedule: async (pid, at) => booked.push(at), log: {} });
  const api = createApi({ model, accessKey: 'k', fetchImpl: shop.fetch, sync, webhookSecret: async () => SECRET, log: { error() {} } });
  const call = (method, path, body, headers = { 'x-projectmap-key': 'k' }) => api({ method, path, body, headers, rawBody: body == null ? null : JSON.stringify(body) });
  const { project } = (await call('POST', '/api/import/github', { repo: REPO })).body;
  const pid = project.id;
  const nodeOf = async (n) => (await call('GET', `/api/projects/${pid}`)).body.nodes.find((x) => x.id === `issue-${n}`);
  const textOf = async (n) => (await nodeOf(n)).body.replace(note, '');
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
  const changeset = async (id) => (await call('GET', `/api/projects/${pid}/changesets`)).body.changesets.find((c) => c.id === id);
  const later = (minutes) => (now += minutes * 60_000);
  return { shop, app, model, sync, call, pid, nodeOf, textOf, accept, changeset, booked, later, clock: () => now };
}

const signed = (event, payload) => ({
  'x-github-event': event,
  'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(JSON.stringify(payload)).digest('hex')}`,
});

test('SYNC-02 accepted edits reach GitHub in order, once each, through outages and rate limits', async () => {
  const { shop, app, sync, pid, accept, changeset, booked, later, clock } = await setup();
  const first = await accept([[4, 'Tokens, never card numbers.']]);
  const second = await accept([
    [4, 'Tokens only, never card numbers.'],
    [3, 'Rejects valid codes.'],
  ]);
  assert.equal(first.sync, 'waiting');

  app.failNext.push(new TransientError('GitHub 502'));
  assert.equal((await sync.drain(pid)).status, 'retrying', 'GitHub down');
  assert.equal(booked.length, 1, 'it books its own retry');
  assert.equal((await sync.drain(pid)).status, 'waiting', 'and waits for it');
  assert.equal(app.writes().length, 0);

  later(2);
  const reset = new Date(clock() + 3_600_000).toISOString();
  app.failNext.push(undefined, new TransientError('rate limited', reset));
  assert.equal((await sync.drain(pid)).status, 'retrying', 'rate-limited part-way through');
  assert.ok(booked.at(-1) >= reset, 'not before the rate limit resets');

  later(61);
  assert.equal((await sync.drain(pid)).status, 'synced');
  assert.deepEqual(app.writes(), ['update 4', 'update 4', 'update 3'], 'in the order accepted, and each once');
  assert.equal(shop.issues.find((i) => i.number === 4).body, 'Tokens only, never card numbers.');
  assert.equal((await changeset(first.id)).sync, 'synced');
  assert.equal((await changeset(second.id)).sync, 'synced');
  assert.equal((await sync.drain(pid)).status, 'synced');
  assert.equal(app.writes().length, 3, 'nothing left to send');
});

test('SYNC-02 a worker killed mid-sync finishes after a restart, writing nothing twice', async () => {
  const { shop, app, model, sync, pid, accept, changeset, later, clock } = await setup();
  const cs = await accept([
    [3, 'Three.'],
    [4, 'Four.'],
    [5, 'Five.'],
  ]);
  app.crashAfter('update'); // dies after #3 reaches GitHub, before it is written down
  await assert.rejects(sync.drain(pid), /worker killed/);
  // A killed worker never lets go of its lease: it runs out instead.
  await model.leases.claim(pid, 'dead worker', new Date(clock() + 120_000).toISOString(), new Date(clock()).toISOString());
  assert.equal((await sync.drain(pid)).status, 'busy', 'nobody else syncs while the lease holds');
  later(3);
  assert.equal((await sync.drain(pid)).status, 'synced');
  assert.deepEqual(app.writes(), ['update 3', 'update 4', 'update 5']);
  assert.deepEqual(
    [3, 4, 5].map((n) => shop.issues.find((i) => i.number === n).body),
    ['Three.', 'Four.', 'Five.'],
  );
  assert.equal((await changeset(cs.id)).sync, 'synced');
});

test('SYNC-06 an item changed on GitHub since it was accepted is written nothing and goes back as a conflict, while the rest syncs', async () => {
  const { shop, app, sync, pid, accept, changeset, textOf } = await setup();
  const cs = await accept([
    [3, 'Ours for three.'],
    [4, 'Ours for four.'],
  ]);
  shop.issues.find((i) => i.number === 4).body = 'Theirs, edited on GitHub after the accept.';
  await sync.drain(pid);
  assert.deepEqual(app.writes(), ['update 3'], 'only the item that GitHub left alone');
  assert.equal(shop.issues.find((i) => i.number === 4).body, 'Theirs, edited on GitHub after the accept.', 'theirs is untouched');
  const after = await changeset(cs.id);
  assert.equal(after.sync, 'conflict');
  const four = after.items.find((it) => it.key === 'issue-4');
  assert.equal(four.conflict, true);
  assert.deepEqual([four.after.markdown, four.theirs.markdown], ['Ours for four.', 'Theirs, edited on GitHub after the accept.'], 'both versions, for a person to resolve');
  assert.equal(await textOf(4), 'Theirs, edited on GitHub after the accept.', 'GitHub is the store: the map shows theirs');
});

test('SYNC-03 a signed webhook updates the map, and an open edit of the same item becomes a conflict', async () => {
  const { shop, call, pid, nodeOf, textOf } = await setup();
  const cs = (await call('POST', `/api/projects/${pid}/changesets`, {})).body.changeset;
  await call('PUT', `/api/projects/${pid}/changesets/${cs.id}/items`, { key: 'issue-4', title: 'Card tokens', markdown: 'Ours.' });
  const four = { ...shop.issues.find((i) => i.number === 4), body: 'Edited on GitHub.\n\n## Open questions\n\n- Which vault?', labels: [{ name: 'status:ready' }] };
  const payload = { action: 'edited', issue: four, repository: { full_name: REPO } };

  assert.equal((await call('POST', '/api/github/webhook', payload, { 'x-github-event': 'issues', 'x-hub-signature-256': 'sha256=forged' })).status, 401);
  assert.equal(await textOf(4), shop.issues.find((i) => i.number === 4).body, 'a forged delivery changes nothing');

  const res = await call('POST', '/api/github/webhook', payload, signed('issues', payload));
  assert.equal(res.status, 200);
  assert.equal(await textOf(4), four.body);
  assert.equal((await nodeOf(4)).status, 'needs_decision', 'its open question puts it in the Fog');
  assert.match((await nodeOf(4)).body, /\n\n---\n📍 /, 'it keeps its place and the reason for it');
  const [open] = (await call('GET', `/api/projects/${pid}/changesets`)).body.changesets;
  assert.deepEqual([open.items[0].conflict, open.items[0].theirs.markdown], [true, four.body]);
  assert.equal((await call('POST', `/api/projects/${pid}/changesets/${cs.id}/accept`)).status, 409, 'nothing is written until a person resolves it');

  const pr = { action: 'opened', pull_request: { number: 12, state: 'open', title: 'Vault', body: 'Closes #4' }, repository: { full_name: REPO } };
  await call('POST', '/api/github/webhook', pr, signed('pull_request', pr));
  assert.equal((await nodeOf(4)).status, 'in_progress', 'a pull request that closes it puts it in progress');

  const elsewhere = { action: 'edited', issue: four, repository: { full_name: 'someone/else' } };
  assert.deepEqual((await call('POST', '/api/github/webhook', elsewhere, signed('issues', elsewhere))).body, { handled: true, touched: [] });
});

test('SYNC-04 the nightly reconciliation brings the map back in line with GitHub, and reports what it fixed', async () => {
  const { shop, app, sync, call, pid, nodeOf, accept, later } = await setup();
  // Drift no webhook told us about, and an edit stuck waiting for a retry.
  shop.issues.find((i) => i.number === 3).title = 'Coupon field rejects valid codes';
  shop.issues.push(shop.issue(7, 'Cart badge shows the wrong count', 'On /cart the badge lags.'));
  await accept([[5, 'Think about the vibe, properly.']]);
  app.failNext.push(new TransientError('GitHub 502'));
  await sync.drain(pid);
  later(1);

  const [report] = await sync.reconcile();
  assert.deepEqual([report.added, report.changed, report.removed], [[7], [3], []]);
  assert.equal(report.sync, 'synced', 'the stuck edit went too');
  assert.equal((await nodeOf(3)).title, '#3 Coupon field rejects valid codes');
  assert.ok(await nodeOf(7));
  assert.equal(shop.issues.find((i) => i.number === 5).body, 'Think about the vibe, properly.');
  const { reports } = (await call('GET', `/api/projects/${pid}/sync`)).body;
  assert.deepEqual(reports[0].added, [7], 'the report is kept with the project');

  const [again] = await sync.reconcile();
  assert.deepEqual([again.added, again.changed, again.removed], [[], [], []], 'once they agree, there is nothing to fix');
});

test('NEW-04 new items become GitHub issues with their labels, and references between items point at the real numbers', async () => {
  const { shop, app, model, sync, pid, nodeOf, changeset } = await setup();
  const four = await nodeOf(4);
  const cs = {
    id: 'cs-new',
    scopeId: 'root',
    status: 'accepted',
    sync: 'waiting',
    items: [
      { key: 'new-a', after: { title: 'Epic: Refunds', markdown: 'Kind: Epic · Place: checkout\n\n## Why\n\nMoney back.' } },
      { key: 'new-b', parentKey: 'new-a', after: { title: 'Refund to the saved card', markdown: 'Part of #new-a\nKind: Task · Place: checkout\n\n## Why\n\nFastest.' } },
      { key: 'issue-4', base: { title: 'Card tokens', markdown: four.body.replace(note, '') }, after: { title: 'Card tokens', markdown: 'Tokens also refund: see #new-b.' } },
    ],
    createdAt: '2026-11-09T11:00:00Z',
  };
  await model.jobs.accept(pid, cs, { id: 'job-1', changesetId: cs.id, repo: REPO, attempts: 0, createdAt: cs.createdAt });

  app.crashAfter('create'); // the first issue reaches GitHub, and the worker dies before it writes its number down
  await assert.rejects(sync.drain(pid), /worker killed/);
  assert.equal((await sync.drain(pid)).status, 'synced');

  const made = shop.issues.filter((i) => i.title.startsWith('Epic: Refunds') || i.title.startsWith('Refund to'));
  assert.equal(made.length, 2, 'the crash made no duplicate');
  const [a, b] = made;
  assert.deepEqual(a.labels.map((l) => l.name), ['status:draft', 'epic']);
  assert.deepEqual(b.labels.map((l) => l.name), ['status:draft']);
  assert.match(b.body, new RegExp(`^Part of #${a.number}\\n`));
  assert.equal(shop.issues.find((i) => i.number === 4).body, `Tokens also refund: see #${b.number}.`);
  assert.ok(made.every((i) => !i.body.includes('overworld-new-item')), 'the marker that guards against duplicates is gone');
  assert.deepEqual((await changeset('cs-new')).items.map((it) => it.number ?? it.key), [a.number, b.number, 'issue-4']);
  assert.equal(app.writes().filter((w) => w === 'create').length, 2);
});
