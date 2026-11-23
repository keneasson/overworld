import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree } from '../src/model/tree.js';
import { LENSES, LENS_BY_ID } from '../src/map/lenses.js';
import { wasteCard } from '../src/map/wasteland.js';

const root = { id: 'root', parentId: null, title: 'Shop', kind: 'project', status: 'in_progress' };
const code = (id, extra = {}) => ({ id, parentId: 'root', title: id, kind: 'feature', status: 'done', tags: ['code'], body: '', weight: 1, ...extra });
const mark = (m, line, text) => ({ mark: m, line, text, path: 'api/pay.mjs', url: `https://github.com/octo/shop/blob/main/api/pay.mjs#L${line}` });
const nodes = () => [
  root,
  code('Payments', { waste: [mark('fixme', 3, 'FIXME: rounding is off by a cent'), mark('unreachable', 9, 'after "return pay(req);": audit(req);')], wasteIssues: [7] }),
  code('Header'),
  {
    id: 'issue-7',
    parentId: 'Header',
    order: 7,
    title: '#7 Pay with a saved card',
    kind: 'story',
    status: 'done',
    body: '## Why\n\nPaying.\n\n## Behaviours\n\n- **PAY-01** Given a saved card, when I pay, then it pays in one tap.\n- **PAY-02** Given a coupon, when I pay, then it applies first.\n',
  },
];

test('WASTE-01 code marked as debt is wasteland on the map, its own entry in the legend, apart from Fog', () => {
  const tree = buildTree(nodes());
  const lens = LENS_BY_ID.wasteland;
  assert.ok(LENSES.includes(lens));
  const pay = tree.byId.get('Payments');
  const header = tree.byId.get('Header');
  assert.ok(lens.cracks(pay) && !lens.cracks(header));
  assert.notEqual(lens.fill(pay), lens.fill(header));
  assert.ok(lens.matches(pay) && !lens.matches(header));
  const waste = lens.legend(tree).find((l) => l.cracks);
  assert.match(waste.label, /wasteland/i);
  // Not Fog: Fog's legend has neither its colour nor its texture, and the Fog lens still draws fog.
  const fog = LENS_BY_ID.definition;
  assert.ok(fog.legend(tree).every((l) => l.color !== waste.color && !l.cracks));
  assert.equal(typeof fog.fog, 'function');
  assert.ok(!fog.cracks);
});

test('WASTE-03 WASTE-05 a wasteland place card says what marked it, the behaviours that cross it, and hands the repair to an agent with their tests as the safety net', () => {
  const tree = buildTree(nodes());
  const card = wasteCard(tree.byId.get('Payments'), tree);
  assert.deepEqual(card.kinds, ['A FIXME comment', 'Unreachable code']);
  assert.deepEqual(card.marks.map((m) => `${m.path}:${m.line}`), ['api/pay.mjs:3', 'api/pay.mjs:9']);
  assert.deepEqual(card.behaviours.map((b) => b.id), ['PAY-01', 'PAY-02']);
  assert.match(card.prompt, /^@Claude /);
  assert.match(card.prompt, /A FIXME comment: api\/pay\.mjs:3/);
  assert.match(card.prompt, /PAY-01, PAY-02\. Their tests/);
  assert.equal(wasteCard(tree.byId.get('Header'), tree), null, 'sound ground has no wasteland card');
});

test('WASTE-04 repaired ground is sound again, and its card shows the pull request that cleared it', () => {
  const repaired = nodes().map((n) => (n.id === 'Payments' ? { ...n, waste: undefined, wasteCleared: [{ path: 'api/pay.mjs', mark: 'fixme', text: 'FIXME: rounding', at: '2026-11-23T00:00:00Z', pr: { number: 42, url: 'https://github.com/octo/shop/pull/42' } }] } : n));
  const tree = buildTree(repaired);
  const pay = tree.byId.get('Payments');
  assert.ok(!LENS_BY_ID.wasteland.cracks(pay));
  assert.equal(LENS_BY_ID.wasteland.fill(pay), LENS_BY_ID.wasteland.fill(tree.byId.get('Header')));
  const card = wasteCard(pay, tree);
  assert.deepEqual(card.marks, []);
  assert.equal(card.cleared[0].pr.number, 42);
  assert.equal(card.cleared[0].label, 'A FIXME comment');
});
