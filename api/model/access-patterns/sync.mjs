// Sync with a store: the outbox of saved items, the lease on a project's sync and its write budget, the
// reports of each reconciliation, and which projects live in which store. All but the store links live in the
// project's partition, so deleting a project takes them with it.

import { keys, strip } from '../keys.mjs';
import { nodeItem } from './nodes.mjs';

const REPORTS_KEPT = 30;

export function jobs(table) {
  const item = (projectId, job) => ({ ...keys.job(projectId, job.id), entity: 'job', projectId, ...job });
  return {
    /** A project's saved items still to reach its store, in the order they were saved. Query begins_with(SK, JOB#). */
    async list(projectId) {
      return (await table.query(keys.jobsOf(projectId))).map(strip);
    },
    /** PutItem: a job's attempts and next try. */
    async put(projectId, job) {
      await table.put(item(projectId, job));
    },
    /**
     * The transactional outbox: each saved item's node and its job, written together or not at all. A job it
     * replaces (the same item, saved again before it reached the store) goes in the same transaction (SYNC-09).
     * @param {{ node: object, job: object, replaces?: object }[]} saves
     */
    async save(projectId, saves) {
      for (let i = 0; i < saves.length; i += 33) {
        const chunk = saves.slice(i, i + 33); // three items each, at most 100 to a transaction
        await table.transact({
          puts: chunk.flatMap((s) => [nodeItem(projectId, s.node), item(projectId, s.job)]),
          deletes: chunk.filter((s) => s.replaces).map((s) => keys.job(projectId, s.replaces.id)),
        });
      }
    },
    /** A job done: it goes, with its node's outcome and any later save of the same item moved onto what the store now holds. */
    async finish(projectId, job, { node = null, rebased = [] } = {}) {
      await table.transact({ puts: [...(node ? [nodeItem(projectId, node)] : []), ...rebased.map((j) => item(projectId, j))], deletes: [keys.job(projectId, job.id)] });
    },
  };
}

export function budgets(table) {
  return {
    /** The times of a project's recent writes to its store. GetItem. Only the worker holding the project's lease touches it. */
    async get(projectId) {
      return (await table.get(keys.lease(projectId, 'budget')))?.writes ?? [];
    },
    async put(projectId, writes) {
      await table.put({ ...keys.lease(projectId, 'budget'), entity: 'budget', writes });
    },
  };
}

export function leases(table) {
  return {
    /** Hold a project's sync until `until`, if nobody else does. Conditional PutItem. */
    claim: (projectId, owner, until, now) => table.claim(keys.lease(projectId, 'sync'), { owner, until, now }),
    /** Let it go, if it is still ours. */
    async release(projectId, owner) {
      const held = await table.get(keys.lease(projectId, 'sync'));
      if (held?.owner === owner) await table.delete(keys.lease(projectId, 'sync'));
    },
  };
}

export function audits(table) {
  return {
    /** A project's reconciliation reports, newest first. Query begins_with(SK, AUDIT#); at most 30 are kept. */
    async list(projectId) {
      return (await table.query({ ...keys.auditsOf(projectId), newestFirst: true })).map(strip);
    },
    /** Keep a report, and drop the oldest past the last 30. */
    async put(projectId, report) {
      const older = await table.query({ ...keys.auditsOf(projectId), newestFirst: true });
      await table.write({
        puts: [{ ...keys.audit(projectId, report.at), entity: 'audit', ...report }],
        deletes: older.slice(REPORTS_KEPT - 1).map(({ PK, SK }) => ({ PK, SK })),
      });
    },
  };
}

export function links(table) {
  return {
    /** Which projects live in this store (its key, e.g. github:owner/name), for an event about it. Query PK = STORE#<key>. */
    async projectsOf(key) {
      return (await table.query(keys.storeLinks(key))).map((it) => it.projectId);
    },
    /** PutItem, on import and on every refresh. */
    async link(key, projectId) {
      await table.put({ ...keys.storeLink(key, projectId), entity: 'store-link', projectId });
    },
    /** DeleteItem, when the project is gone. */
    async unlink(key, projectId) {
      await table.delete(keys.storeLink(key, projectId));
    },
  };
}
