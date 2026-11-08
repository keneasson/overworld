// Sync with GitHub: the outbox of accepted changesets, the lease on a project's sync, the reports of
// each reconciliation, and which projects map a repository. All but the repository links live in the
// project's partition, so deleting a project takes them with it.

import { keys, strip } from '../keys.mjs';

const REPORTS_KEPT = 30;

export function jobs(table) {
  const item = (projectId, job) => ({ ...keys.job(projectId, job.id), entity: 'job', projectId, ...job });
  return {
    /** A project's jobs, oldest first: the order they reach GitHub. Query begins_with(SK, JOB#). */
    async list(projectId) {
      return (await table.query(keys.jobsOf(projectId))).map(strip);
    },
    /** PutItem: a job's attempts and next try. */
    async put(projectId, job) {
      await table.put(item(projectId, job));
    },
    /** The changeset and its outcome, with the job gone, in one transaction. A job whose changeset is gone just goes. */
    async finish(projectId, job, changeset) {
      const puts = changeset ? [{ ...keys.changeset(projectId, changeset.id), entity: 'changeset', ...changeset }] : [];
      await table.transact({ puts, deletes: [keys.job(projectId, job.id)] });
    },
    /** The transactional outbox: an accepted changeset and the job that takes it to GitHub, written together or not at all. */
    async accept(projectId, changeset, job) {
      await table.transact({ puts: [{ ...keys.changeset(projectId, changeset.id), entity: 'changeset', ...changeset }, item(projectId, job)] });
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

export function repos(table) {
  return {
    /** Which projects map this repository, for a webhook about it. Query PK = REPO#<owner/name>. */
    async projectsOf(repo) {
      return (await table.query(keys.repoLinks(repo))).map((it) => it.projectId);
    },
    /** PutItem, on import and on every refresh. */
    async link(repo, projectId) {
      await table.put({ ...keys.repoLink(repo, projectId), entity: 'repo-link', projectId });
    },
    /** DeleteItem, when the project is gone. */
    async unlink(repo, projectId) {
      await table.delete(keys.repoLink(repo, projectId));
    },
  };
}
