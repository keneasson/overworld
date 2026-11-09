// Sync with a project's store (#3): only a save reaches the store; saved items arrive in order and once,
// within a write budget; conflicts go back to a person, and the map keeps up with the store.
//
// Every behaviour runs against GitHub (the fake shop, behind a stand-in for the App client) and, under
// SYNC-14, against a store kept in memory, so it holds for any store behind the store API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../app.mjs';
import { createModel } from '../model/index.mjs';
import { createSync } from '../sync.mjs';
import { createStores } from '../stores/index.mjs';
import { PermanentError, TransientError } from '../stores/errors.mjs';
import { fakeShop } from './fake-github.mjs';
import { memoryStore } from './memory-store.mjs';

const SECRET = 'webhook-secret';
const REPO = 'octo/shop';
const note = /\n\n---\n📍[^\n]*$/;
const START = Date.parse('2026-11-09T12:00:00Z');

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

const signed = (event, payload) => ({
  'x-github-event': event,
  'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(JSON.stringify(payload)).digest('hex')}`,
});
const STATUS_OF_LABEL = { 'status:draft': 'idea', 'status:needs-decision': 'needs_decision', 'status:ready': 'ready', 'status:in-progress': 'in_progress' };

/** What a test needs from either store: items are named by number (3 is the coupon bug in both). */
async function harness(kind, { strict = false, budget } = {}) {
  let now = START;
  const clock = () => now;
  const model = await createModel({ DATA_FILE: join(await mkdtemp(join(tmpdir(), 'overworld-')), 'db.json') });
  const booked = [];
  const syncWith = (stores) => createSync({ model, stores, clock: () => new Date(now), schedule: async (pid, at) => booked.push(at), log: {}, ...(budget ? { budget } : {}) });
  let h;

  if (kind === 'github') {
    const shop = fakeShop();
    if (strict) for (const i of shop.issues.filter((x) => x.state === 'open' && !x.pull_request)) i.labels.push({ name: 'status:ready' });
    const app = fakeApp(shop, clock);
    const stores = createStores({ githubApp: app, fetchImpl: shop.fetch });
    const sync = syncWith(stores);
    const api = createApi({ model, accessKey: 'k', fetchImpl: shop.fetch, sync, stores, webhookSecret: async () => SECRET, log: { error() {} } });
    const call = (method, path, body, headers = { 'x-projectmap-key': 'k' }) => api({ method, path, body, headers, rawBody: body == null ? null : JSON.stringify(body) });
    const { project } = (await call('POST', '/api/import/github', { repo: REPO })).body;
    const gh = (n) => shop.issues.find((i) => i.number === n);
    const deliver = (event, payload) => call('POST', '/api/github/webhook', payload, signed(event, payload));
    const read = (i) => ({
      number: i.number,
      title: i.title,
      markdown: i.body,
      status: i.state === 'closed' ? (i.state_reason === 'not_planned' ? 'rejected' : 'done') : (i.labels.map((l) => STATUS_OF_LABEL[l.name]).find(Boolean) ?? 'open'),
      epic: i.labels.some((l) => l.name === 'epic'),
      guarded: i.body.includes('overworld-new-item'),
      labels: i.labels.map((l) => l.name),
    });
    h = {
      github: { shop, call, deliver },
      app,
      sync,
      call,
      pid: project.id,
      nodeId: (n) => `issue-${n}`,
      key: (n) => `issue-${n}`,
      ref: (n) => String(n),
      mention: (it) => `#${it.number}`,
      stored: (n) => read(gh(n)),
      storedTitled: (title) => shop.issues.filter((i) => i.title === title).map(read),
      editInStore: (n, { title, markdown }) => Object.assign(gh(n), title ? { title } : {}, markdown != null ? { body: markdown } : {}),
      notify: (n) => deliver('issues', { action: 'edited', issue: structuredClone(gh(n)), repository: { full_name: REPO } }),
      notifyStarted: (n) => deliver('pull_request', { action: 'opened', pull_request: { number: 99, state: 'open', title: 'Work', body: `Closes #${n}` }, repository: { full_name: REPO } }),
      add: (n, title, markdown) => shop.issues.push(shop.issue(n, title, markdown)),
    };
  } else {
    const shop = fakeShop();
    const seed = shop.issues
      .filter((i) => !i.pull_request)
      .map((i) => ({ ref: `M-${i.number}`, title: i.title, markdown: i.body, status: i.state === 'closed' ? (i.state_reason === 'not_planned' ? 'rejected' : 'done') : 'planned' }));
    const mem = memoryStore(seed, { clock });
    const stores = { forProject: (p) => (p?.store === 'memory' ? mem : null) };
    const sync = syncWith(stores);
    const api = createApi({ model, accessKey: 'k', sync, stores, log: { error() {} } });
    const call = (method, path, body, headers = { 'x-projectmap-key': 'k' }) => api({ method, path, body, headers });
    const pid = 'memory-project';
    const { nodes } = await mem.mapAgain();
    await model.nodes.put(pid, nodes);
    await model.projects.put({ id: pid, title: 'A project in memory', store: 'memory', nodeCount: nodes.length, createdAt: new Date(START).toISOString(), updatedAt: new Date(START).toISOString() });
    await model.links.link(mem.key, pid);
    const read = (it) => ({ ref: it.ref, title: it.title, markdown: it.markdown, status: it.status, epic: it.epic, guarded: Boolean(it.hidden) });
    h = {
      app: mem,
      sync,
      call,
      pid,
      nodeId: (n) => `mem-M-${n}`,
      key: (n) => `node-mem-M-${n}`,
      ref: (n) => `M-${n}`,
      mention: (it) => `[${it.ref}]`,
      stored: (n) => read(mem.items.get(`M-${n}`)),
      storedTitled: (title) => [...mem.items.values()].filter((i) => i.title === title).map(read),
      editInStore: (n, { title, markdown }) => Object.assign(mem.items.get(`M-${n}`), title ? { title } : {}, markdown != null ? { markdown } : {}),
      notify: (n) => sync.onEvents(mem.key, [{ type: 'changed', ref: `M-${n}`, item: structuredClone(mem.items.get(`M-${n}`)) }]),
      notifyStarted: (n) => sync.onEvents(mem.key, [{ type: 'started', ref: `M-${n}` }]),
      add: (n, title, markdown) => mem.items.set(`M-${n}`, { ref: `M-${n}`, title, markdown, status: 'planned', hidden: null, epic: false }),
    };
  }

  h.model = model;
  h.booked = booked;
  h.clock = clock;
  h.later = (minutes) => (now += minutes * 60_000);
  h.nodeOf = async (n) => (await h.call('GET', `/api/projects/${h.pid}`)).body.nodes.find((x) => x.id === h.nodeId(n));
  h.textOf = async (n) => (await h.nodeOf(n)).body.replace(note, '');
  /** Accept one changeset of edits: [[number, newText], …]. */
  h.accept = async (edits) => {
    const cs = (await h.call('POST', `/api/projects/${h.pid}/changesets`, {})).body.changeset;
    for (const [n, markdown] of edits) {
      const node = await h.nodeOf(n);
      await h.call('PUT', `/api/projects/${h.pid}/changesets/${cs.id}/items`, { key: h.key(n), title: node.title.replace(/^#\d+ /, ''), markdown });
    }
    const res = await h.call('POST', `/api/projects/${h.pid}/changesets/${cs.id}/accept`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.changeset;
  };
  h.save = async (keys) => {
    const res = await h.call('POST', `/api/projects/${h.pid}/save`, keys ? { keys } : {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.saved;
  };
  return h;
}

// Each behaviour once, for any store. `h.github` is set only for GitHub, for what only GitHub has (labels, signatures).
const behaviours = [
  [
    'SYNC-07 accepted edits stay in Overworld, through a refresh, until a save',
    {},
    async (h) => {
      const before = h.stored(4).markdown;
      await h.accept([[4, 'Tokens, never card numbers.']]);
      assert.equal((await h.sync.drain(h.pid)).status, 'synced');
      assert.deepEqual(h.app.writes(), [], 'accepting writes nothing to the store');
      assert.equal(h.stored(4).markdown, before);

      await h.call('POST', `/api/projects/${h.pid}/refresh`, {});
      assert.equal(await h.textOf(4), 'Tokens, never card numbers.', 'reading the store again keeps the work in progress');

      assert.deepEqual(await h.save(), [h.key(4)]);
      await h.sync.drain(h.pid);
      assert.deepEqual(h.app.writes(), ['update 4']);
      assert.equal(h.stored(4).markdown, 'Tokens, never card numbers.');
    },
  ],
  [
    "SYNC-08 a save writes each item as it is, with its state in the store's terms",
    { strict: true },
    async (h) => {
      await h.accept([[4, 'Tokens.\n\n## Open questions\n\n- Which vault?']]);
      await h.call('PATCH', `/api/projects/${h.pid}/nodes/${h.nodeId(5)}`, { status: 'done' });
      await h.call('PATCH', `/api/projects/${h.pid}/nodes/${h.nodeId(3)}`, { status: 'rejected' });
      await h.save();
      await h.sync.drain(h.pid);

      assert.equal(h.stored(4).status, 'needs_decision', 'an open question needs a decision');
      assert.deepEqual([h.stored(5).status, h.stored(5).markdown], ['done', 'Hmm.'], 'done, its text untouched');
      assert.equal(h.stored(3).status, 'rejected');
      if (h.github) {
        assert.deepEqual(h.stored(4).labels, ['status:needs-decision'], 'on GitHub, a state is a status label');
        assert.deepEqual(h.stored(3).labels, ['bug', 'P1'], 'or closed as not planned; labels that are not states are kept');
      }
    },
  ],
  [
    'SYNC-09 several saves of one item before sync writes it become one write, of the latest',
    {},
    async (h) => {
      for (const text of ['One.', 'Two.', 'Three.']) {
        await h.accept([[4, text]]);
        await h.save();
        h.later(1);
      }
      await h.sync.drain(h.pid);
      assert.deepEqual(h.app.writes(), ['update 4']);
      assert.equal(h.stored(4).markdown, 'Three.');
    },
  ],
  [
    'SYNC-10 a burst of saves keeps to the write budget, spread out instead of refused',
    { budget: { perMinute: 2, perHour: 3 } },
    async (h) => {
      await h.accept([2, 3, 4, 5].map((n) => [n, `Edit ${n}.`]));
      await h.save();

      const first = await h.sync.drain(h.pid);
      assert.deepEqual([first.status, h.app.writes().length], ['waiting', 2], 'two a minute');
      assert.equal(h.booked.at(-1), new Date(h.clock() + 60_000).toISOString(), 'and it books the next minute itself');
      h.later(1);
      assert.deepEqual([(await h.sync.drain(h.pid)).status, h.app.writes().length], ['waiting', 3], 'three an hour');
      h.later(59);
      assert.deepEqual([(await h.sync.drain(h.pid)).status, h.app.writes().length], ['synced', 4]);
      assert.deepEqual([2, 3, 4, 5].map((n) => h.stored(n).markdown), ['Edit 2.', 'Edit 3.', 'Edit 4.', 'Edit 5.']);
      const times = h.app.writeTimes;
      assert.ok(Math.max(...times.map((t) => times.filter((u) => u >= t && u < t + 60_000).length)) <= 2, 'never more than the budget in any minute');
    },
  ],
  [
    'SYNC-02 saved edits reach the store in order, once each, through outages and rate limits',
    {},
    async (h) => {
      await h.accept([[4, 'Tokens, never card numbers.']]);
      await h.save();
      h.later(1);
      await h.accept([[3, 'Rejects valid codes.']]);
      await h.save();

      h.app.failNext.push(new TransientError('store unreachable'));
      assert.equal((await h.sync.drain(h.pid)).status, 'retrying', 'the store down');
      assert.equal(h.booked.length, 1, 'it books its own retry');
      assert.equal((await h.sync.drain(h.pid)).status, 'waiting', 'and waits for it');
      assert.equal(h.app.writes().length, 0);

      h.later(2);
      const reset = new Date(h.clock() + 3_600_000).toISOString();
      h.app.failNext.push(undefined, undefined, new TransientError('rate limited', reset));
      assert.equal((await h.sync.drain(h.pid)).status, 'retrying', 'rate-limited part-way through');
      assert.ok(h.booked.at(-1) >= reset, 'not before the rate limit resets');

      h.later(61);
      assert.equal((await h.sync.drain(h.pid)).status, 'synced');
      assert.deepEqual(h.app.writes(), ['update 4', 'update 3'], 'in the order saved, and each once');
      assert.deepEqual([h.stored(4).markdown, h.stored(3).markdown], ['Tokens, never card numbers.', 'Rejects valid codes.']);
      assert.equal((await h.nodeOf(4)).sync, undefined, 'and the map knows they are in the store');
      assert.equal((await h.sync.drain(h.pid)).status, 'synced');
      assert.equal(h.app.writes().length, 2, 'nothing left to send');
    },
  ],
  [
    'SYNC-02 a worker killed mid-sync finishes after a restart, writing nothing twice',
    {},
    async (h) => {
      await h.accept([
        [3, 'Three.'],
        [4, 'Four.'],
        [5, 'Five.'],
      ]);
      await h.save();
      h.app.crashAfter('update'); // dies after 3 reaches the store, before it is written down
      await assert.rejects(h.sync.drain(h.pid), /worker killed/);
      // A killed worker never lets go of its lease: it runs out instead.
      await h.model.leases.claim(h.pid, 'dead worker', new Date(h.clock() + 120_000).toISOString(), new Date(h.clock()).toISOString());
      assert.equal((await h.sync.drain(h.pid)).status, 'busy', 'nobody else syncs while the lease holds');
      h.later(3);
      assert.equal((await h.sync.drain(h.pid)).status, 'synced');
      assert.deepEqual(h.app.writes(), ['update 3', 'update 4', 'update 5']);
      assert.deepEqual([3, 4, 5].map((n) => h.stored(n).markdown), ['Three.', 'Four.', 'Five.']);
      assert.deepEqual(await Promise.all([3, 4, 5].map(async (n) => (await h.nodeOf(n)).sync)), [undefined, undefined, undefined], 'what arrived before the crash is recognised, not taken for a conflict');
    },
  ],
  [
    'SYNC-06 an item changed in the store since it was last read is written nothing and goes back as a conflict, while the rest syncs',
    {},
    async (h) => {
      await h.accept([
        [3, 'Ours for three.'],
        [4, 'Ours for four.'],
      ]);
      await h.save();
      h.editInStore(4, { markdown: 'Theirs, edited in the store after the save.' });
      await h.sync.drain(h.pid);
      assert.deepEqual(h.app.writes(), ['update 3'], 'only the item the store left alone');
      assert.equal(h.stored(4).markdown, 'Theirs, edited in the store after the save.', 'theirs is untouched');
      const four = await h.nodeOf(4);
      assert.equal(four.sync, 'conflict');
      assert.deepEqual([four.conflict.ours.markdown, four.conflict.theirs.markdown], ['Ours for four.', 'Theirs, edited in the store after the save.'], 'both versions, for a person to resolve');
      assert.equal(await h.textOf(4), 'Theirs, edited in the store after the save.', 'the store is the record: the map shows theirs');
    },
  ],
  [
    'SYNC-03 an edit made in the store updates the map, and an open or unsaved edit of the same item becomes a conflict',
    {},
    async (h) => {
      const cs = (await h.call('POST', `/api/projects/${h.pid}/changesets`, {})).body.changeset;
      await h.call('PUT', `/api/projects/${h.pid}/changesets/${cs.id}/items`, { key: h.key(4), title: 'Card tokens', markdown: 'Ours.' });
      const theirs = 'Edited in the store.\n\n## Open questions\n\n- Which vault?';
      if (h.github) {
        const forged = { action: 'edited', issue: { ...h.github.shop.issues.find((i) => i.number === 4), body: theirs }, repository: { full_name: REPO } };
        assert.equal((await h.call('POST', '/api/github/webhook', forged, { 'x-github-event': 'issues', 'x-hub-signature-256': 'sha256=forged' })).status, 401);
        assert.notEqual(await h.textOf(4), theirs, 'a forged delivery changes nothing');
      }

      h.editInStore(4, { markdown: theirs });
      await h.notify(4);
      assert.equal(await h.textOf(4), theirs);
      assert.equal((await h.nodeOf(4)).status, 'needs_decision', 'its open question puts it in the Fog');
      if (h.github) assert.match((await h.nodeOf(4)).body, /\n\n---\n📍 /, 'it keeps its place and the reason for it');
      const [open] = (await h.call('GET', `/api/projects/${h.pid}/changesets`)).body.changesets;
      assert.deepEqual([open.items[0].conflict, open.items[0].theirs.markdown], [true, theirs]);
      assert.equal((await h.call('POST', `/api/projects/${h.pid}/changesets/${cs.id}/accept`)).status, 409, 'nothing is written until a person resolves it');

      await h.accept([[3, 'Ours, not saved yet.']]);
      h.editInStore(3, { markdown: 'Theirs.' });
      await h.notify(3);
      const three = await h.nodeOf(3);
      assert.deepEqual([three.sync, three.conflict.ours.markdown, await h.textOf(3)], ['conflict', 'Ours, not saved yet.', 'Theirs.']);

      await h.notifyStarted(5);
      assert.equal((await h.nodeOf(5)).status, 'in_progress', 'work started on it in the store puts it in progress');

      if (h.github) {
        const elsewhere = { action: 'edited', issue: h.github.shop.issues.find((i) => i.number === 4), repository: { full_name: 'someone/else' } };
        assert.deepEqual((await h.github.deliver('issues', elsewhere)).body, { handled: true, touched: [] }, "another repository's issues touch nothing here");
      }
    },
  ],
  [
    'SYNC-04 the nightly reconciliation brings the map back in line with the store, and reports what it fixed',
    {},
    async (h) => {
      // Drift no event told us about, and a save stuck waiting for a retry.
      h.editInStore(3, { title: 'Coupon field rejects valid codes' });
      h.add(7, 'Cart badge shows the wrong count', 'On /cart the badge lags.');
      await h.accept([[5, 'Think about the vibe, properly.']]);
      await h.save();
      h.app.failNext.push(new TransientError('store unreachable'));
      await h.sync.drain(h.pid);
      h.later(1);

      const [report] = await h.sync.reconcile();
      assert.deepEqual([report.added, report.changed, report.removed], [[h.ref(7)], [h.ref(3)], []]);
      assert.equal(report.sync, 'synced', 'the stuck save went too');
      assert.match((await h.nodeOf(3)).title, /Coupon field rejects valid codes$/);
      assert.ok(await h.nodeOf(7));
      assert.equal(h.stored(5).markdown, 'Think about the vibe, properly.');
      const { reports } = (await h.call('GET', `/api/projects/${h.pid}/sync`)).body;
      assert.deepEqual(reports[0].added, [h.ref(7)], 'the report is kept with the project');

      const [again] = await h.sync.reconcile();
      assert.deepEqual([again.added, again.changed, again.removed], [[], [], []], 'once they agree, there is nothing to fix');
    },
  ],
  [
    'NEW-04 new items reach the store with their state, and references between items point at the real ones',
    { strict: true },
    async (h) => {
      await h.model.nodes.put(h.pid, [
        { id: 'refunds', parentId: 'root', kind: 'area', title: 'Epic: Refunds', body: 'Kind: Epic · Place: checkout\n\n## Why\n\nMoney back.', status: 'idea', tags: [], sync: 'unsaved' },
        { id: 'to-card', parentId: 'refunds', kind: 'task', title: 'Refund to the saved card', body: 'Part of #new-refunds\nKind: Task · Place: checkout\n\n## Why\n\nFastest.', status: 'idea', tags: [], sync: 'unsaved' },
      ]);
      await h.accept([[4, 'Tokens also refund: see #new-to-card.']]);
      assert.equal((await h.save()).length, 3);

      h.app.crashAfter('create'); // the first item reaches the store, and the worker dies before it writes that down
      await assert.rejects(h.sync.drain(h.pid), /worker killed/);
      assert.equal((await h.sync.drain(h.pid)).status, 'synced');

      const [a, ...more] = h.storedTitled('Epic: Refunds');
      const [b] = h.storedTitled('Refund to the saved card');
      assert.equal(more.length, 0, 'the crash made no duplicate');
      assert.deepEqual([a.status, a.epic, b.status, b.epic], ['idea', true, 'idea', false]);
      assert.ok(b.markdown.startsWith(`Part of ${h.mention(a)}\n`));
      assert.equal(h.stored(4).markdown, `Tokens also refund: see ${h.mention(b)}.`);
      assert.ok(!a.guarded && !b.guarded, 'the guard against duplicates is gone');
      assert.equal(h.app.writes().filter((w) => w === 'create').length, 2);
      if (h.github) assert.deepEqual(a.labels, ['status:draft', 'epic'], 'on GitHub, the state and the epic are labels');
    },
  ],
];

for (const [name, options, run] of behaviours) test(name, async () => run(await harness('github', options)));

test('SYNC-14 every sync behaviour holds for any store behind the store API', async (t) => {
  for (const [name, options, run] of behaviours) await t.test(name, async () => run(await harness('memory', options)));
});
