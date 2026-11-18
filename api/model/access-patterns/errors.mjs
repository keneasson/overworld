// What went wrong in people's browsers (#71 SHIP-14): each error the app caught, with its stack, so it can be read without
// the device it happened on. Kept 30 days, by the table's TTL.

import { keys, strip } from '../keys.mjs';

const KEPT_DAYS = 30;
const DAY = 24 * 60 * 60;

export function errors(table) {
  return {
    /** PutItem, kept 30 days. */
    async put(report) {
      await table.put({ ...keys.clientError(report), entity: 'clientError', ...report, expiresAt: Math.floor(Date.parse(report.at) / 1000) + KEPT_DAYS * DAY });
    },
    /** The last 30 days', newest first. Query PK = ERRORS, SK from ERROR#<30 days ago>, descending. */
    async list(now = Date.now()) {
      const since = new Date(now - KEPT_DAYS * DAY * 1000).toISOString();
      return (await table.query({ ...keys.clientErrorsSince(since), newestFirst: true })).map(({ expiresAt, ...e }) => strip(e));
    },
  };
}
