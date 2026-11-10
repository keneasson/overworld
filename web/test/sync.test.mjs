import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncBadge, toSave } from '../src/model/sync.js';

const issue = (n, sync) => ({ id: `issue-${n}`, title: `#${n} Item`, url: `https://github.com/o/r/issues/${n}`, ...(sync ? { sync } : {}) });

test('SYNC-11 an item says whether its changes are unsaved or saved but not yet on GitHub, and a save sends only what needs it', () => {
  assert.equal(syncBadge(issue(1, 'unsaved')).label, 'Not saved');
  assert.equal(syncBadge(issue(2, 'saving')).label, 'Saving');
  assert.equal(syncBadge(issue(3)), null, 'in line with GitHub: no badge');
  assert.ok(syncBadge(issue(4, 'conflict')) && syncBadge(issue(5, 'failed')));
  assert.deepEqual(toSave([issue(1, 'unsaved'), issue(2, 'saving'), issue(3), issue(5, 'failed')]), ['issue-1', 'issue-5'], 'a failed save is retried; one on its way is not sent twice');
});
