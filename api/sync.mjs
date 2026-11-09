// Sync with GitHub (#3). Overworld is where people and agents work; GitHub is the permanent store.
//
// Work in progress stays here. Only a save reaches GitHub (SYNC-07), and a save decides nothing: it takes
// each unsaved item as it is at that moment, state included, and queues it to be written (SYNC-08).
//
//   edit     accepting a changeset, or changing an item on the map, marks it unsaved, remembering the
//            version GitHub had (its base)
//   save     saveNow(): the one path every trigger calls. Each unsaved item's snapshot and its job (the
//            outbox) are written in one transaction; an item saved again before it was written replaces
//            its job, so GitHub gets one write of the latest version (SYNC-09)
//   drain    takes a project's jobs to GitHub in the order saved, under a lease so only one worker runs.
//            Each item is checked against GitHub before it is written, so a worker that dies part-way
//            through is simply run again. Writes keep to a budget well under GitHub's limits (SYNC-10);
//            GitHub slow, down or rate-limited anyway: the job books its own retry (SYNC-02)
//   webhook  an issue edited on GitHub updates its place on the map at once (SYNC-03)
//   reconcile  nightly: maps each repository again, so a missed webhook can't leave drift (SYNC-04)
//
// Sync never merges or chooses between versions. An item that changed on GitHub since it was last read is
// written nothing; the map shows GitHub's version and the item goes back to a person as a conflict (SYNC-06).
//
// A node's sync state, kept on the node so the map can badge it (SYNC-11):
//   sync      'unsaved' | 'saving' | 'conflict' | 'failed' (absent: in line with GitHub)
//   base      the version GitHub had when the item was last read
//   saved     the version last saved, while it is on its way
//   conflict  { ours, theirs } for a person to resolve;  syncError  why GitHub refused it

import { randomUUID } from 'node:crypto';
import { editableOf, issueOf, itemKeyOf, splitNote } from '../shared/issue-shape.js';
import { fromRest, importGitHub } from './github.mjs';
import { PermanentError } from './github-app.mjs';
import { labelsForNew, patchFor, sameVersion, stateAsRead, stateOf, versionOnGitHub } from './github-state.mjs';
import { closedByOpenPrs } from './engine/lifecycle.mjs';
import { issueFields, issueNodeId } from './engine/project.mjs';
import { same } from './edits.mjs';

const LEASE_MS = 120_000; // longer than one Lambda run (30 s), so a lease outlives its worker only briefly
const BACKOFF_MINUTES = [1, 5, 30, 120, 360, 720, 1440]; // then daily; the nightly reconciliation also retries
// GitHub allows 80 content-creating requests a minute and 500 an hour. Sync keeps well under, per project.
export const WRITE_BUDGET = { perMinute: 20, perHour: 150 };
const MARKER = 'overworld-new-item';
const NEW_REF = /#(new-[\w-]+)\b/g;
const PLACEMENT_TAGS = new Set(['placed-by-words', 'unplaced']);
const SYNC_FIELDS = ['sync', 'base', 'saved', 'savedAt', 'conflict', 'syncError'];

/** Not an error: the write budget is spent, so this waits until `retryAt`. */
class OverBudget extends Error {
  constructor(retryAt) {
    super('write budget spent');
    this.retryAt = retryAt;
  }
}

const strictOf = (project) => project?.strictLifecycle !== false;
const inLine = (node) => Object.fromEntries(Object.entries(node).filter(([k]) => !SYNC_FIELDS.includes(k)));
/** The item as it should read on GitHub. */
export const versionOf = (node, strict) => ({ ...editableOf(node), ...stateOf(node, { strict }) });
/** The item as GitHub had it when the map last read it. */
const versionAsRead = (node, strict) => ({ ...editableOf(node), ...stateAsRead(node, { strict }) });
/** An item made here, on its way to becoming an issue, is keyed new-<node id>. */
const jobKeyOf = (node) => (issueOf(node) ? itemKeyOf(node) : `new-${node.id}`);

/**
 * An item changed in Overworld: from now on it is unsaved, until a save takes it to GitHub (SYNC-07).
 * Only items mapped from a GitHub repository have anywhere to go.
 */
export function markEdited(before, after, project) {
  if (!project?.githubRepo || !issueOf(before)) return after;
  const waiting = ['unsaved', 'saving', 'failed'].includes(before.sync);
  return { ...inLine(after), sync: 'unsaved', base: waiting ? before.base : versionAsRead(before, strictOf(project)), ...(before.saved ? { saved: before.saved, savedAt: before.savedAt } : {}) };
}

/**
 * Save now: every unsaved item of the project (or just `keys`) goes into the outbox as it is. The one path
 * every save trigger calls: a person's Save button today, Overworld's own triggers later.
 * @returns {Promise<{ saved: string[] }>} the item keys saved
 */
export async function saveNow(model, projectId, { keys = null, now = new Date().toISOString() } = {}) {
  const project = await model.projects.get(projectId);
  if (!project?.githubRepo) return { saved: [] };
  const strict = strictOf(project);
  const chosen = (await model.nodes.pending(projectId)).filter((n) => ['unsaved', 'failed'].includes(n.sync) && (!keys || keys.includes(itemKeyOf(n))));
  const waiting = await model.jobs.list(projectId);
  const saves = chosen.map((node) => {
    const key = jobKeyOf(node);
    const after = versionOf(node, strict);
    const job = { id: `${now}#${key}`, key, nodeId: node.id, repo: project.githubRepo, strict, base: node.base ?? null, after, epic: /^Kind:\s*Epic\b/im.test(after.markdown), savedAt: now, attempts: 0 };
    const replaces = waiting.find((j) => j.key === key && j.id !== job.id);
    return { node: { ...inLine(node), sync: 'saving', base: node.base, saved: after, savedAt: now }, job, replaces };
  });
  await model.jobs.save(projectId, saves);
  return { saved: saves.map((s) => s.job.key) };
}

/** A node with what GitHub now says about its issue, keeping where it sits on the map and why. */
export function mapIssueOnto(node, ghIssue, { strict = true, now = new Date().toISOString() } = {}) {
  const issue = fromRest(ghIssue);
  const note = splitNote(node.body ?? '').note.replace(/^\s*---\s*📍\s*/, '').replace(/ Status unclear: [^.]*\.$/, '');
  const placement = (node.tags ?? []).filter((t) => PLACEMENT_TAGS.has(t));
  // A pull request that closes the issue keeps it in progress; webhooks about the issue don't say so, so keep what the map knew.
  const inProgress = node.status === 'in_progress' && issue.state === 'open' ? new Set([issue.number]) : new Set();
  return { ...inLine(node), ...issueFields(issue, { lifecycle: { strict, inProgress }, note, placement, kind: node.kind }), updatedAt: now };
}

/**
 * GitHub's latest version of an item (`fresh`, as the map reads it) meets the map's (`old`). An item not
 * waiting for GitHub just takes GitHub's version. One waiting keeps its edits while GitHub still holds what it
 * started from, or what was last saved; anything else is a change made on GitHub, and a conflict.
 */
export function settle(old, fresh, strict) {
  if (!old.sync) return fresh;
  const theirs = versionAsRead(fresh, strict);
  if (old.sync === 'conflict') return { ...fresh, sync: 'conflict', conflict: { ...old.conflict, theirs } };
  if (sameVersion(theirs, versionOf(old, strict))) return fresh; // already there
  if (old.base && sameVersion(theirs, old.base)) return old;
  if (old.saved && sameVersion(theirs, old.saved)) return { ...old, base: old.saved }; // our save arrived; later edits still wait
  return { ...fresh, sync: 'conflict', conflict: { ours: versionOf(old, strict), theirs } };
}

/**
 * After a refresh from GitHub: items still waiting for GitHub keep their edits, or become conflicts. Read
 * from the pending index, not the map. Items made here that aren't on GitHub yet stay on the map.
 * @returns {{ nodes: object[], conflicts: string[] }}
 */
export function keepPending(freshNodes, pending, strict) {
  const byId = new Map(freshNodes.map((n) => [n.id, n]));
  const conflicts = [];
  for (const old of pending) {
    const fresh = byId.get(old.id);
    const kept = fresh ? settle(old, fresh, strict) : old;
    if (kept.sync === 'conflict' && old.sync !== 'conflict') conflicts.push(itemKeyOf(old));
    byId.set(old.id, kept);
  }
  return { nodes: [...byId.values()], conflicts };
}

const changedOnMap = (a, b) => a.title !== b.title || a.body !== b.body || a.status !== b.status || a.definition !== b.definition || String(a.tags) !== String(b.tags) || a.sync !== b.sync;

/**
 * @param {object} o
 * @param {object} o.model
 * @param {object} o.github the GitHub App client (api/github-app.mjs), or a test's stand-in
 * @param {(projectId: string, at: string) => Promise<void>} o.schedule books a run of drain(projectId) at `at`
 * @param {() => Date} [o.clock]
 */
export function createSync({ model, github, schedule = async () => {}, fetchImpl = fetch, log = console, clock = () => new Date(), budget = WRITE_BUDGET }) {
  const iso = (ms = clock().getTime()) => new Date(ms).toISOString();

  /** Spend one write from the project's budget, or say when the next one is free. */
  async function spend(projectId) {
    const t = clock().getTime();
    const writes = (await model.budgets.get(projectId)).filter((w) => Date.parse(w) > t - 3_600_000);
    const lastMinute = writes.filter((w) => Date.parse(w) > t - 60_000);
    if (lastMinute.length >= budget.perMinute) throw new OverBudget(iso(Date.parse(lastMinute[0]) + 60_000));
    if (writes.length >= budget.perHour) throw new OverBudget(iso(Date.parse(writes[0]) + 3_600_000));
    await model.budgets.put(projectId, [...writes, iso(t)]);
  }

  /** `#new-<id>` references to items now on GitHub point at their numbers. */
  async function withNumbers(projectId, text) {
    const numbers = new Map();
    for (const [, key] of text.matchAll(NEW_REF)) {
      const node = await model.nodes.get(projectId, key.slice(4));
      const issue = node && issueOf(node);
      if (issue) numbers.set(key, issue.number);
    }
    return text.replace(NEW_REF, (ref, key) => (numbers.has(key) ? `#${numbers.get(key)}` : ref));
  }

  /** Take one saved item to GitHub, and say what happened. A new issue's create is written down first, so a crash can't make two. */
  async function syncItem(projectId, job) {
    const { repo, strict } = job;
    const marker = `<!-- ${MARKER}:${job.key} -->`;
    const want = { ...job.after, markdown: await withNumbers(projectId, job.after.markdown) };
    let number = job.number ?? (job.key.startsWith('issue-') ? Number(job.key.slice(6)) : null);
    try {
      if (!number) {
        // A create may have reached GitHub just before a crash. Find it rather than create a second one (NEW-04).
        const found = job.creating && (await github.findCreated(repo, marker, iso(Date.parse(job.creating) - 60_000)));
        if (found) number = found.number;
        else {
          await spend(projectId);
          await model.jobs.put(projectId, { ...job, creating: iso() });
          number = (await github.createIssue(repo, { title: want.title, body: `${want.markdown}\n\n${marker}`, labels: labelsForNew(want, { epic: job.epic }) })).number;
        }
        await model.jobs.put(projectId, { ...job, number });
      }
      const gh = await github.getIssue(repo, number);
      const theirs = versionOnGitHub(gh, { strict });
      if (sameVersion(theirs, want)) return { outcome: 'written', number, want }; // already there: a retry after a crash, or the same edit made twice
      const node = await model.nodes.get(projectId, job.nodeId);
      const untouched = (job.base && sameVersion(theirs, job.base)) || (node?.base && sameVersion(theirs, node.base)) || (job.key.startsWith('new-') && theirs.markdown.includes(marker));
      if (!untouched) return { outcome: 'conflict', number, want, gh, theirs };
      await spend(projectId);
      await github.updateIssue(repo, number, patchFor(gh, want, { strict }));
      return { outcome: 'written', number, want };
    } catch (err) {
      if (!(err instanceof PermanentError)) throw err; // GitHub down or over budget: later. Anything else: a crash, so resume
      return { outcome: 'failed', number, error: err.message };
    }
  }

  /** A job done: its node says so, and later saves of the same item start from what GitHub now holds. */
  async function finish(projectId, job, result, waiting) {
    const node = await model.nodes.get(projectId, job.nodeId);
    const later = waiting.filter((j) => j.key === job.key && j.id !== job.id);
    const url = result.number && `https://github.com/${job.repo}/issues/${result.number}`;
    let next = null;
    if (node && result.outcome === 'written') {
      // An item made here is now that issue. (Its node keeps its id; a refresh renames it issue-<number>.)
      const placed = issueOf(node) ? node : { ...node, url, title: `#${result.number} ${node.title}`.slice(0, 200) };
      const current = !node.sync || (node.sync === 'saving' && node.savedAt === job.savedAt);
      next = current ? inLine(placed) : { ...placed, base: result.want };
    } else if (node && result.outcome === 'conflict') {
      next = { ...mapIssueOnto(node, result.gh, { strict: job.strict, now: iso() }), sync: 'conflict', conflict: { ours: versionOf(node, job.strict), theirs: result.theirs } };
    } else if (node && result.outcome === 'failed') {
      next = { ...node, ...(url && !issueOf(node) ? { url } : {}), sync: 'failed', syncError: result.error };
    }
    const rebased = result.outcome === 'written' ? later.map((j) => ({ ...j, base: result.want, number: result.number })) : [];
    await model.jobs.finish(projectId, job, { node: next, rebased });
    if (result.outcome !== 'written') for (const j of later) await model.jobs.finish(projectId, j); // a person decides this item now
  }

  /** The job as it is stored now (a crash-guard may have been written into it), or null if a later save replaced it. */
  const latest = async (projectId, job) => (await model.jobs.list(projectId)).find((j) => j.id === job.id) ?? null;

  /**
   * Take a project's saved items to GitHub, new issues first, then in the order saved. A job that can't go yet holds back the ones after it.
   * @param {{ now?: boolean }} [opts] now: don't wait for a booked retry (a person pressed Retry, or the nightly run)
   */
  async function drain(projectId, { now = false } = {}) {
    const owner = randomUUID();
    if (!(await model.leases.claim(projectId, owner, iso(clock().getTime() + LEASE_MS), iso()))) {
      // Someone else is syncing. If they finish just before this job landed, the booked retry picks it up.
      await schedule(projectId, iso(clock().getTime() + 60_000));
      return { status: 'busy' };
    }
    const next = async () => {
      const all = await model.jobs.list(projectId);
      return { all, job: all.find((j) => j.key.startsWith('new-') && !j.number) ?? all[0] };
    };
    try {
      // Items saved while this runs join the end of the line: list again until none are left.
      for (let { all, job } = await next(); job; { all, job } = await next()) {
        if (!now && job.nextAttemptAt && job.nextAttemptAt > iso()) {
          await schedule(projectId, job.nextAttemptAt);
          return { status: 'waiting', until: job.nextAttemptAt };
        }
        let result;
        try {
          result = await syncItem(projectId, job);
        } catch (err) {
          if (!(err instanceof OverBudget) && !err.transient) throw err;
          const stored = await latest(projectId, job);
          if (err instanceof OverBudget) {
            // Not a failure: the writes are spread out instead of refused (SYNC-10).
            if (stored) await model.jobs.put(projectId, { ...stored, nextAttemptAt: err.retryAt });
            await schedule(projectId, err.retryAt);
            return { status: 'waiting', until: err.retryAt };
          }
          const attempts = (job.attempts ?? 0) + 1;
          const backoff = clock().getTime() + BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length) - 1] * 60_000;
          const nextAttemptAt = iso(Math.max(backoff, err.retryAt ? Date.parse(err.retryAt) : 0));
          if (stored) await model.jobs.put(projectId, { ...stored, attempts, nextAttemptAt, lastError: err.message });
          await schedule(projectId, nextAttemptAt);
          log.warn?.(`sync ${projectId}: ${err.message}; next try ${nextAttemptAt}`);
          return { status: 'retrying', until: nextAttemptAt };
        }
        await finish(projectId, job, result, all);
      }
      return { status: 'synced' };
    } finally {
      await model.leases.release(projectId, owner);
    }
  }

  /** A GitHub webhook, already verified. Updates the issue's place on the map at once, and marks an open edit of it as a conflict. */
  async function onWebhook(event, payload) {
    const repo = payload?.repository?.full_name;
    if (!repo || !['issues', 'pull_request'].includes(event)) return { handled: false };
    const touched = [];
    for (const projectId of await model.repos.projectsOf(repo)) {
      const project = await model.projects.get(projectId);
      if (!project) {
        await model.repos.unlink(repo, projectId);
        continue;
      }
      if (event === 'issues' && !payload.issue?.pull_request) {
        const node = await model.nodes.get(projectId, issueNodeId(payload.issue.number));
        if (!node) continue; // not on this map yet: the nightly reconciliation places it
        const updated = settle(node, mapIssueOnto(node, payload.issue, { strict: strictOf(project), now: iso() }), strictOf(project));
        if (!changedOnMap(node, updated)) continue;
        await model.nodes.put(projectId, [updated]);
        await markConflicts(projectId, updated);
        touched.push({ projectId, number: payload.issue.number });
      }
      if (event === 'pull_request' && ['opened', 'reopened', 'edited'].includes(payload.action) && payload.pull_request?.state === 'open') {
        for (const number of closedByOpenPrs([payload.pull_request])) {
          const node = await model.nodes.get(projectId, issueNodeId(number));
          if (!node || ['done', 'rejected', 'in_progress'].includes(node.status)) continue;
          await model.nodes.put(projectId, [{ ...node, status: 'in_progress', updatedAt: iso() }]);
          touched.push({ projectId, number });
        }
      }
    }
    return { handled: true, touched };
  }

  /** An open changeset that edits this item, from a version GitHub has now moved on from, needs a person. */
  async function markConflicts(projectId, node) {
    const key = itemKeyOf(node);
    const now = editableOf(node);
    for (const cs of await model.changesets.list(projectId)) {
      if (cs.status !== 'open') continue;
      let touched = false;
      for (const it of cs.items) {
        if (it.key === key && !it.conflict && !same(now, it.base) && !same(now, it.after)) {
          Object.assign(it, { conflict: true, theirs: now });
          touched = true;
        }
      }
      if (touched) await model.changesets.put(projectId, { ...cs, updatedAt: iso() });
    }
  }

  /** Map one project's repository again, as a refresh does, and report what it fixed. */
  async function reconcileProject(project, token) {
    const at = iso();
    const before = await model.projects.getWithNodes(project.id);
    const data = await importGitHub({ repo: project.githubRepo, token }, fetchImpl);
    const kept = keepPending(data.nodes, await model.nodes.pending(project.id), data.strictLifecycle);
    const old = new Map(before.nodes.map((n) => [n.id, n]));
    const fresh = new Map(kept.nodes.map((n) => [n.id, n]));
    const issues = (ids) => ids.filter((id) => id.startsWith('issue-')).map((id) => Number(id.slice(6))).sort((a, b) => a - b);
    const report = {
      at,
      repo: project.githubRepo,
      added: issues([...fresh.keys()].filter((id) => !old.has(id))),
      removed: issues([...old.keys()].filter((id) => !fresh.has(id))),
      changed: issues([...fresh.keys()].filter((id) => old.has(id) && changedOnMap(old.get(id), fresh.get(id)))),
      conflicts: kept.conflicts,
    };
    await model.nodes.replace(project.id, kept.nodes);
    await model.projects.put({ ...project, nodeCount: kept.nodes.length, strictLifecycle: data.strictLifecycle, updatedAt: at });
    await model.repos.link(project.githubRepo, project.id);
    report.sync = (await model.jobs.list(project.id)).length ? (await drain(project.id, { now: true })).status : 'nothing waiting';
    await model.audits.put(project.id, report);
    return report;
  }

  /** The nightly run: every project mapped from GitHub agrees with GitHub again, and each says what it fixed. */
  async function reconcile() {
    let token;
    try {
      token = await github.token?.();
    } catch (err) {
      log.warn?.(`reconcile: no App token (${err.message}); reading public repositories without one`);
    }
    const reports = [];
    for (const project of await model.projects.list()) {
      if (!project.githubRepo) continue;
      try {
        reports.push(await reconcileProject(project, token));
      } catch (err) {
        const report = { at: iso(), repo: project.githubRepo, error: err.message };
        await model.audits.put(project.id, report);
        reports.push(report);
      }
    }
    log.info?.(`reconcile: ${reports.map((r) => `${r.repo} ${r.error ? `failed: ${r.error}` : `+${r.added.length} -${r.removed.length} ~${r.changed.length}`}`).join('; ') || 'no GitHub projects'}`);
    return reports;
  }

  return { drain, onWebhook, reconcile };
}
