import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedSince, syncBadge, toSave } from '../src/model/sync.js';
import { buildTree } from '../src/model/tree.js';
import { changesetContents } from '../src/model/changesets.js';
import { cleanAnchor, whereOf } from '@shared/annotations.js';

const issue = (n, sync) => ({ id: `issue-${n}`, title: `#${n} Item`, url: `https://github.com/o/r/issues/${n}`, ...(sync ? { sync } : {}) });

test('SYNC-11 an item says whether its changes are unsaved or saved but not yet on GitHub, and a save sends only what needs it', () => {
  assert.equal(syncBadge(issue(1, 'unsaved')).label, 'Not saved');
  assert.equal(syncBadge(issue(2, 'saving')).label, 'Saving');
  assert.equal(syncBadge(issue(3)), null, 'in line with GitHub: no badge');
  assert.ok(syncBadge(issue(4, 'conflict')) && syncBadge(issue(5, 'failed')));
  assert.deepEqual(toSave([issue(1, 'unsaved'), issue(2, 'saving'), issue(3), issue(5, 'failed')]), ['issue-1', 'issue-5'], 'a failed save is retried; one on its way is not sent twice');
});

test('SYNC-01 the changeset\'s box holds its edits across issues, with what each changes, and its comments are anchored comments on their area', () => {
  const spec = (ids) => `Part of #1\n\n## Why\n\nBecause.\n\n## Behaviours\n\n${ids.map((id) => `- ${id} Given this, when that, then ${id} holds.`).join('\n')}\n\n## Open questions\n\nNone.\n`;
  const at = (n, parentId, ids, more = {}) => ({ ...issue(n), parentId, kind: 'task', status: 'ready', body: spec(ids), ...more });
  const tree = buildTree([
    { id: 'root', parentId: null, title: 'Project', kind: 'project' },
    { ...at(1, 'root', []), kind: 'epic' },
    at(11, 'issue-1', ['PAY-01']),
    at(12, 'issue-1', ['REF-01']),
    at(13, 'issue-1', ['REC-01'], { sync: 'unsaved' }),
  ]);
  const drafts = new Map([
    ['issue-11', { title: '#11 Item', markdown: spec(['PAY-01', 'PAY-02']) }],
    ['issue-12', { title: '#12 Item', markdown: spec(['REF-01']).replace('then REF-01 holds', 'then REF-01 is kept') }],
  ]);
  const box = changesetContents({ tree, edited: ['issue-11', 'issue-12'], unsaved: ['issue-13'], drafts });
  assert.equal(box.area.id, 'issue-1', 'the area the edits are in');
  assert.deepEqual(
    box.items.map((it) => [it.key, it.edited, it.added, it.changed]),
    [['issue-11', true, ['PAY-02'], []], ['issue-12', true, [], ['REF-01']], ['issue-13', false, [], []]],
    'every issue it holds, edited or accepted and not on GitHub yet, with what it changes',
  );
  assert.equal(changesetContents({ tree, edited: [], unsaved: [], drafts }), null, 'an empty box has nothing to review');
  assert.deepEqual(cleanAnchor({ on: 'changeset', section: 'Why', quote: 'x' }), { on: 'changeset' }, 'on the changeset as a whole');
  assert.equal(whereOf({ on: 'changeset' }), 'the changeset');
});

test('ADOPT-17 an edit whose item changed underneath it says GitHub only when GitHub changed it, and otherwise who in Overworld', () => {
  assert.match(changedSince({ on: 'store' }), /changed on GitHub/);
  assert.match(changedSince({ on: 'overworld', by: 'Ken', behaviours: ['ADOPT-05'] }), /changed in Overworld since you started \(Ken adopted ADOPT-05\)/);
  assert.doesNotMatch(changedSince({ on: 'overworld' }), /GitHub/);
  assert.match(changedSince({}), /since you started\./);
});
