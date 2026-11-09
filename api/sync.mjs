// Sync with a project's store (#3). Overworld is where people and agents work; the store (GitHub first) is
// the permanent record. Sync reaches it only through Overworld's store API (api/stores/), so every
// behaviour here holds for any store that implements it (SYNC-14).
//
// Work in progress stays here. Only a save reaches the store (SYNC-07), and a save decides nothing: it takes
// each unsaved item as it is at that moment, state included, and queues it to be written (SYNC-08).
//
//   edit     accepting a changeset, or changing an item on the map, marks it unsaved, remembering the
//            version the store had (its base)
//   save     saveNow(): the one path every trigger calls. Each unsaved item's snapshot and its job (the
//            outbox) are written in one transaction; an item saved again before it was written replaces
//            its job, so the store gets one write of the latest version (SYNC-09)
//   drain    takes a project's jobs to the store in the order saved, under a lease so only one worker runs.
//            Each item is checked against the store before it is written, so a worker that dies part-way
//            through is simply run again. Writes keep to a budget well under the store's limits (SYNC-10);
//            the store slow, down or refusing for load anyway: the job books its own retry (SYNC-02)
//   events   an item edited in the store updates its place on the map at once (SYNC-03)
//   reconcile  nightly: maps each project from its store again, so a missed event can't leave drift (SYNC-04)
//
// Sync never merges or chooses between versions. An item that changed in the store since it was last read is
// written nothing; the map shows the store's version and the item goes back to a person as a conflict (SYNC-06).
//
// A node's sync state, kept on the node so the map can badge it (SYNC-11):
//   sync      'unsaved' | 'saving' | 'conflict' | 'failed' (absent: in line with the store)
//   base      the version the store had when the item was last read
//   saved     the version last saved, while it is on its way
//   conflict  { ours, theirs } for a person to resolve;  syncError  why the store refused it

import { randomUUID } from 'node:crypto';
import { editableOf, itemKeyOf } from '../shared/issue-shape.js';
import { PermanentError } from './stores/errors.mjs';
import { same } from './edits.mjs';

const LEASE_MS = 120_000; // longer than one Lambda run (30 s), so a lease outlives its worker only briefly
const BACKOFF_MINUTES = [1, 5, 30, 120, 360, 720, 1440]; // then daily; the nightly reconciliation also retries
// Each store says how many writes it takes (store.writeBudget); this is for one that doesn't.
const WRITE_BUDGET = { perMinute: 20, perHour: 150 };
const GUARD = 'overworld-new-item';
const NEW_REF = /#new-([\w-]+)\b/g; // how an item refers to another made in Overworld and not yet in the store
const SYNC_FIELDS = ['sync', 'base', 'saved', 'savedAt', 'conflict', 'syncError'];

/** Not an error: the write budget is spent, so this waits until `retryAt`. */
class OverBudget extends Error {
  constructor(retryAt) {
    super('write budget spent');
    this.retryAt = retryAt;
  }
}

const inLine = (node) => Object.fromEntries(Object.entries(node).filter(([k]) => !SYNC_FIELDS.includes(k)));
/** A job's key: the item's key on the map, or new-<node id> for one made here, on its way into the store. */
const jobKeyOf = (store, node) => (store.refOf(node) ? itemKeyOf(node) : `new-${node.id}`);

/**
 * An item changed in Overworld: from now on it is unsaved, until a save takes it to the store (SYNC-07).
 * @param {object|null} store the project's store; a project without one has nowhere to save to
 */
export function markEdited(before, after, store) {
  if (!store?.refOf(before)) return after;
  const waiting = ['unsaved', 'saving', 'failed'].includes(before.sync);
  return { ...inLine(after), sync: 'unsaved', base: waiting ? before.base : store.asRead(before), ...(before.saved ? { saved: before.saved, savedAt: before.savedAt } : {}) };
}

/**
 * Save now: every unsaved item of the project (or just `keys`) goes into the outbox as it is. The one path
 * every save trigger calls: a person's Save button today, Overworld's own triggers later.
 * @returns {Promise<{ saved: string[] }>} the item keys saved
 */
export async function saveNow({ model, stores }, projectId, { keys = null, now = new Date().toISOString() } = {}) {
  const store = stores.forProject(await model.projects.get(projectId));
  if (!store) return { saved: [] };
  const chosen = (await model.nodes.pending(projectId)).filter((n) => ['unsaved', 'failed'].includes(n.sync) && (!keys || keys.includes(itemKeyOf(n))));
  const waiting = await model.jobs.list(projectId);
  const saves = chosen.map((node) => {
    const key = jobKeyOf(store, node);
    const after = store.wanted(node);
    const job = { id: `${now}#${key}`, key, nodeId: node.id, ref: store.refOf(node), base: node.base ?? null, after, epic: /^Kind:\s*Epic\b/im.test(after.markdown), savedAt: now, attempts: 0 };
    const replaces = waiting.find((j) => j.key === key && j.id !== job.id);
    return { node: { ...inLine(node), sync: 'saving', base: node.base, saved: after, savedAt: now }, job, replaces };
  });
  await model.jobs.save(projectId, saves);
  return { saved: saves.map((s) => s.job.key) };
}

/**
 * The store's latest version of an item (`fresh`, as the map reads it) meets the map's (`old`). An item not
 * waiting for the store just takes its version. One waiting keeps its edits while the store still holds what it
 * started from, or what was last saved; anything else is a change made in the store, and a conflict.
 */
export function settle(old, fresh, store) {
  if (!old.sync) return fresh;
  const theirs = store.asRead(fresh);
  if (old.sync === 'conflict') return { ...fresh, sync: 'conflict', conflict: { ...old.conflict, theirs } };
  if (store.same(theirs, store.wanted(old))) return fresh; // already there
  if (old.base && store.same(theirs, old.base)) return old;
  if (old.saved && store.same(theirs, old.saved)) return { ...old, base: old.saved }; // our save arrived; later edits still wait
  return { ...fresh, sync: 'conflict', conflict: { ours: store.wanted(old), theirs } };
}

/**
 * After the project is read from its store again: items still waiting keep their edits, or become conflicts.
 * Read from the pending index, not the map. Items made here that aren't in the store yet stay on the map.
 * @returns {{ nodes: object[], conflicts: string[] }}
 */
export function keepPending(freshNodes, pending, store) {
  const byId = new Map(freshNodes.map((n) => [n.id, n]));
  const conflicts = [];
  for (const old of pending) {
    const fresh = byId.get(old.id);
    const kept = fresh ? settle(old, fresh, store) : old;
    if (kept.sync === 'conflict' && old.sync !== 'conflict') conflicts.push(itemKeyOf(old));
    byId.set(old.id, kept);
  }
  return { nodes: [...byId.values()], conflicts };
}

const changedOnMap = (a, b) => a.title !== b.title || a.body !== b.body || a.status !== b.status || a.definition !== b.definition || String(a.tags) !== String(b.tags) || a.sync !== b.sync;

/**
 * @param {object} o
 * @param {object} o.model
 * @param {{ forProject(project): object|null }} o.stores each project's store (api/stores/index.mjs), or a test's
 * @param {(projectId: string, at: string) => Promise<void>} o.schedule books a run of drain(projectId) at `at`
 * @param {() => Date} [o.clock]
 * @param {{ perMinute: number, perHour: number }} [o.budget] in place of each store's own write budget
 */
export function createSync({ model, stores, schedule = async () => {}, log = console, clock = () => new Date(), budget = null }) {
  const iso = (ms = clock().getTime()) => new Date(ms).toISOString();

  /** Spend one write from the project's budget, or say when the next one is free. */
  async function spend(projectId, store) {
    const { perMinute, perHour } = budget ?? store.writeBudget ?? WRITE_BUDGET;
    const t = clock().getTime();
    const writes = (await model.budgets.get(projectId)).filter((w) => Date.parse(w) > t - 3_600_000);
    const lastMinute = writes.filter((w) => Date.parse(w) > t - 60_000);
    if (lastMinute.length >= perMinute) throw new OverBudget(iso(Date.parse(lastMinute[0]) + 60_000));
    if (writes.length >= perHour) throw new OverBudget(iso(Date.parse(writes[0]) + 3_600_000));
    await model.budgets.put(projectId, [...writes, iso(t)]);
  }

  /** References to items made here that are now in the store become the store's own references. */
  async function withRefs(projectId, store, text) {
    const mentions = new Map();
    for (const [, id] of text.matchAll(NEW_REF)) {
      const node = await model.nodes.get(projectId, id);
      const ref = node && store.refOf(node);
      if (ref) mentions.set(id, store.mention(ref));
    }
    return text.replace(NEW_REF, (whole, id) => mentions.get(id) ?? whole);
  }

  /** Take one saved item to the store, and say what happened. A new item's create is written down first, so a crash can't make two. */
  async function syncItem(projectId, store, job) {
    const guard = `${GUARD}:${job.key}`;
    const want = { ...job.after, markdown: await withRefs(projectId, store, job.after.markdown) };
    let ref = job.ref;
    try {
      if (!ref) {
        // A create may have reached the store just before a crash. Find it rather than make a second one (NEW-04).
        const found = job.creating && (await store.findCreated(guard, iso(Date.parse(job.creating) - 60_000)));
        if (found) ref = found.ref;
        else {
          await spend(projectId, store);
          await model.jobs.put(projectId, { ...job, creating: iso() });
          ref = (await store.create(want, { guard, epic: job.epic })).ref;
        }
        await model.jobs.put(projectId, { ...job, ref });
      }
      const item = await store.read(ref);
      const theirs = store.version(item);
      const guarded = store.carriesGuard(item, guard); // a new item still carrying its guard needs one more write, to drop it
      if (store.same(theirs, want) && !guarded) return { outcome: 'written', ref, want }; // already there: a retry after a crash, or the same edit made twice
      const node = await model.nodes.get(projectId, job.nodeId);
      const untouched = (job.base && store.same(theirs, job.base)) || (node?.base && store.same(theirs, node.base)) || guarded;
      if (!untouched) return { outcome: 'conflict', ref, want, item, theirs };
      await spend(projectId, store);
      await store.update(ref, item, want);
      return { outcome: 'written', ref, want };
    } catch (err) {
      if (!(err instanceof PermanentError)) throw err; // the store down or over budget: later. Anything else: a crash, so resume
      return { outcome: 'failed', ref, error: err.message };
    }
  }

  /** A job done: its node says so, and later saves of the same item start from what the store now holds. */
  async function finish(projectId, store, job, result, waiting) {
    const node = await model.nodes.get(projectId, job.nodeId);
    const later = waiting.filter((j) => j.key === job.key && j.id !== job.id);
    // An item made here is now that item in the store. (Its node keeps its id; mapping the project again renames it.)
    const placed = node && result.ref && !store.refOf(node) ? store.placed(node, result.ref) : node;
    let next = null;
    if (node && result.outcome === 'written') {
      const current = !node.sync || (node.sync === 'saving' && node.savedAt === job.savedAt);
      next = current ? inLine(placed) : { ...placed, base: result.want };
    } else if (node && result.outcome === 'conflict') {
      next = { ...store.onMap(inLine(node), result.item), updatedAt: iso(), sync: 'conflict', conflict: { ours: store.wanted(node), theirs: result.theirs } };
    } else if (node && result.outcome === 'failed') {
      next = { ...placed, sync: 'failed', syncError: result.error };
    }
    const rebased = result.outcome === 'written' ? later.map((j) => ({ ...j, base: result.want, ref: result.ref })) : [];
    await model.jobs.finish(projectId, job, { node: next, rebased });
    if (result.outcome !== 'written') for (const j of later) await model.jobs.finish(projectId, j); // a person decides this item now
  }

  /** The job as it is stored now (a crash-guard may have been written into it), or null if a later save replaced it. */
  const latest = async (projectId, job) => (await model.jobs.list(projectId)).find((j) => j.id === job.id) ?? null;

  /**
   * Take a project's saved items to its store, new items first, then in the order saved. A job that can't go yet holds back the ones after it.
   * @param {{ now?: boolean }} [opts] now: don't wait for a booked retry (a person pressed Retry, or the nightly run)
   */
  async function drain(projectId, { now = false } = {}) {
    const store = stores.forProject(await model.projects.get(projectId));
    if (!store) return { status: 'no store' };
    const owner = randomUUID();
    if (!(await model.leases.claim(projectId, owner, iso(clock().getTime() + LEASE_MS), iso()))) {
      // Someone else is syncing. If they finish just before this job landed, the booked retry picks it up.
      await schedule(projectId, iso(clock().getTime() + 60_000));
      return { status: 'busy' };
    }
    const next = async () => {
      const all = await model.jobs.list(projectId);
      return { all, job: all.find((j) => !j.ref) ?? all[0] };
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
          result = await syncItem(projectId, store, job);
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
        await finish(projectId, store, job, result, all);
      }
      return { status: 'synced' };
    } finally {
      await model.leases.release(projectId, owner);
    }
  }

  /** Events from a store (its key, and what happened to which items), already verified. The map follows at once. */
  async function onEvents(key, events) {
    const touched = [];
    for (const projectId of await model.links.projectsOf(key)) {
      const project = await model.projects.get(projectId);
      const store = stores.forProject(project);
      if (!store) {
        await model.links.unlink(key, projectId);
        continue;
      }
      for (const ev of events) {
        const node = await model.nodes.get(projectId, store.nodeIdOf(ev.ref));
        if (!node) continue; // not on this map yet: the nightly reconciliation places it
        if (ev.type === 'changed') {
          const updated = settle(node, { ...store.onMap(inLine(node), ev.item), updatedAt: iso() }, store);
          if (!changedOnMap(node, updated)) continue;
          await model.nodes.put(projectId, [updated]);
          await markConflicts(projectId, updated);
        } else if (ev.type === 'started') {
          if (['done', 'rejected', 'in_progress'].includes(node.status)) continue;
          await model.nodes.put(projectId, [{ ...node, status: 'in_progress', updatedAt: iso() }]);
        } else continue;
        touched.push({ projectId, ref: ev.ref });
      }
    }
    return { handled: true, touched };
  }

  /** An open changeset that edits this item, from a version the store has now moved on from, needs a person. */
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

  /** Map one project from its store again, as a refresh does, and report what it fixed. */
  async function reconcileProject(project, store) {
    const at = iso();
    const before = await model.projects.getWithNodes(project.id);
    const data = await store.mapAgain();
    const kept = keepPending(data.nodes, await model.nodes.pending(project.id), store);
    const old = new Map(before.nodes.map((n) => [n.id, n]));
    const fresh = new Map(kept.nodes.map((n) => [n.id, n]));
    const refs = (ids, from) => ids.map((id) => store.refOf(from.get(id))).filter(Boolean).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    const report = {
      at,
      store: store.key,
      added: refs([...fresh.keys()].filter((id) => !old.has(id)), fresh),
      removed: refs([...old.keys()].filter((id) => !fresh.has(id)), old),
      changed: refs([...fresh.keys()].filter((id) => old.has(id) && changedOnMap(old.get(id), fresh.get(id))), fresh),
      conflicts: kept.conflicts,
    };
    await model.nodes.replace(project.id, kept.nodes);
    await model.projects.put({ ...project, ...data.project, nodeCount: kept.nodes.length, updatedAt: at });
    await model.links.link(store.key, project.id);
    report.sync = (await model.jobs.list(project.id)).length ? (await drain(project.id, { now: true })).status : 'nothing waiting';
    await model.audits.put(project.id, report);
    return report;
  }

  /** The nightly run: every project with a store agrees with it again, and each says what it fixed. */
  async function reconcile() {
    const reports = [];
    for (const project of await model.projects.list()) {
      const store = stores.forProject(project);
      if (!store) continue;
      try {
        reports.push(await reconcileProject(project, store));
      } catch (err) {
        const report = { at: iso(), store: store.key, error: err.message };
        await model.audits.put(project.id, report);
        reports.push(report);
      }
    }
    log.info?.(`reconcile: ${reports.map((r) => `${r.store} ${r.error ? `failed: ${r.error}` : `+${r.added.length} -${r.removed.length} ~${r.changed.length}`}`).join('; ') || 'no projects in a store'}`);
    return reports;
  }

  return { drain, onEvents, reconcile };
}
