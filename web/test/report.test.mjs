// Where a bug report lands (#9 REPORT-02, REPORT-03): by meaning when there are vectors, by shared words when not, and
// the items in view when the map is zoomed in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree } from '../src/model/tree.js';
import { nearView, placeReport } from '../src/model/placement.js';

const spec = (rows) => `## Why\n\nBecause.\n\n## Behaviours\n\n${rows.map((r) => `- ${r}`).join('\n')}\n\n## Open questions\n\nNone.\n`;
const issue = (n, title, rows, parentId = 'web') => ({ id: `n${n}`, parentId, title: `#${n} ${title}`, kind: 'feature', status: 'ready', url: `https://github.com/o/r/issues/${n}`, body: spec(rows) });
const tree = buildTree([
  { id: 'root', parentId: null, title: 'Project', kind: 'project', status: 'planned' },
  { id: 'web', parentId: 'root', title: 'Web', kind: 'area', status: 'planned' },
  issue(68, 'Answer an open question', ['ANSWER-01 Given an open question, when a person answers it, then the answer is written under it.', 'ANSWER-07 Given a question, when an agent asks it, then it is a line in Open questions.']),
  issue(16, 'Screenshots in Photos', ['SHOT-01 Given a screenshot, when it is dropped on Photos, then it is kept.', 'SHOT-02 Given a newer screenshot, when it replaces one, then its pins stay.']),
  issue(44, 'Fog looks like fog', ['FOG-01 Given unknown work, when the Fog lens is on, then cloud drifts over it.']),
]);

test('REPORT-02 a report lands on the items whose behaviours are closest in meaning, naming those behaviours', () => {
  // Three made-up directions of meaning: questions, screenshots and fog.
  const vectors = new Map([
    ['issue-68:ANSWER-01', [1, 0, 0]],
    ['issue-68:ANSWER-07', [0.9, 0.1, 0]],
    ['issue-16:SHOT-01', [0, 1, 0]],
    ['issue-16:SHOT-02', [0.1, 0.9, 0]],
    ['issue-44:FOG-01', [0, 0, 1]],
  ]);
  const placed = placeReport(tree, 'Pasting an image does nothing', { vector: [0.05, 0.99, 0], vectors });
  assert.equal(placed.by, 'meaning');
  assert.equal(placed.places[0].node.title, '#16 Screenshots in Photos', 'closest in meaning, though it shares no word');
  assert.deepEqual(placed.places[0].behaviours.map((b) => b.id), ['SHOT-01', 'SHOT-02']);
});

test('REPORT-02 with no model, a report lands by the words it shares with behaviours and titles', () => {
  const placed = placeReport(tree, 'Open questions show twice in the panel');
  assert.equal(placed.by, 'words');
  assert.equal(placed.places[0].node.title, '#68 Answer an open question');
  assert.ok(placed.places[0].behaviours.some((b) => b.id === 'ANSWER-07'));
  assert.ok(!placed.places.some((p) => p.node.title.includes('Fog')), 'nothing in common, not suggested');
});

test('REPORT-03 zoomed in, the place in focus and the items in view are offered with their behaviours; at the overview, nothing', () => {
  const inView = (n) => n.id === 'n16';
  const near = nearView(tree, 'n68', inView);
  assert.deepEqual(near.map((p) => p.node.title), ['#68 Answer an open question']);
  const fromArea = nearView(tree, 'web', inView);
  assert.deepEqual(fromArea.map((p) => p.node.title), ['#16 Screenshots in Photos']);
  assert.deepEqual(fromArea[0].behaviours.map((b) => b.id), ['SHOT-01', 'SHOT-02']);
  assert.deepEqual(nearView(tree, 'root', () => true), []);
  assert.deepEqual(nearView(tree, null, () => true), []);
});
