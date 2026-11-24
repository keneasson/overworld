import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rgb } from 'd3';
import { buildTree } from '../src/model/tree.js';
import { LENSES, lensesWith, needsApproval } from '../src/map/lenses.js';
import { MARKER_LABEL, badgesOf } from '../src/map/labels.js';
import { reviewingAt, titleWithNumber, waitingForReview, waitingWords } from '../src/model/review.js';
import { turnOf } from '../../shared/turns.js';

const spec = (ids) => `Part of #1.\n\n## Why\n\nBecause.\n\n## Behaviours\n\n${ids.map((id) => `- ${id} Given this, when that, then ${id} holds.`).join('\n')}\n\n## Open questions\n\nNone.\n`;
const issue = (n, parentId, title, body) => ({ id: `n${n}`, parentId, title: `#${n} ${title}`, kind: 'task', status: 'ready', url: `https://github.com/o/r/issues/${n}`, body, summary: 'Some work', estimate: 1 });
const root = { id: 'root', parentId: null, title: 'Project', kind: 'project', status: 'planned' };
const nodes = [
  root,
  { ...issue(1, 'root', 'Epic', spec([])), kind: 'epic' },
  issue(11, 'n1', 'Pay by card', spec(['PAY-01', 'PAY-02'])),
  issue(12, 'n1', 'Refunds', spec(['REF-01'])),
  issue(13, 'n1', 'Receipts', spec(['REC-01'])),
  issue(14, 'n1', 'Invoices', spec(['INV-01'])),
];
const tree = buildTree(nodes);
const at = (h) => new Date(Date.UTC(2026, 10, 20, h)).toISOString();
const proposal = (id, author, items) => ({ id, author, status: 'open', createdAt: at(0), items });
const changesets = [
  proposal('c1', 'Builder (a1b2c)', [{ key: 'issue-12', at: at(9), after: { title: 'Refunds', markdown: spec(['REF-01', 'REF-02']) }, readyForAdoption: ['REF-02'] }]),
  proposal('c2', 'Ana', [
    // A person's own changes, which an agent has looked at and marked ready (#13 ADOPT-21).
    { key: 'issue-11', at: at(3), after: { title: 'Pay by card', markdown: spec(['PAY-01', 'PAY-02']).replace('then PAY-02 holds', 'then PAY-02 is kept') }, readyForAdoption: ['PAY-02'] },
    { key: 'issue-13', at: at(6), after: { title: 'Receipts', markdown: spec(['REC-01', 'REC-02']) }, readyForAdoption: ['REC-02'] },
  ]),
];
const notes = { 'issue-14': { count: 2, asked: 1, answered: 1, since: at(1) }, 'issue-13': { count: 1, read: [] } };

const reviewCount = (review) => needsApproval(review).count(tree);

test('REVIEW-01 REVIEW-02 the Review lens, beside the others, counts the issues waiting, and its list names each by number and title, longest waiting first', () => {
  const chip = LENSES.find((l) => l.id === 'approval');
  assert.equal(chip.chip, 'Review', 'a lens chip like Fog and Bugs, not a button of its own');
  const review = waitingForReview({ changesets, notes, tree });
  assert.equal(reviewCount(review), 4, 'three issues with changes proposed, and one with questions');
  assert.deepEqual(review.map((e) => titleWithNumber(e.node)), ['#14 Invoices', '#11 Pay by card', '#13 Receipts', '#12 Refunds'], 'questions are listed with them, the longest waiting first');
  const [invoices, card, , refunds] = review;
  assert.deepEqual([refunds.by, refunds.added, refunds.ready], [['Builder (a1b2c)'], ['REF-02'], ['REF-02']], 'who proposed it, what is new, and what is marked ready');
  assert.deepEqual([card.by, card.changed, card.added], [['Ana'], ['PAY-02'], []]);
  assert.equal(waitingWords(invoices), '1 answer to write in · 1 question to answer');

  // Adopting all of one takes it out of its refinement: the count follows, with no reload.
  const adopted = changesets.map((cs) => ({ ...cs, items: cs.items.filter((it) => it.key !== 'issue-12') }));
  assert.equal(reviewCount(waitingForReview({ changesets: adopted, notes, tree })), 3);
  assert.equal(reviewCount(waitingForReview({ changesets: [{ ...changesets[0], status: 'accepted' }], tree })), 0, 'a closed refinement waits on nobody');
});

test('REVIEW-03 an issue chosen from the Review list is reviewed there, and once decided it leaves the list and the next one is offered', () => {
  const review = waitingForReview({ changesets, notes, tree });
  const card = reviewingAt(review, 'n11');
  assert.deepEqual([card.here, card.more, titleWithNumber(card.next.node)], [true, 3, '#14 Invoices'], 'still waiting, with the longest waiting of the rest offered next');

  // Deciding all of it takes it out of its refinement, as adopting or declining does.
  const decided = changesets.map((cs) => ({ ...cs, items: cs.items.filter((it) => it.key !== 'issue-11') }));
  const after = reviewingAt(waitingForReview({ changesets: decided, notes, tree }), 'n11');
  assert.deepEqual([after.here, after.more, titleWithNumber(after.next.node)], [false, 3, '#14 Invoices'], 'it has left the list, and the next is offered');
  const last = reviewingAt(waitingForReview({ changesets: [], tree }), 'n11');
  assert.deepEqual([last.here, last.next], [false, null], 'nothing else waiting');
});

test('REVIEW-04 an issue with changes waiting carries a "to review" marker', () => {
  const review = waitingForReview({ changesets, tree });
  const refinements = new Map(review.map((e) => [e.node.id, e.changes]));
  assert.deepEqual(badgesOf(tree.byId.get('n12'), { refinements }), [{ type: 'refine', count: 1 }]);
  assert.deepEqual(badgesOf(tree.byId.get('n14'), { refinements }), [], 'nothing proposed, no marker');
  assert.match(MARKER_LABEL.refine, /^To review/);
});

test('REVIEW-05 the Review lens takes On target\'s place, strongest where the change has waited longest, and lists the same as Review', () => {
  assert.equal(LENSES[1].id, 'approval');
  assert.ok(!LENSES.some((l) => l.id === 'health'), 'On target is gone');
  const review = waitingForReview({ changesets, notes, tree });
  const lens = needsApproval(review);
  assert.equal(lensesWith(lens)[1], lens, 'offered over what is waiting now');
  assert.equal(lens.count(tree), 4, 'the issues waiting');
  const strength = (id) => {
    const c = rgb(lens.fill(tree.byId.get(id), tree));
    return 765 - c.r - c.g - c.b; // darker is stronger
  };
  assert.ok(strength('n14') > strength('n11') && strength('n11') > strength('n13') && strength('n13') > strength('n12'), 'the longer it has waited, the stronger');
  assert.equal(lens.fill(tree.byId.get('n1'), tree), lens.fill(tree.byId.get('n14'), tree), 'a region shows the oldest change inside it');
  assert.notEqual(needsApproval([]).fill(tree.byId.get('n11'), tree), lens.fill(tree.byId.get('n11'), tree), 'nothing waiting is plain');
  const list = tree.list.filter(lens.matches).sort(lens.sort);
  assert.deepEqual(list, review.map((e) => e.node), 'its list is the Review list');
});

test('ADOPT-21 a person\'s own change waits on an agent, not on review, until an agent marks it ready', () => {
  const edit = { key: 'issue-14', at: at(2), after: { title: 'Invoices', markdown: spec(['INV-01']).replace('then INV-01 holds', 'then INV-01 holds (Question: why not a hash?)') } };
  const theirs = (item) => [proposal('k1', 'Ken', [item])];
  assert.equal(turnOf(theirs(edit)[0], edit), 'agent', 'sent to an agent, waiting');
  assert.deepEqual(waitingForReview({ changesets: theirs(edit), tree }), [], 'not waiting for anyone\'s review');
  const answered = { ...edit, looked: { by: 'Builder (a1b2c)', at: at(3) } };
  assert.equal(turnOf(theirs(answered)[0], answered), 'talking', 'an agent answered it, nothing ready yet');
  assert.deepEqual(waitingForReview({ changesets: theirs(answered), tree }), []);
  const ready = { ...answered, readyForAdoption: ['INV-01'] };
  assert.equal(turnOf(theirs(ready)[0], ready), null, 'marked ready: there to adopt');
  assert.deepEqual(waitingForReview({ changesets: theirs(ready), tree }).map((e) => e.key), ['issue-14']);
  assert.equal(turnOf(changesets[0], changesets[0].items[0]), null, 'an agent\'s own proposal is there to adopt as ever');
});
