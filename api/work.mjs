// What counts as work for an agent, and what state each behaviour is in: the one place that decides it.
//
// #32 will give every behaviour an agreement state (needs improvement, ready for adoption, adopted) and a building
// state (new, being coded, coded). Until it's decided, this reads today's lifecycle (CONTRIBUTING.md):
//   adopted       the behaviours of an issue that is Ready and isn't an epic, and lists no open questions
//   new           adopted, and nobody holds a claim on it
//   being coded   a live claim (MCP-04)
//   coded         its issue is done and its proof passes (#21 PROVEN-01); that issue is a leaf, an independent unit of
//                 work (#32 STATE-02, STATE-08). With nothing viewable as proof it is unproven, not done (PROVEN-06), and
//                 when its proof fails it is broken, and work again until it passes (PROVEN-07). Proof comes from the
//                 latest coverage report (#20) and what the behaviour's line links to (shared/proof.js).
// Work is hierarchical: only leaves are offered (STATE-09). Every behaviour is a leaf, so a parent's own behaviours are
// work beside its children, and nothing ever needs a split first (#1 "Everything is a behaviour", replacing STATE-10).
// A behaviour with a test named by its ID on the default branch (#19) looks built: it is to verify, not offered.
// A new item in an open refinement (NEW-03) needs improvement, and is never work, until a person adopts it.
// When #32 lands, only this file changes.

import { editableOf, hasOpenQuestions, itemKeyOf, notWorkedOut, parseBehaviours, parseIssue, sectionText } from '../shared/issue-shape.js';
import { doneOf, proofOf } from '../shared/proof.js';

const NOT_WORK = new Set(['project', 'area', 'epic']);
const NOT_ITEMS = new Set(['project', 'area', 'behavior']); // places and spec rows: what an issue holds without being a parent
const FINISHED = new Set(['done', 'rejected']);
const PRIORITY = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** The item's key on the map: `issue-<n>` for an issue, `node-<id>` for anything made in Overworld. */
export const keyOf = itemKeyOf;

/** An item's behaviours with an ID, as { id, text }. One still in the Fog ("Not worked out yet") isn't buildable. */
export function behavioursOf(node) {
  const content = sectionText(parseIssue(editableOf(node).markdown), 'Behaviours');
  return parseBehaviours(content)
    .filter((r) => r.id)
    .map((r) => ({ id: r.id, text: r.raw.replace(/^\s*[-*]\s+/, '').replace(new RegExp(`^[*\`]*${r.id}[*\`:]*\\s*`), '').replace(/\s+/g, ' ').trim(), fog: notWorkedOut(r), raw: r.raw }));
}

/**
 * The behaviours each parent lists that a child issue stands for: a child whose Behaviours section holds exactly one row,
 * with an ID its parent lists too, is that behaviour's own node. It is offered and claimed there, once; the parent's row stays
 * in its text as the summary (#1 "Everything is a behaviour").
 * @returns {Map<string, Set<string>>} by parent id
 */
export function ownedByChildren(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map();
  for (const n of nodes) {
    const parent = n.parentId && byId.get(n.parentId);
    if (!parent || NOT_ITEMS.has(n.kind)) continue;
    const rows = behavioursOf(n);
    if (rows.length !== 1 || !behavioursOf(parent).some((b) => b.id === rows[0].id)) continue;
    if (!out.has(parent.id)) out.set(parent.id, new Set());
    out.get(parent.id).add(rows[0].id);
  }
  return out;
}

export const isFinished = (node) => FINISHED.has(node.status);

/** Is this item work an agent may pick up: adopted behaviours, nothing left undecided? A new item isn't in the spec until its refinement is adopted (NEW-03). */
export const isWork = (node) => node.status === 'ready' && !NOT_WORK.has(node.kind) && !node.refinement && !questionsOf(node);

/** Whether the item has open questions still listed: undecided, whatever its label says (#14 HANDOFF-12). */
const questionsOf = (node) => hasOpenQuestions(sectionText(parseIssue(editableOf(node).markdown), 'Open questions'));

/** Are this item's behaviours adopted: ready, or past it on the way to done? A test skeleton is written only for those (#23 SKETCH-01). */
export const isAdopted = (node) => ['ready', 'in_progress', 'review', 'blocked', 'done'].includes(node.status) && !NOT_WORK.has(node.kind) && !node.refinement;

/** Each item's child issues, by parent id. */
export function childrenOf(nodes) {
  const kids = new Map();
  for (const n of nodes) if (n.parentId && !NOT_ITEMS.has(n.kind)) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n]);
  return kids;
}

/** Unfinished items this one depends on: [{ key, title, state }]. */
export function blockersOf(node, byId) {
  return (node.links ?? [])
    .filter((l) => l.type === 'depends')
    .map((l) => byId.get(l.to))
    .filter((dep) => dep && !isFinished(dep))
    .map((dep) => ({ key: keyOf(dep), title: dep.title, state: stateOf(dep) }));
}

/**
 * What an unfinished item lacks before it can be built (#14 HANDOFF-03), in words a person reads on its card. Empty when
 * it is work, or when nothing it could be given would make it work (a place, a finished item, land mapped from code).
 * @param {{ kids?: object[], tested?: Set<string>, byId?: Map<string, object> }} o
 */
export function missingOf(node, { kids = [], tested = new Set(), byId = new Map() } = {}) {
  if (isFinished(node) || NOT_ITEMS.has(node.kind) || node.tags?.includes('code')) return [];
  const all = behavioursOf(node);
  const out = [];
  if (node.refinement) out.push('It is new in a refinement: a person adopts it first.');
  if (node.kind === 'epic') out.push("An epic isn't built itself: its child issues are.");
  const questions = questionsOf(node);
  if (questions) out.push('It has open questions to answer.');
  if (!node.refinement && node.kind !== 'epic' && node.status !== 'ready' && !questions) out.push(`It is ${stateOf(node).replace('_', ' ')}, not ready: its behaviours still need improvement, and adopting.`);
  if (!all.length && !kids.length) out.push('It has no behaviours yet: write them.');
  const foggy = all.filter((b) => b.fog).map((b) => b.id);
  if (foggy.length && foggy.length === all.length) out.push(`${foggy.join(', ')} ${foggy.length === 1 ? "isn't" : "aren't"} worked out yet.`);
  if (kids.length && !all.length && node.kind !== 'epic') out.push('Its child issues are the work: build those.');
  for (const b of blockersOf(node, byId)) out.push(`It waits on ${b.title} (${b.state.replace('_', ' ')}).`);
  const own = all.filter((b) => !b.fog);
  if (!out.length && own.length && own.every((b) => tested.has(b.id))) out.push('Every behaviour has a test: it is to verify, not to build.');
  return out;
}

/** An item's state, in words an agent reads. A new item in an open refinement needs improvement until it is adopted (NEW-03). */
export const stateOf = (node) => (node.refinement ? 'needs improvement' : node.status);

/** A behaviour's building state, proof included when there is a coverage report: coded, broken, unproven, being coded or new. */
export function buildingOf(node, claim, behaviour = null, report = null) {
  if (claim) return 'being coded';
  if (node.status !== 'done') return 'new';
  const done = behaviour ? doneOf(true, proofOf(behaviour.id, { report, raw: behaviour.raw })) : 'done';
  return done === 'done' ? 'coded' : done;
}

/** A done item's behaviours whose proof now fails (PROVEN-07): they are work again. */
export const brokenOf = (node, report) => (node.status === 'done' && report ? behavioursOf(node).filter((b) => !b.fog && doneOf(true, proofOf(b.id, { report, raw: b.raw })) === 'broken') : []);

/**
 * Work that is new and unclaimed, grouped by item: bugs first (REPORT-07), then by priority, then by number. Only leaves (STATE-09):
 * an item's own behaviours that have no test yet, whether or not it has children.
 * @param {Map<string, object>} live live claims by behaviour id
 * A done item whose proof now fails is offered again, its broken behaviours only, ahead of the rest (PROVEN-07).
 * @param {{ tested?: Iterable<string>, report?: object | null }} [o] behaviour ids with a test named by them on the default branch, and the latest coverage report
 * @returns {{ work: { item, title, priority, behaviours }[], blocked: { item, title, by }[], toVerify: { item, title, behaviours }[] }}
 */
export function nextWork(nodes, live, { tested = [], report = null } = {}) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const have = new Set(tested);
  const owned = ownedByChildren(nodes);
  const work = [];
  const blocked = [];
  const toVerify = []; // every behaviour has a test: ready to verify, not done (STATE-12)
  for (const node of nodes) {
    const broken = brokenOf(node, report).filter((b) => !live.has(b.id));
    if (broken.length) work.push({ item: keyOf(node), title: node.title, priority: node.priority || '', broken: true, behaviours: broken.map(({ id, text }) => ({ id, text })), order: node.order ?? 0 });
    if (!isWork(node)) continue;
    const own = behavioursOf(node).filter((b) => !b.fog && !owned.get(node.id)?.has(b.id));
    if (own.length && own.every((b) => have.has(b.id))) {
      toVerify.push({ item: keyOf(node), title: node.title, behaviours: own.map((b) => b.id) });
      continue;
    }
    const open = own.filter((b) => !have.has(b.id) && !live.has(b.id));
    if (!open.length) continue;
    const by = blockersOf(node, byId);
    const entry = { item: keyOf(node), title: node.title, priority: node.priority || '', behaviours: open.map(({ id, text }) => ({ id, text })) };
    if (by.length) blocked.push({ item: entry.item, title: entry.title, by });
    else work.push({ ...entry, order: node.order ?? 0, bug: node.kind === 'bug' });
  }
  // Something broken comes first: behaviours whose proof failed, then bugs, before any new feature (REPORT-07).
  work.sort((a, b) => Number(Boolean(b.broken)) - Number(Boolean(a.broken)) || Number(Boolean(b.bug)) - Number(Boolean(a.bug)) || (PRIORITY[a.priority] ?? 9) - (PRIORITY[b.priority] ?? 9) || a.order - b.order || a.item.localeCompare(b.item));
  return { work: work.map(({ order, bug, ...w }) => w), blocked, toVerify };
}
