// What counts as work for an agent, and what state each behaviour is in: the one place that decides it.
//
// #32 will give every behaviour an agreement state (needs improvement, ready for adoption, adopted) and a building
// state (new, being coded, coded). Until it's decided, this reads today's lifecycle (CONTRIBUTING.md):
//   adopted       the behaviours of an issue that is Ready and isn't an epic
//   new           adopted, and nobody holds a claim on it
//   being coded   a live claim (MCP-04)
//   coded         its issue is done
// When #32 lands, only this file changes.

import { editableOf, itemKeyOf, parseBehaviours, parseIssue, sectionText } from '../shared/issue-shape.js';

const NOT_WORK = new Set(['project', 'area', 'epic']);
const FOG = /^not worked out yet\b/i;
const FINISHED = new Set(['done', 'rejected']);
const PRIORITY = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** The item's key on the map: `issue-<n>` for an issue, `node-<id>` for anything made in Overworld. */
export const keyOf = itemKeyOf;

/** An item's behaviours with an ID, as { id, text }. One still in the Fog ("Not worked out yet") isn't buildable. */
export function behavioursOf(node) {
  const content = sectionText(parseIssue(editableOf(node).markdown), 'Behaviours');
  return parseBehaviours(content)
    .filter((r) => r.id)
    .map((r) => ({ id: r.id, text: r.raw.replace(/^\s*[-*]\s+/, '').replace(new RegExp(`^[*\`]*${r.id}[*\`:]*\\s*`), '').replace(/\s+/g, ' ').trim(), fog: FOG.test(r.text || r.given) }));
}

export const isFinished = (node) => FINISHED.has(node.status);

/** Is this item work an agent may pick up: adopted behaviours, nothing left undecided? */
export const isWork = (node) => node.status === 'ready' && !NOT_WORK.has(node.kind);

/** Unfinished items this one depends on: [{ key, title, state }]. */
export function blockersOf(node, byId) {
  return (node.links ?? [])
    .filter((l) => l.type === 'depends')
    .map((l) => byId.get(l.to))
    .filter((dep) => dep && !isFinished(dep))
    .map((dep) => ({ key: keyOf(dep), title: dep.title, state: stateOf(dep) }));
}

/** An item's state, in words an agent reads. */
export const stateOf = (node) => node.status;

/** A behaviour's building state. */
export function buildingOf(node, claim) {
  if (node.status === 'done') return 'coded';
  return claim ? 'being coded' : 'new';
}

/**
 * Work that is new and unclaimed, grouped by item and ordered by priority, then by number.
 * @param {Map<string, object>} live live claims by behaviour id
 * @returns {{ work: { item, title, priority, behaviours }[], blocked: { item, title, by }[] }}
 */
export function nextWork(nodes, live) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const work = [];
  const blocked = [];
  for (const node of nodes) {
    if (!isWork(node)) continue;
    const open = behavioursOf(node).filter((b) => !b.fog && !live.has(b.id));
    if (!open.length) continue;
    const by = blockersOf(node, byId);
    const entry = { item: keyOf(node), title: node.title, priority: node.priority || '', behaviours: open.map(({ id, text }) => ({ id, text })) };
    if (by.length) blocked.push({ item: entry.item, title: entry.title, by });
    else work.push({ ...entry, order: node.order ?? 0 });
  }
  work.sort((a, b) => (PRIORITY[a.priority] ?? 9) - (PRIORITY[b.priority] ?? 9) || a.order - b.order || a.item.localeCompare(b.item));
  return { work: work.map(({ order, ...w }) => w), blocked };
}
