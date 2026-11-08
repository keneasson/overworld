// Sync with GitHub (#3). GitHub is the data store; conflicts are resolved in the editor.
//
// Sync never merges or chooses between versions. It writes what a person accepted, and only over the
// version they started from. An item that changed on GitHub since then is written nothing, and goes
// back to the editor as a conflict (SYNC-06).
//
//   accept   writes the changeset and a job (the outbox) in one transaction
//   drain    takes a project's jobs to GitHub, oldest first, under a lease so only one worker runs.
//            Each item is checked against GitHub before it is written, so a worker that dies part-way
//            through is simply run again: what already arrived is recognised and not written twice.
//            GitHub slow, down or rate-limited: the job waits and books its own retry (SYNC-02).
//   webhook  an issue edited on GitHub updates its place on the map at once (SYNC-03)
//   reconcile  nightly: maps each repository again, so a missed webhook can't leave drift (SYNC-04)

import { randomUUID } from 'node:crypto';
import { editableOf, splitNote } from '../shared/issue-shape.js';
import { fromRest, importGitHub } from './github.mjs';
import { PermanentError } from './github-app.mjs';
import { closedByOpenPrs } from './engine/lifecycle.mjs';
import { issueFields, issueNodeId } from './engine/project.mjs';
import { keepPendingEdits, same } from './edits.mjs';

const LEASE_MS = 120_000; // longer than one Lambda run (30 s), so a lease outlives its worker only briefly
const BACKOFF_MINUTES = [1, 5, 30, 120, 360, 720, 1440]; // then daily; the nightly reconciliation also retries
const MARKER = 'overworld-new-item';
const NEW_REF = /#(new-[\w-]+)\b/g;
const PLACEMENT_TAGS = new Set(['placed-by-words', 'unplaced']);

/** An edit's or a new item's text, with references to new items in the same changeset pointing at their issue numbers. */
const withNumbers = (text, numbers) => text.replace(NEW_REF, (ref, key) => (numbers.has(key) ? `#${numbers.get(key)}` : ref));
const versionOf = (gh) => ({ title: gh.title, markdown: gh.body ?? '' });

/** A node with what GitHub now says about its issue, keeping where it sits on the map and why. */
export function mapIssueOnto(node, ghIssue, { strict = true, now = new Date().toISOString() } = {}) {
  const issue = fromRest(ghIssue);
  const note = splitNote(node.body ?? '').note.replace(/^\s*---\s*📍\s*/, '').replace(/ Status unclear: [^.]*\.$/, '');
  const placement = (node.tags ?? []).filter((t) => PLACEMENT_TAGS.has(t));
  // A pull request that closes the issue keeps it in progress; webhooks about the issue don't say so, so keep what the map knew.
  const inProgress = node.status === 'in_progress' && issue.state === 'open' ? new Set([issue.number]) : new Set();
  return { ...node, ...issueFields(issue, { lifecycle: { strict, inProgress }, note, placement, kind: node.kind }), updatedAt: now };
}

const changedOnMap = (a, b) => a.title !== b.title || a.body !== b.body || a.status !== b.status || a.definition !== b.definition || String(a.tags) !== String(b.tags);

/**
 * @param {object} o
 * @param {object} o.model
 * @param {object} o.github the GitHub App client (api/github-app.mjs), or a test's stand-in
 * @param {(projectId: string, at: string) => Promise<void>} o.schedule books a run of drain(projectId) at `at`
 * @param {() => Date} [o.clock]
 */
export function createSync({ model, github, schedule = async () => {}, fetchImpl = fetch, log = console, clock = () => new Date() }) {
  const iso = (ms = clock().getTime()) => new Date(ms).toISOString();

  /** Take one changeset's items to GitHub. Progress is saved after every item, so a crash resumes where it stopped. */
  async function syncChangeset(projectId, repo, cs) {
    const save = () => model.changesets.put(projectId, cs);
    const numbers = new Map(cs.items.filter((it) => it.number).map((it) => [it.key, it.number]));

    // New items first, so every other item can point at their numbers (NEW-04).
    for (const it of cs.items.filter((x) => x.key.startsWith('new-') && !x.number && !x.failed)) {
      const marker = `<!-- ${MARKER}:${it.key} -->`;
      try {
        if (it.creating) {
          // A create may have reached GitHub just before a crash. Find it rather than create a second one.
          const found = await github.findCreated(repo, marker, new Date(Date.parse(it.creating) - 60_000).toISOString());
          if (found) {
            Object.assign(it, { number: found.number });
            numbers.set(it.key, found.number);
            await save();
            continue;
          }
        }
        it.creating = iso();
        await save();
        const labels = ['status:draft', ...(/^Kind:\s*Epic\b/im.test(it.after.markdown) ? ['epic'] : [])];
        const created = await github.createIssue(repo, { title: it.after.title, body: `${withNumbers(it.after.markdown, numbers)}\n\n${marker}`, labels });
        Object.assign(it, { number: created.number });
        numbers.set(it.key, created.number);
        await save();
      } catch (err) {
        if (!(err instanceof PermanentError)) throw err; // GitHub down: retry later. Anything else: a crash, so resume
        Object.assign(it, { failed: err.message });
        await save();
      }
    }

    // Then every item's final text: edits over the version they started from, and new items without their marker.
    for (const it of cs.items) {
      if (it.synced || it.conflict || it.failed) continue;
      const number = it.key.startsWith('issue-') ? Number(it.key.slice(6)) : it.number;
      if (!number) continue; // made on the map, not on GitHub: nothing to send
      const want = { title: it.after.title, markdown: withNumbers(it.after.markdown, numbers) };
      try {
        const gh = await github.getIssue(repo, number);
        const theirs = versionOf(gh);
        if (same(theirs, want)) it.synced = true; // already there: a retry after a crash, or someone made the same edit
        else if (it.key.startsWith('new-') ? theirs.markdown.includes(`<!-- ${MARKER}:${it.key} -->`) : same(theirs, it.base)) {
          await github.updateIssue(repo, number, { title: want.title, body: want.markdown });
          it.synced = true;
        } else {
          // Changed on GitHub since it was accepted: write nothing, show theirs on the map, and hand it back to a person.
          Object.assign(it, { conflict: true, theirs });
          await showOnMap(projectId, gh);
        }
      } catch (err) {
        if (!(err instanceof PermanentError)) throw err;
        it.failed = err.message; // no such issue, no access, a rejected edit: retrying won't help, so a person sees it
      }
      await save();
    }
    return cs.items.some((it) => it.conflict) ? 'conflict' : cs.items.some((it) => it.failed) ? 'failed' : 'synced';
  }

  async function showOnMap(projectId, gh) {
    const node = await model.nodes.get(projectId, issueNodeId(gh.number));
    if (!node) return;
    const project = await model.projects.get(projectId);
    const updated = mapIssueOnto(node, gh, { strict: project?.strictLifecycle !== false, now: iso() });
    if (changedOnMap(node, updated)) await model.nodes.put(projectId, [updated]);
  }

  /**
   * Take a project's waiting jobs to GitHub, oldest first. A job that can't go yet holds back the ones after it, so edits arrive in order.
   * @param {{ now?: boolean }} [opts] now: don't wait for a booked retry (a person pressed Retry, or the nightly run)
   */
  async function drain(projectId, { now = false } = {}) {
    const owner = randomUUID();
    if (!(await model.leases.claim(projectId, owner, iso(clock().getTime() + LEASE_MS), iso()))) {
      // Someone else is syncing. If they finish just before this job landed, the booked retry picks it up.
      await schedule(projectId, iso(clock().getTime() + 60_000));
      return { status: 'busy' };
    }
    try {
      // Jobs accepted while this runs join the end of the line: list again until none are left.
      for (let job = (await model.jobs.list(projectId))[0]; job; job = (await model.jobs.list(projectId))[0]) {
        if (!now && job.nextAttemptAt && job.nextAttemptAt > iso()) {
          await schedule(projectId, job.nextAttemptAt);
          return { status: 'waiting', until: job.nextAttemptAt };
        }
        const cs = await model.changesets.get(projectId, job.changesetId);
        let outcome;
        try {
          outcome = cs ? await syncChangeset(projectId, job.repo, cs) : null;
        } catch (err) {
          if (!err.transient) throw err;
          const attempts = (job.attempts ?? 0) + 1;
          const backoff = clock().getTime() + BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length) - 1] * 60_000;
          const nextAttemptAt = iso(Math.max(backoff, err.retryAt ? Date.parse(err.retryAt) : 0));
          await model.jobs.put(projectId, { ...job, attempts, nextAttemptAt, lastError: err.message });
          await schedule(projectId, nextAttemptAt);
          log.warn?.(`sync ${projectId}: ${err.message}; next try ${nextAttemptAt}`);
          return { status: 'retrying', until: nextAttemptAt };
        }
        await model.jobs.finish(projectId, job, cs && { ...cs, sync: outcome, syncedAt: iso() });
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
        const updated = mapIssueOnto(node, payload.issue, { strict: project.strictLifecycle !== false, now: iso() });
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
    const key = `issue-${node.url.split('/').pop()}`;
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
    const kept = keepPendingEdits(data.nodes, await model.changesets.list(project.id), at);
    const old = new Map(before.nodes.map((n) => [n.id, n]));
    const fresh = new Map(kept.nodes.map((n) => [n.id, n]));
    const issues = (ids) => ids.filter((id) => id.startsWith('issue-')).map((id) => Number(id.slice(6))).sort((a, b) => a - b);
    const report = {
      at,
      repo: project.githubRepo,
      added: issues([...fresh.keys()].filter((id) => !old.has(id))),
      removed: issues([...old.keys()].filter((id) => !fresh.has(id))),
      changed: issues([...fresh.keys()].filter((id) => old.has(id) && changedOnMap(old.get(id), fresh.get(id)))),
      conflicts: kept.changed.flatMap((cs) => cs.items.filter((it) => it.conflict).map((it) => it.key)),
    };
    await model.nodes.replace(project.id, kept.nodes);
    for (const cs of kept.changed) await model.changesets.put(project.id, cs);
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
