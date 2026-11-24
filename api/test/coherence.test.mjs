// The spec checks itself (#36): duplicate IDs and vocabulary drift (COHERE-01), close pairs across items from an injected
// embedder (COHERE-04), each naming its model (COHERE-07), judged pairs becoming open questions on both items (COHERE-05), and
// vectors kept with the project, so a check anywhere embeds only what changed (COHERE-08).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../app.mjs';
import { modelFor } from '../model/index.mjs';
import { fileTable } from '../model/table.mjs';
import { editableOf } from '../../shared/issue-shape.js';
import { embedBehaviours, nearPairs, packVector, unpackVector } from '../../shared/coherence.js';
import { runCheck } from '../../scripts/coherence-check.mjs';

const body = (behaviours) => `## Why\n\nBecause.\n\n## Behaviours\n\n${behaviours.map((b) => `- ${b}`).join('\n')}\n\n## Acceptance\n\nIt works.\n\n## Out of scope\n\nNothing.\n\n## Open questions\n\nNone.\n`;
const issue = (n, title, behaviours) => ({ id: `i${n}`, url: `https://github.com/octo/app/issues/${n}`, title: `#${n} ${title}`, kind: 'story', status: 'ready', parentId: 'root', body: body(behaviours) });
const PROJECT = {
  nodes: [
    { id: 'root', title: 'App', kind: 'project' },
    issue(5, 'Editor', ['EDIT-01 Given an item, when edited, then each section is its own field.', 'PAY-01 Given a cart, when paid, then the card is charged once and a receipt is sent.']),
    issue(41, 'One document', ['EDIT-01 Given an item, when edited, then it is one document.', 'PAY-02 Given a cart, when paid, then the card is charged once and a receipt is mailed.', 'NOTE-01 Given a comment, when made, then it is an annotation on the map.']),
    issue(7, 'Refinements', ['REF-01 Given a refinement, when adopted, then it changes the spec.', 'REF-02 As PAY-01 says, given a cart, when paid, then the card is charged once and a receipt is sent.']),
    issue(8, 'Changesets', ['CS-01 Given a changeset, when accepted, then it is saved.', 'SKY-01 Given a dark night, when zoomed out, then stars show.']),
  ],
};

/** A fake embedder: bag of words over a few hashed dimensions, normalised. Close words give close vectors, without a model. */
const fake = (model = 'fake-embedder', version = '1') => ({
  model,
  version,
  calls: 0,
  async embed(texts) {
    this.calls += texts.length;
    return texts.map((t) => {
      const v = new Array(32).fill(0);
      for (const w of t.toLowerCase().match(/[a-z]+/g) ?? []) v[[...w].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 32, 7)] += 1;
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });
  },
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'overworld-coherence-'));
  const api = createApi({ model: modelFor(fileTable(join(dir, 'table.json'))), accessKey: 'k', log: { error() {} } });
  const rest = async (method, path, b) => {
    const res = await api({ method, path, body: b, headers: { 'x-projectmap-key': 'k' } });
    return res.status >= 400 ? { error: res.body.error, status: res.status } : res.body;
  };
  const pid = (await rest('POST', '/api/import/json', PROJECT)).project.id;
  /** Run the check the way scripts/coherence.mjs does, and send its pairs. */
  const check = async (embedder, cache = new Map(), changed = null) => {
    const { behaviours } = await rest('GET', `/api/projects/${pid}/coherence/behaviours`);
    await embedBehaviours(behaviours, embedder, cache);
    const pairs = nearPairs({ behaviours, vectors: cache, changed, embedder });
    await rest('PUT', `/api/projects/${pid}/coherence/pairs`, { pairs });
    return pairs;
  };
  /** An agent's MCP client: a tool call returns its result, or fails the test. */
  const agent = async (name) => {
    const { token } = await rest('POST', `/api/projects/${pid}/agents`, { name });
    return async (tool, args = {}) => {
      const res = await api({ method: 'POST', path: '/api/mcp', body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }, headers: { authorization: `Bearer ${token}` } });
      assert.ok(!res.body.result.isError, `${tool}: ${res.body.result.content[0].text}`);
      return res.body.result.structuredContent;
    };
  };
  return { api, rest, pid, check, agent };
}

test('COHERE-01 the same behaviour ID in two items, and two words for one thing, are found without a model', async () => {
  const { rest, pid } = await setup();
  const found = await rest('GET', `/api/projects/${pid}/coherence`);
  assert.deepEqual(found.duplicate_ids.map((d) => [d.id, d.items.map((i) => i.item)]), [['EDIT-01', ['issue-41', 'issue-5']]]);
  const drift = Object.fromEntries(found.drift.map((d) => [d.keep, Object.fromEntries(d.terms.map((t) => [t.term, t.items]))]));
  assert.deepEqual(drift.refinement, { refinement: ['issue-7'], changeset: ['issue-8'] });
  assert.deepEqual(drift.comment, { comment: ['issue-41'], annotation: ['issue-41'] });
  assert.deepEqual(drift.adopt, { adopt: ['issue-7'], accept: ['issue-8'] });
  assert.equal(drift.desert, undefined, 'a family only one of whose words is used is not drift');
});

test('COHERE-04 COHERE-07 close pairs across items are found and kept with the model that found them; a cross-reference is not one', async () => {
  const { rest, pid, check } = await setup();
  const embedder = fake();
  const cache = new Map();
  const pairs = await check(embedder, cache);
  const names = pairs.map((p) => [p.a.id, p.b.id].sort().join('~'));
  assert.ok(names.includes('PAY-01~PAY-02'), 'the two charging behaviours in different items are close');
  assert.ok(!names.some((n) => n.includes('REF-02') && n.includes('PAY-01')), 'REF-02 cites PAY-01, so it is a cross-reference');
  assert.ok(!pairs.some((p) => p.a.item === p.b.item), 'only pairs across items');
  assert.ok(!names.some((n) => n.includes('SKY-01')), 'unrelated behaviours are not close');

  const both = (p) => [p.a.id, p.b.id].sort().join('~') === 'PAY-01~PAY-02';
  const shown = (await rest('GET', `/api/projects/${pid}/coherence`)).pairs.find(both);
  assert.equal(shown.model, 'fake-embedder');
  assert.equal(shown.version, '1');
  assert.match(shown.a.text, /charged once/);
  assert.deepEqual([shown.a.title, shown.b.title].sort(), ['#41 One document', '#5 Editor']);

  const again = await check(fake(), new Map());
  assert.deepEqual(again, pairs, 'the same spec and model find the same pairs');

  // A second run embeds only what changed, and compares only pairs with a changed behaviour in them.
  const before = embedder.calls;
  const { behaviours } = await rest('GET', `/api/projects/${pid}/coherence/behaviours`);
  await embedBehaviours(behaviours, embedder, cache);
  assert.equal(embedder.calls, before, 'nothing changed, so nothing is embedded again');
  assert.deepEqual(await check(embedder, cache, new Set()), [], 'nothing changed, so nothing is compared');
});

test('COHERE-05 a pair judged a contradiction becomes an open question on both items, each naming the other', async () => {
  const { rest, pid, check, agent } = await setup();
  await check(fake());
  const use = await agent('Judge');
  const listed = await use('coherence');
  const pair = listed.to_judge.find((p) => [p.a.id, p.b.id].sort().join('~') === 'PAY-01~PAY-02');
  assert.ok(pair, 'the pair is waiting to be judged, with both behaviours');
  assert.deepEqual([pair.a.item, pair.b.item].sort(), ['issue-41', 'issue-5']);
  assert.match(pair.a.text + pair.b.text, /mailed/);
  assert.deepEqual(listed.duplicate_ids.map((d) => d.id), ['EDIT-01']);

  const judged = await use('judge', { pair: pair.key, verdict: 'contradiction', note: 'sent or mailed?', request_key: 'j1' });
  assert.equal(judged.judged.asked.length, 2);
  const { nodes } = await rest('GET', `/api/projects/${pid}`);
  const md = (n) => editableOf(nodes.find((x) => x.title.startsWith(`#${n} `))).markdown;
  assert.match(md(5), /PAY-01 and PAY-02 in #41 One document look like a contradiction: sent or mailed\?/);
  assert.match(md(41), /PAY-02 and PAY-01 in #5 Editor look like a contradiction/);
  assert.ok(!(await use('coherence')).to_judge.some((p) => p.key === pair.key), 'a judged pair leaves the list');

  const other = (await use('coherence')).to_judge[0];
  if (other) {
    await use('judge', { pair: other.key, verdict: 'unrelated', request_key: 'j2' });
    const after = (await rest('GET', `/api/projects/${pid}`)).nodes;
    assert.equal(after.filter((n) => /look like a/.test(editableOf(n).markdown)).length, 2, 'unrelated asks nothing');
  }
});

test('COHERE-07 a kept vector reads back close enough to find the same pairs, in about 400 bytes', async () => {
  const embedder = fake();
  const texts = PROJECT.nodes.flatMap((n) => (n.body ? [...n.body.matchAll(/^- [A-Z]+-\d+ (.*)$/gm)].map((m) => m[1]) : []));
  const vectors = await embedder.embed(texts);
  const back = vectors.map((v) => unpackVector(packVector(v)));
  const dot = (a, b) => a.reduce((s, x, k) => s + x * b[k], 0);
  for (let i = 0; i < vectors.length; i++) for (let j = i + 1; j < vectors.length; j++) assert.ok(Math.abs(dot(vectors[i], vectors[j]) - dot(back[i], back[j])) < 0.01);
  const big = Array.from({ length: 384 }, (_, k) => Math.sin(k + 1) / 14);
  assert.equal(Buffer.from(packVector(big), 'base64').length, 388, 'bge-small\'s 384 dimensions keep in 388 bytes');
  assert.ok(Math.abs(dot(unpackVector(packVector(big)), big.map((x) => x / Math.hypot(...big))) - 1) < 1e-4);
});

test('COHERE-08 a check embeds only behaviours whose words or model changed since the project kept their vectors', async () => {
  const { api, rest, pid } = await setup();
  const { token } = await rest('POST', `/api/projects/${pid}/agents`, { name: 'CI' });
  // As CI calls it: with the agent token alone.
  const call = async (method, url, body) => {
    const [path, qs] = url.split('?');
    const res = await api({ method, path, query: Object.fromEntries(new URLSearchParams(qs ?? '')), body, headers: { authorization: `Bearer ${token}` } });
    assert.ok(res.status < 400, `${method} ${path}: ${res.body.error}`);
    return res.body;
  };
  const embedder = fake();
  let loads = 0;
  const check = (model = 'fake-embedder') => runCheck({ call, pid, model, loadEmbedder: async () => (loads++, { ...embedder, model }) });

  const first = await check();
  assert.equal(first.kept, first.behaviours, 'the first run embeds every behaviour');
  assert.ok(first.pairs.some((p) => [p.a.id, p.b.id].sort().join('~') === 'PAY-01~PAY-02'));
  assert.equal((await rest('GET', `/api/projects/${pid}/vectors`)).vectors.length, first.behaviours);

  const again = await check();
  assert.deepEqual([again.embedded, again.pairs.length, loads], [0, 0, 1], 'nothing changed, so the model never loads');

  const { nodes } = await rest('GET', `/api/projects/${pid}`);
  const editor = nodes.find((n) => n.title === '#5 Editor');
  await rest('PATCH', `/api/projects/${pid}/nodes/${editor.id}`, { body: body(['EDIT-01 Given an item, when edited, then each section is its own field.', 'PAY-01 Given a cart, when paid, then the card is charged twice.']) });
  const changed = await check();
  assert.deepEqual([changed.kept, changed.embedded], [1, 1], 'only the edited behaviour is embedded again');
  await rest('DELETE', `/api/projects/${pid}/nodes/${nodes.find((n) => n.title === '#8 Changesets').id}`);
  const gone = await check();
  assert.deepEqual([gone.kept, gone.removed], [0, 2], 'the deleted item\'s vectors go, and nothing is embedded');
  assert.equal((await rest('GET', `/api/projects/${pid}/vectors`)).vectors.length, gone.behaviours);

  const other = await check('another-model');
  assert.equal(other.kept, other.behaviours, 'a new model embeds everything again');
  assert.ok((await rest('GET', `/api/projects/${pid}/vectors`)).vectors.every((v) => v.model === 'another-model'));
});
