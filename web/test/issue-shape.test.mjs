import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  RICH_SECTIONS,
  behaviourPrefix,
  blankBehaviour,
  compareItems,
  mergeChanges,
  isWellFormed,
  placeholderId,
  renumbered,
  parseBehaviours,
  parseIssue,
  sectionText,
  splitNote,
  writeBehaviours,
  writeIssue,
} from '@shared/issue-shape.js';
import { throughEditor } from '../src/editor/rich-text.js';
import { fromDocument, toDocument } from '../src/editor/document.js';

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

test('EDIT-01 every section of a well-formed issue survives the editor unchanged', () => {
  for (const issue of [...ISSUES, { number: 0, body: TEMPLATE }]) {
    const shape = parseIssue(issue.body);
    assert.ok(isWellFormed(shape), `#${issue.number} is well formed`);
    const edits = Object.fromEntries(RICH_SECTIONS.map((name) => [name, throughEditor(sectionText(shape, name))]));
    edits.Behaviours = writeBehaviours(parseBehaviours(sectionText(shape, 'Behaviours')));
    assert.equal(writeIssue(shape, edits), issue.body, `#${issue.number} round-trips`);
  }
});

test('EDIT-01 an issue saved with no edits is exactly what was read, even when not well formed', () => {
  const odd = ['', 'Just a line', '## Why\r\n\r\nWindows line ends\r\n', 'Intro\n\n## Notes\n\nNot in the shape\n## Why\nTight', TEMPLATE.replace('## Acceptance\n\n- Round-trip test.\n\n', '')];
  for (const body of odd) assert.equal(writeIssue(parseIssue(body)), body);
  assert.equal(isWellFormed(parseIssue(odd[4])), false);
});

test('EDIT-01 editing one section changes only that section', () => {
  const shape = parseIssue(TEMPLATE);
  const out = writeIssue(shape, { Why: 'People **really** need it.', Acceptance: '- Round-trip test.' });
  assert.equal(out, TEMPLATE.replace('People need it.', 'People **really** need it.'));
});

test('EDIT-01 a missing section that gains content goes where the shape puts it', () => {
  const body = TEMPLATE.replace('## Out of scope\n\n- Live cursors.\n\n', '');
  const out = writeIssue(parseIssue(body), { 'Out of scope': '- Live cursors.' });
  assert.equal(out, TEMPLATE);
  const tail = writeIssue(parseIssue('## Why\n\nA reason.\n'), { 'Open questions': '- Which one?' });
  assert.equal(tail, '## Why\n\nA reason.\n\n## Open questions\n\n- Which one?\n');
});

test('EDIT-01 an issue opens as one document, and an edit in it changes only that section', () => {
  for (const issue of [...ISSUES, { number: 0, body: TEMPLATE }]) {
    const opened = throughEditor(toDocument(issue.body));
    assert.equal(fromDocument(issue.body, opened, throughEditor(opened)), issue.body, `#${issue.number} is unchanged when nothing is edited`);
    const edited = opened.replace('## Why\n\n', '## Why\n\nEDITED. ');
    assert.equal(fromDocument(issue.body, opened, edited).replace('EDITED. ', ''), issue.body, `#${issue.number} keeps every other section exactly`);
  }
  const missing = TEMPLATE.replace('## Out of scope\n\n- Live cursors.\n\n', '');
  const opened = throughEditor(toDocument(missing));
  assert.ok(opened.includes('## Out of scope'), 'a missing section is there to be filled in');
  assert.equal(fromDocument(missing, opened, opened.replace('## Out of scope', '## Out of scope\n\n- Live cursors.')), TEMPLATE);
});

test('EDIT-01 NOTE-15 an image is in the document where it was written, so it can be commented on, and an edit beside it keeps it', () => {
  const why = 'The checkout today: ![the old checkout](https://example.com/old.png "Before") and its button.';
  assert.equal(throughEditor(why), why);
  assert.equal(throughEditor(why.replace('today', 'right now')), why.replace('today', 'right now'));
  const alone = 'Before.\n\n![a mock-up](https://example.com/new.png)\n\nAfter.';
  assert.equal(throughEditor(alone), alone, 'an image on its own line too');
});

test('EDIT-01 template hints are not content, and go once the section is written', () => {
  const shape = parseIssue('## Behaviours\n\n<!-- One per line -->\n');
  assert.equal(sectionText(shape, 'Behaviours'), '');
  assert.equal(writeIssue(shape, { Behaviours: '- A-01 Given x, when y, then z' }), '## Behaviours\n\n- A-01 Given x, when y, then z\n');
});

test('EDIT-02 behaviours read as Given / When / Then, and untouched ones keep their words', () => {
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

test('EDIT-02 ADOPT-11 a new behaviour is drafted with a placeholder for its ID, written in the shape, until a save gives it the number', () => {
  const draft = '## Behaviours\n\n- EDIT-01 Given a, when b, then c.\n- EDIT-?1 Given d, when e, then f.';
  assert.equal(placeholderId('EDIT', draft), 'EDIT-?2', 'a placeholder, never a number');
  assert.equal(placeholderId('NEW', draft, 4), 'NEW-?5', 'each one its own');
  assert.deepEqual(parseBehaviours(sectionText(parseIssue(draft), 'Behaviours')).map((r) => r.id), ['EDIT-01', 'EDIT-?1'], 'it reads as the behaviour\'s ID');
  assert.equal(behaviourPrefix(parseBehaviours('- EDIT-?1 Given a, when b, then c.')), 'EDIT');
  assert.equal(renumbered(draft, [{ placeholder: 'EDIT-?1', id: 'EDIT-07' }]), '## Behaviours\n\n- EDIT-01 Given a, when b, then c.\n- EDIT-07 Given d, when e, then f.');
  const rows = parseBehaviours('- EDIT-01 Given a, when b, then c.');
  assert.equal(behaviourPrefix(rows), 'EDIT');
  assert.equal(behaviourPrefix([], '#9 Area editor for the strict issue shape'), 'AREA');
  rows.push({ ...blankBehaviour('EDIT-06'), given: 'a phone', when: 'editing', then: 'it works.' });
  assert.equal(writeBehaviours(rows), '- EDIT-01 Given a, when b, then c.\n- EDIT-06 Given a phone, when editing, then it works.');
  rows.push(blankBehaviour('EDIT-07'));
  assert.equal(writeBehaviours(rows).split('\n').length, 2, 'an empty new row is not saved');
});

test('EDIT-02 free-form and multi-line behaviours are kept', () => {
  const rows = parseBehaviours('- X-01 Something without the shape\n- Given a, when b,\n  then c');
  assert.deepEqual([rows[0].id, rows[0].text], ['X-01', 'Something without the shape']);
  assert.deepEqual([rows[1].given, rows[1].when, rows[1].then], ['a', 'b', 'c']);
  assert.equal(writeBehaviours(rows), '- X-01 Something without the shape\n- Given a, when b,\n  then c');
});

test("EDIT-01 the map's 📍 note is never saved as part of the issue", () => {
  const body = `${TEMPLATE}\n\n---\n📍 Placed in api/engine because it names a file there.`;
  assert.deepEqual(splitNote(body), { markdown: TEMPLATE, note: '\n\n---\n📍 Placed in api/engine because it names a file there.' });
  assert.equal(splitNote('A body\n\n---\nwith a rule').note, '');
});

test('ADOPT-02 a refinement reads against the spec: its title, each behaviour and each section, added, changed or removed', () => {
  const spec = { title: 'Claims', markdown: 'Part of #1\n\n## Why\n\nAgents collide.\n\n## Behaviours\n\n- CL-01 Given work, when claimed, then it is held.\n- CL-02 Given a claim, when it ends, then it says so.\n\n## Open questions\n\nNone\n' };
  const proposed = { title: 'Claims that run out', markdown: 'Part of #1\n\n## Why\n\nAgents collide.\n\n## Behaviours\n\n- CL-01 Given work, when claimed, then it is held for two hours.\n- CL-03 Given a held claim, when claimed again, then it lasts longer.\n\n## Acceptance\n\nTwo agents never build the same thing.\n\n## Open questions\n\nNone\n' };
  const diff = compareItems(spec, proposed);
  assert.deepEqual(diff.title, { before: 'Claims', after: 'Claims that run out' });
  assert.deepEqual(diff.behaviours.map((b) => [b.id, b.change]), [['CL-01', 'changed'], ['CL-02', 'removed'], ['CL-03', 'added']]);
  assert.equal(diff.behaviours[0].after, 'CL-01 Given work, when claimed, then it is held for two hours.');
  assert.deepEqual(diff.sections.map((x) => [x.name, x.change]), [['Acceptance', 'added']], 'unchanged sections are left out');
  assert.deepEqual(compareItems(spec, spec), { title: null, behaviours: [], sections: [] });
});

test("ADOPT-17 a refinement's changes are what it changed from its base: what it didn't touch never shows, and spacing is never a change", () => {
  const base = { title: 'Claims', markdown: 'Part of #1\n\n## Why\n\nAgents collide.\n\n## Behaviours\n\n- CL-01 Given work, when claimed, then it is held.\n\n## Open questions\n\n- How long?\n' };
  const proposed = { title: 'Claims', markdown: 'Part of #1\n\n## Why\n\nAgents collide.\n\n## Behaviours\n\n- CL-01 Given work, when claimed, then it is held for two hours.\n\n## Open questions\n\n- How long?\n\n\n' };
  // Since it was proposed, someone answered the open question, and the editor filled in an Acceptance section.
  const now = { title: 'Claims', markdown: base.markdown.replace('- How long?', 'None').replace('## Open questions', '## Acceptance\n\nTwo agents never collide.\n\n## Open questions') };
  const diff = compareItems(now, proposed, base);
  assert.deepEqual(diff.behaviours.map((b) => [b.id, b.change]), [['CL-01', 'changed']]);
  assert.deepEqual(diff.sections, [], "someone else's edits are not the refinement's");
  assert.equal(diff.title, null);
  assert.deepEqual(compareItems(base, { ...base, markdown: base.markdown.replace('Agents collide.', 'Agents   collide.\n\n') }), { title: null, behaviours: [], sections: [] }, 'spacing alone');

  const adopted = mergeChanges(now, proposed, ['CL-01', 'other'], base);
  assert.match(adopted.markdown, /held for two hours/);
  assert.match(adopted.markdown, /## Acceptance\n\nTwo agents never collide\.[\s\S]*## Open questions\n\nNone/, 'adopting never overwrites what it did not change');

  const touched = { ...proposed, markdown: proposed.markdown.replace('- How long?', '- How long? Two hours?') };
  const clash = compareItems(now, touched, base).sections.find((x) => x.name === 'Open questions');
  assert.equal(clash.conflict, true, 'a part it changed that has changed since is a conflict');
  assert.deepEqual(compareItems(now, proposed).sections.map((x) => x.name), ['Acceptance', 'Open questions'], 'with no base, against the item as it is');
});
