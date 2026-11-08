import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  RICH_SECTIONS,
  behaviourPrefix,
  blankBehaviour,
  isWellFormed,
  nextBehaviourId,
  parseBehaviours,
  parseIssue,
  sectionText,
  splitNote,
  writeBehaviours,
  writeIssue,
} from '@shared/issue-shape.js';
import { throughEditor } from '../src/editor/rich-text.js';

// Overworld's own roadmap, as GitHub returned it: real, well-formed issues.
const ISSUES = JSON.parse(readFileSync(new URL('./fixtures/overworld-issues.json', import.meta.url)));

const TEMPLATE = `Part of #1
Kind: Feature · Place: the editor

## Why

People need it.

## Behaviours

- EDIT-01 Given an item, when it is opened for editing, then each section is its own field.
- EDIT-02 Given behaviours, when they are added, then each gets the next ID.

## Acceptance

- Round-trip test.

## Out of scope

- Live cursors.

## Open questions

None.
`;

// The Acceptance line of #5: GitHub markdown -> editor -> markdown is unchanged for well-formed issues.
test('every section of a well-formed issue survives the editor unchanged', () => {
  for (const issue of [...ISSUES, { number: 0, body: TEMPLATE }]) {
    const shape = parseIssue(issue.body);
    assert.ok(isWellFormed(shape), `#${issue.number} is well formed`);
    const edits = Object.fromEntries(RICH_SECTIONS.map((name) => [name, throughEditor(sectionText(shape, name))]));
    edits.Behaviours = writeBehaviours(parseBehaviours(sectionText(shape, 'Behaviours')));
    assert.equal(writeIssue(shape, edits), issue.body, `#${issue.number} round-trips`);
  }
});

test('writing an issue with no edits gives back exactly what was read, even when it is not well formed', () => {
  const odd = ['', 'Just a line', '## Why\r\n\r\nWindows line ends\r\n', 'Intro\n\n## Notes\n\nNot in the shape\n## Why\nTight', TEMPLATE.replace('## Acceptance\n\n- Round-trip test.\n\n', '')];
  for (const body of odd) assert.equal(writeIssue(parseIssue(body)), body);
  assert.equal(isWellFormed(parseIssue(odd[4])), false);
});

// EDIT-01: each section is its own field, and the markdown saved is exactly the strict shape.
test('editing one section changes only that section', () => {
  const shape = parseIssue(TEMPLATE);
  const out = writeIssue(shape, { Why: 'People **really** need it.', Acceptance: '- Round-trip test.' });
  assert.equal(out, TEMPLATE.replace('People need it.', 'People **really** need it.'));
});

test('a missing section that gains content goes where the shape puts it', () => {
  const body = TEMPLATE.replace('## Out of scope\n\n- Live cursors.\n\n', '');
  const out = writeIssue(parseIssue(body), { 'Out of scope': '- Live cursors.' });
  assert.equal(out, TEMPLATE);
  const tail = writeIssue(parseIssue('## Why\n\nA reason.\n'), { 'Open questions': '- Which one?' });
  assert.equal(tail, '## Why\n\nA reason.\n\n## Open questions\n\n- Which one?\n');
});

test('template hints are not content, and are dropped once the section is written', () => {
  const shape = parseIssue('## Behaviours\n\n<!-- One per line -->\n');
  assert.equal(sectionText(shape, 'Behaviours'), '');
  assert.equal(writeIssue(shape, { Behaviours: '- A-01 Given x, when y, then z' }), '## Behaviours\n\n- A-01 Given x, when y, then z\n');
});

// EDIT-02: behaviours get the next ID for their area and are written as Given / When / Then.
test('behaviours read as Given / When / Then, and untouched ones keep their exact words', () => {
  const rows = parseBehaviours(sectionText(parseIssue(ISSUES.find((i) => i.number === 2).body), 'Behaviours'));
  assert.equal(rows.length, 6);
  assert.deepEqual([rows[0].id, rows[0].given, rows[0].when], ['LIFE-01', 'an open issue labelled `status:draft`, `status:needs-decision`, `status:ready` or `status:in-progress`', 'the repository is mapped']);
  assert.equal(rows[0].then, 'the item shows that state.');
  rows[1].then = 'it shows Done.';
  rows[1].dirty = true;
  const out = writeBehaviours(rows).split('\n');
  assert.equal(out[1], '- LIFE-02 Given an issue closed as *completed*, when mapped, then it shows Done.');
  assert.equal(out[0], rows[0].raw);
});

test('a new behaviour gets the next ID in the area and is written in the shape', () => {
  const area = ISSUES.map((i) => i.body);
  assert.equal(nextBehaviourId('EDIT', area), 'EDIT-06');
  assert.equal(nextBehaviourId('NEW', area), 'NEW-01');
  const rows = parseBehaviours('- EDIT-01 Given a, when b, then c.');
  assert.equal(behaviourPrefix(rows), 'EDIT');
  assert.equal(behaviourPrefix([], '#9 Area editor for the strict issue shape'), 'AREA');
  rows.push({ ...blankBehaviour('EDIT-06'), given: 'a phone', when: 'editing', then: 'it works.' });
  assert.equal(writeBehaviours(rows), '- EDIT-01 Given a, when b, then c.\n- EDIT-06 Given a phone, when editing, then it works.');
  rows.push(blankBehaviour('EDIT-07'));
  assert.equal(writeBehaviours(rows).split('\n').length, 2, 'an empty new row is not saved');
});

test('free-form and multi-line behaviours are kept', () => {
  const rows = parseBehaviours('- X-01 Something without the shape\n- Given a, when b,\n  then c');
  assert.deepEqual([rows[0].id, rows[0].text], ['X-01', 'Something without the shape']);
  assert.deepEqual([rows[1].given, rows[1].when, rows[1].then], ['a', 'b', 'c']);
  assert.equal(writeBehaviours(rows), '- X-01 Something without the shape\n- Given a, when b,\n  then c');
});

test("the map's 📍 note comes off a mapped issue's body and nothing else does", () => {
  const body = `${TEMPLATE}\n\n---\n📍 Placed in api/engine because it names a file there.`;
  assert.deepEqual(splitNote(body), { markdown: TEMPLATE, note: '\n\n---\n📍 Placed in api/engine because it names a file there.' });
  assert.equal(splitNote('A body\n\n---\nwith a rule').note, '');
});
