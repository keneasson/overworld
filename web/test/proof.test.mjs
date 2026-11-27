// The proof layer (#21): only proven behaviours count as done, on the map and in the place card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildTree } from '../src/model/tree.js';
import { LENS_BY_ID, statusKey } from '../src/map/lenses.js';
import { behaviourHouses } from '../src/map/houses.js';
import { FileProof, ProofSection } from '../src/components/Panel.jsx';
import { proofOf } from '../../shared/proof.js';
import { buildReport } from '../../scripts/coverage/report.mjs';

const body = (behaviours) => `## Why\n\nBecause.\n\n## Behaviours\n\n${behaviours.map((b) => `- ${b}`).join('\n')}\n\n## Acceptance\n\nIt works.\n`;
const NODES = [
  { id: 'root', title: 'App', kind: 'project', parentId: null },
  { id: 'web', parentId: 'root', title: 'Web', kind: 'area' },
  { id: 'code', parentId: 'web', title: 'Editor code', kind: 'area', tags: ['code'], body: '**Code here** (2 files):\n\n- [shared/issue\\_shape.js](https://x/a)\n- [web/zoom.js](https://x/b)' },
  { id: 'i1', parentId: 'web', title: '#1 Editing', kind: 'story', status: 'done', body: body(['EDIT-01 Given an issue, when opened, then it is one document.', 'EDIT-02 Given a section, when edited, then only it changes.', 'EDIT-03 Given a page, when shown, then it looks right. ![the editor](https://example.com/editor.png)', 'EDIT-04 Given a thing, when untested, then nothing shows it.']) },
  { id: 'i2', parentId: 'web', title: '#2 Zoom', kind: 'story', status: 'ready', body: body(['ZOOM-01 Given a place, when zoomed, then its children show.']) },
];
const test1 = (name, passed, file = 'web/test/editor.test.mjs') => ({ name, file, passed });
const REPORT = {
  commit: 'abc1234def',
  coverage: 'behaviour',
  behaviours: {
    'EDIT-01': { passed: true, tests: [test1('EDIT-01 an issue opens as one document', true)], files: { 'shared/issue_shape.js': '31-41,93' } },
    'EDIT-02': { passed: false, tests: [test1('EDIT-02 editing a section changes only it', false)], files: { 'shared/issue_shape.js': '176-180' } },
    'ZOOM-01': { passed: true, tests: [test1('ZOOM-01 zooms', true, 'web/test/zoom.test.mjs')], files: { 'web/zoom.js': '1-9' } },
  },
};
const tree = (report = REPORT) => buildTree(NODES, '2030-01-01', { report });
// The place card's proof, as Details renders it below the issue's text.
const card = (t, id, props = {}) => {
  const p = { node: t.byId.get(id), tree: t, proof: { report: t.report, code: null, repo: 'octo/app' }, onPick() {}, onDirections() {}, ...props };
  return renderToStaticMarkup(h('div', null, h(ProofSection, p), h(FileProof, p)));
};

test('PROVEN-01 PROVEN-06 an area counts as done only the share of its adopted behaviours whose proof can be viewed and passes', () => {
  const t = tree();
  const web = t.byId.get('web');
  // EDIT-01 (a passing test) and EDIT-03 (a screenshot) are proven; EDIT-02 fails; EDIT-04 has nothing; ZOOM-01 isn't built yet.
  assert.deepEqual([web.stats.adopted, web.stats.proven, web.stats.broken], [5, 2, 1]);
  assert.equal(LENS_BY_ID.progress.stat(web), '2 of 5 behaviours done · 1 broken');
  assert.equal(t.byId.get('i1').stats.progress, 0.5, 'a done issue is as done as its proven behaviours');
  assert.equal(t.byId.get('i1').behaviourRows.find((b) => b.id === 'EDIT-04').done, 'unproven', 'nothing viewable proves it, whatever its issue says');
  assert.equal(tree(null).byId.get('i1').stats.progress, 1, 'with no report yet, done is what the issues say');
});

test('PROVEN-07 a done behaviour whose proof fails shows broken wherever done shows', () => {
  const t = tree();
  const i1 = t.byId.get('i1');
  assert.equal(statusKey(i1), 'broken', 'its symbol and the Lifecycle layer');
  assert.equal(LENS_BY_ID.lifecycle.stat(i1), 'Done, proof broken');
  assert.equal(i1.stats.health, 'off_track');
  assert.match(card(t, 'i1'), /<details class="proof-row failing"><summary>.*EDIT-02.*Broken: its proof fails/, 'its place card');
  assert.equal(statusKey(tree({ ...REPORT, behaviours: { ...REPORT.behaviours, 'EDIT-02': { ...REPORT.behaviours['EDIT-01'] } } }).byId.get('i1')), 'done', 'until its proof passes');
});

test('PROVEN-02 each house at the closest zoom shows untested, passing or failing from the latest report', () => {
  const houses = behaviourHouses(tree()).byIssue.get('i1');
  assert.deepEqual(houses.map((x) => [x.behaviour, x.proof.state, x.proof.proven]), [['EDIT-01', 'passing', true], ['EDIT-02', 'failing', false], ['EDIT-03', 'untested', true], ['EDIT-04', 'untested', false]]);
});

test('PROVEN-03 a behaviour place card shows its proof: its tests and the files they reach, and any screenshot, each linked to its source', () => {
  const html = card(tree(), 'i1', { atBehaviour: 'EDIT-01' });
  assert.match(html, /<details class="proof-row passing" open="">/, 'the behaviour opened from its house is open');
  assert.match(html, /href="https:\/\/github.com\/octo\/app\/blob\/abc1234def\/web\/test\/editor.test.mjs"[^>]*>EDIT-01 an issue opens as one document</);
  assert.match(html, /href="https:\/\/github.com\/octo\/app\/blob\/abc1234def\/shared\/issue_shape.js#L31-L41"[^>]*>shared\/issue_shape.js</);
  assert.match(html, /<img src="https:\/\/example.com\/editor.png" alt="the editor"/, 'a screenshot shows as the proof');
  assert.match(html, /No test is named EDIT-04, and nothing viewable shows it yet/);
});

test('PROVEN-04 a code area card lists the behaviours that reach each file, and Directions lights them up on the map', () => {
  const t = tree();
  let asked = null;
  const html = card(t, 'code', { onDirections: (x) => (asked = x) });
  assert.match(html, /shared\/issue_shape.js<\/span><span class="row-sub">2 behaviours reach it/);
  assert.match(html, />EDIT-01<\/button><button[^>]*>EDIT-02</);
  assert.match(html, /web\/zoom.js<\/span><span class="row-sub">1 behaviour reach/);
  assert.match(html, /Directions/);
  const lit = card(t, 'code', { lit: { path: 'web/zoom.js', houses: ['i2~ZOOM-01'] } });
  assert.match(lit, /class="directions on" aria-pressed="true"/, 'the file whose behaviours are lit says so');
  assert.equal(asked, null);
});

test('PROVEN-05 a report older than the code says so, with the commit it came from', () => {
  const t = tree();
  assert.match(card(t, 'i1', { proof: { report: REPORT, code: 'abc1234def', repo: 'octo/app' } }), /From the coverage report for abc1234/);
  assert.match(card(t, 'i1', { proof: { report: REPORT, code: '9999999fff', repo: 'octo/app' } }), /This report is from abc1234, older than the code, which is now at 9999999/);
});

test('BEH-07 a test may name a behaviour by its store ID: #574 counts for the behaviour that issue stands for, beside its own ID', () => {
  const report = buildReport([{ file: 'api/test/a.test.mjs', byFile: false, tests: [{ name: '#574 a new behaviour is saved first', passed: true, lines: {} }, { name: 'BEH-07 its old name still counts', passed: true, lines: {} }, { name: 'MCP-05 a mention of #9 is not a test of it', passed: true, lines: {} }] }], { commit: 'c' });
  assert.deepEqual(Object.keys(report.behaviours).sort(), ['#574', 'BEH-07', 'MCP-05'], 'a store ID names a behaviour only where IDs lead the name');
  const proof = proofOf('BEH-07', { report, aliases: ['#574'] });
  assert.equal(proof.state, 'passing');
  assert.equal(proof.tests.length, 2);
  assert.equal(proofOf('BEH-07', { report }).tests.length, 1);
  const nodes = [
    { id: 'root', title: 'App', kind: 'project', parentId: null },
    { id: 'issue-574', parentId: 'root', title: '#574 Saved first', kind: 'task', status: 'done', url: 'https://github.com/o/r/issues/574', body: body(['BEH-07 Given a behaviour, when more work is added, then it is saved first.']) },
  ];
  const row = buildTree(nodes, '2030-01-01', { report }).byId.get('issue-574').behaviourRows[0];
  assert.equal(row.proof.tests.length, 2, 'the map counts both');
});
