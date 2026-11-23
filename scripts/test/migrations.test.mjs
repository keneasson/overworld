// Changes to deployed data (scripts/migrations/), proved on what they decide: open questions move from comments into
// their items' text (#68 ANSWER-08).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { questionsIntoSections } from '../migrations/002-questions-into-sections.mjs';
import { questionsIn } from '../../shared/questions.js';

const body = (questions) => `Part of #1\n\n## Why\n\nBecause.\n\n## Behaviours\n\n- CL-01 Given work, when claimed, then it is held.\n\n## Acceptance\n\nIt works.\n\n## Out of scope\n\nNothing.\n\n## Open questions\n\n${questions}\n\n---\n📍 placed by words`;
const node = { id: 'n1', url: 'https://github.com/o/r/issues/11', title: '#11 Claims', body: body('None.') };
const on = (id, text, extra = {}) => ({ id, itemKey: 'issue-11', anchor: { on: 'section', section: 'Open questions' }, text, author: 'Builder (a58a2)', createdAt: `2026-11-0${id.length}T00:00:00.000Z`, ...extra });

test('ANSWER-08 each open question kept as a comment becomes a line in its item\'s Open questions, with its answer under it, and the comment is dismissed saying where it went', () => {
  const comments = [
    on('q1', 'How long should a claim last?', { answer: { text: 'Two hours.', by: 'Ken', at: '2026-11-09T00:00:00.000Z' } }),
    { id: 'r1', itemKey: 'issue-11', replyTo: 'q1', anchor: { section: 'Open questions' }, text: 'Two hours.', author: 'Ken', createdAt: '2026-11-09T00:00:00.000Z' },
    on('q22', 'Weekends too?'),
    on('q333', 'Applied already?', { answer: { text: 'Yes.', by: 'Ken', appliedAt: '2026-11-10T00:00:00.000Z' } }),
    on('q4444', 'Dismissed?', { dismissed: { by: 'Ken', at: '2026-11-10T00:00:00.000Z' } }),
    { id: 'c5', itemKey: 'issue-11', anchor: { on: 'section', section: 'Why' }, text: 'Nice.', author: 'Ken', createdAt: '2026-11-10T00:00:00.000Z' },
  ];
  const { items, questions, dismissed } = questionsIntoSections({ nodes: [node], comments, at: '2026-11-22T00:00:00.000Z' });
  assert.equal(items.length, 1);
  assert.match(items[0].markdown, /## Open questions\n\n- How long should a claim last\?\nAnswer: Two hours\.\n- Weekends too\?$/, 'in place of None, each answer under its question');
  assert.doesNotMatch(items[0].markdown, /placed by words|Builder|Ken/, 'the text only: who asked and answered are kept beside it');
  assert.deepEqual(questionsIn('issue-11', items[0].markdown).map((q) => q.id), questions.map((q) => q.id));
  assert.deepEqual(questions.map((q) => [q.text, q.asked.by, q.asked.agentId, q.answered?.by]), [['How long should a claim last?', 'Builder (a58a2)', 'a58a2', 'Ken'], ['Weekends too?', 'Builder (a58a2)', 'a58a2', undefined]]);
  assert.deepEqual(dismissed.map((c) => c.id), ['q1', 'q22'], 'only the open ones move; replies, applied, dismissed and other comments stay as they are');
  assert.match(dismissed[0].dismissed.note, /Moved into the item's Open questions section/);

  // Run again on what it left, nothing moves twice.
  const again = questionsIntoSections({ nodes: [{ ...node, body: items[0].markdown }], comments: comments.map((c) => dismissed.find((d) => d.id === c.id) ?? c), at: '2026-11-22T00:00:00.000Z' });
  assert.deepEqual([again.items.length, again.dismissed.length], [0, 0]);
});
