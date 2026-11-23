// The latest coverage report (#20 COVER-03): which code each behaviour's tests reached, for the proof layer (#21).
// One per project: saving a report replaces the one before it. It is kept compressed, so it stays well inside an item's size limit.

import { gunzipSync, gzipSync } from 'node:zlib';
import { keys } from '../keys.mjs';

export function coverage(table) {
  return {
    /** GetItem. The report, or null. */
    async get(projectId) {
      const item = await table.get(keys.coverage(projectId));
      return item ? { ...JSON.parse(gunzipSync(Buffer.from(item.report, 'base64')).toString('utf8')), savedAt: item.savedAt } : null;
    },
    /** PutItem, over the last one. */
    async put(projectId, report, savedAt) {
      await table.put({ ...keys.coverage(projectId), entity: 'coverage', commit: report.commit, savedAt, report: gzipSync(JSON.stringify(report)).toString('base64') });
    },
  };
}
