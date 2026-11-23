import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree } from '../src/model/tree.js';
import { search } from '../src/model/search.js';
import { findList } from '../src/model/find.js';

const spec = (ids) => `Part of #1.\n\n## Why\n\nBecause.\n\n## Behaviours\n\n${ids.map((id) => `- ${id} Given this, when that, then ${id} holds.`).join('\n')}\n\n## Open questions\n\nNone.\n`;
const issue = (n, title, body) => ({ id: `n${n}`, parentId: 'root', title: `#${n} ${title}`, kind: 'task', status: 'ready', url: `https://github.com/o/r/issues/${n}`, body, summary: 'Some work', estimate: 1 });
const tree = buildTree([
  { id: 'root', parentId: null, title: 'Project', kind: 'project', status: 'planned' },
  issue(34, 'Agents remember', spec(['AGENT-01', 'AGENT-02', 'AGENT-10', 'CONN-01'])),
  issue(35, 'Agent tokens', spec(['TOKEN-01'])),
]);

test('FIND-04 a behaviour ID, or the start of one in any case, lists the matching behaviours first, with the issue that holds them', () => {
  const found = search(tree, 'agent-', 20);
  assert.deepEqual(
    found.filter((r) => r.behaviour).map((r) => [r.behaviour.id, r.node.title]),
    [['AGENT-01', '#34 Agents remember'], ['AGENT-02', '#34 Agents remember'], ['AGENT-10', '#34 Agents remember']],
  );
  assert.ok(found.slice(0, 3).every((r) => r.behaviour), 'behaviours come before matches by title');
  assert.match(found[0].behaviour.words, /AGENT-01 holds/);
  assert.deepEqual(search(tree, 'AGENT-10').map((r) => r.behaviour?.id), ['AGENT-10']);
  assert.deepEqual(search(tree, 'conn-0').map((r) => r.behaviour?.id), ['CONN-01']);
  assert.deepEqual(search(tree, 'agent', 20).filter((r) => !r.behaviour).map((r) => r.node.title).sort(), ['#34 Agents remember', '#35 Agent tokens'], 'a word still finds titles');
});

test('FIND-04 words from a behaviour, in its given, when or then, list that behaviour after the items that matched by title', () => {
  const words = buildTree([
    { id: 'root', parentId: null, title: 'Project', kind: 'project', status: 'planned' },
    issue(40, 'Standup', `Part of #1.\n\n## Behaviours\n\n- CONN-03 Given a person starting work, when they connect, then the standup reports.\n- CONN-04 Given a first visit, when it runs, then it onboards.\n\n## Open questions\n\nNone.\n`),
  ]);
  assert.deepEqual(search(words, 'starting work').map((r) => r.behaviour?.id), ['CONN-03']);
  assert.deepEqual(search(words, 'standup').map((r) => r.behaviour?.id ?? r.node.title), ['#40 Standup', 'CONN-03']);
});

// A shop with tagged work, for the list of matches and its filters (FIND-01 to FIND-03).
const shop = buildTree([
  { id: 'root', parentId: null, title: 'Shop', kind: 'project', status: 'planned' },
  { id: 'bar', parentId: 'root', title: 'Search bar', kind: 'feature', status: 'ready', tags: ['search', 'ui'] },
  { id: 'api', parentId: 'root', title: 'Search API', kind: 'task', status: 'in_progress', tags: ['search', 'api'] },
  { id: 'speed', parentId: 'root', title: 'Search speed', kind: 'task', status: 'ready', tags: ['search', 'ui', 'perf'] },
  { id: 'filters', parentId: 'root', title: 'Search filters', kind: 'story', status: 'ready', tags: ['search', 'ui'], pulls: [7] },
  { id: 'cart', parentId: 'root', title: 'Cart drawer', kind: 'story', status: 'ready', tags: ['cart', 'ui'] },
]);
const titles = (rows) => rows.map((m) => m.node.title);
const inViewOf = (...ids) => (n) => ids.includes(n.id);

test('FIND-01 several matches are listed with their symbol, name and markers, the ones in view first, and the map marks each', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createElement: h } = await import('react');
  const { Matches } = await import('../src/components/Matches.jsx');
  const matches = search(shop, 'search', Infinity);
  const list = findList(matches, [], inViewOf('speed', 'filters'));
  const best = titles(matches);
  const near = ['Search speed', 'Search filters'];
  assert.deepEqual(titles(list.rows), [...best.filter((t) => near.includes(t)), ...best.filter((t) => !near.includes(t))], 'in view first, each group best first');
  assert.equal(list.inView, 2);
  assert.deepEqual([...list.marked].sort(), ['api', 'bar', 'filters', 'speed'], 'the map marks every match');

  const picked = [];
  const html = renderToStaticMarkup(h(Matches, { eyebrow: 'Search', heading: '4 matches', list, chosen: [], onChoose() {}, onPick: (m) => picked.push(m), onClose() {} }));
  const rows = html.split('<li>').slice(1);
  assert.equal(rows.length, 4);
  for (const [i, t] of titles(list.rows).entries()) assert.match(rows[i], new RegExp(`class="symbol-chip"[^]*<svg[^]*${t}`), 'its symbol, then its name');
  assert.match(rows[titles(list.rows).indexOf('Search filters')], /badge-chip pull/, 'and its markers: a pull request open on it');
  assert.match(html, /2 in view, 2 elsewhere/);
});

test('FIND-02 chips come from what the matches in view carry, most carried first, never one they all carry; chosen together they narrow the list and the map', () => {
  const matches = search(shop, 'search', Infinity);
  const all = () => true;
  const { chips } = findList(matches, [], all);
  const keys = chips.map((c) => c.key);
  assert.equal(chips[0].count, 3, 'the most carried first');
  assert.ok(chips.every((c, i) => i === 0 || chips[i - 1].count >= c.count), 'most carried first');
  assert.ok(!keys.includes('tag:search'), 'every match is tagged search, so it narrows nothing');
  for (const k of ['kind:task', 'status:in_progress', 'tag:api', 'tag:perf', 'tag:ui']) assert.ok(keys.includes(k), k);
  assert.ok(!keys.includes('tag:cart'), 'only what the matches carry');
  assert.equal(chips.find((c) => c.key === 'kind:task').label, 'Task');

  const inView = findList(matches, [], inViewOf('bar', 'api')).chips.map((c) => c.key);
  assert.ok(!inView.includes('tag:perf'), 'from the matches in view');

  const ui = findList(matches, ['tag:ui'], all);
  assert.deepEqual(titles(ui.rows).sort(), ['Search bar', 'Search filters', 'Search speed']);
  assert.ok(!ui.chips.some((c) => c.key === 'tag:ui'), 'a chosen chip is not offered again');
  const both = findList(matches, ['tag:ui', 'status:ready', 'kind:task'], all);
  assert.deepEqual(titles(both.rows), ['Search speed'], 'chips combine');
  assert.deepEqual([...both.marked], ['speed'], 'and narrow the map with the list');
});

test('FIND-03 chosen filters stay on as the map moves, and the list follows what is in view', () => {
  const matches = search(shop, 'search', Infinity);
  const chosen = ['tag:ui'];
  const here = findList(matches, chosen, inViewOf('bar'));
  const moved = findList(matches, chosen, inViewOf('speed', 'filters'));
  assert.equal(titles(here.rows)[0], 'Search bar');
  assert.deepEqual(titles(moved.rows).slice(0, 2).sort(), ['Search filters', 'Search speed'], 'what is in view now comes first');
  assert.equal(titles(moved.rows)[2], 'Search bar');
  assert.deepEqual([here.inView, moved.inView], [1, 2]);
  assert.ok(moved.rows.every((m) => m.node.tags.includes('ui')), 'the filter is still on');
  assert.deepEqual(titles(findList(matches, [], inViewOf('bar')).rows).length, 4, 'cleared, everything is back');
});
