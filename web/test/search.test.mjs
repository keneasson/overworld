import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree } from '../src/model/tree.js';
import { search } from '../src/model/search.js';

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
