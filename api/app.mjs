// HTTP-agnostic API. `handle({ method, path, headers, body })` -> { status, body }.
// Used by the Lambda handler in AWS and by the Vite dev server locally.

import { createHash, timingSafeEqual } from 'node:crypto';
import { KINDS, ROOT_ID, ValidationError, newId, sanitizeNode } from '../shared/schema.js';
import { issueOf, newItemMarkdown, parseIssue, placeOf, writeIssue } from '../shared/issue-shape.js';
import { demoProject } from './seed.mjs';
import { importGitHub } from './github.mjs';
import { applyTo, conflictsOf, editableOf, findItem, itemKeyOf, same } from './edits.mjs';
import { keepPending, markEdited, saveNow } from './sync.mjs';
import { createStores } from './stores/index.mjs';
import { eventsFromWebhook, signedByGitHub } from './stores/github/index.mjs';
import { answerPrompt, settleAnswers } from './answers.mjs';
import { NOTE_KINDS, NOTE_KIND_LABEL, annotationOf, answers, cleanAnchor, isPlain, isQuestion, kindOf, mentionsOf, openByItem, readsFor, whereOf } from '../shared/annotations.js';
import { addresseesOf, settleNotes } from './notes.mjs';
import { createAgents } from './agents.mjs';
import { createMcp } from './mcp.mjs';
import { openQuestions } from './engine/lifecycle.mjs';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const digest = (s) => createHash('sha256').update(String(s)).digest();

/**
 * @param {object} [o.sync] sync with each project's store (api/sync.mjs); without it, saved items wait in the outbox
 * @param {object} [o.stores] each project's store (api/stores/index.mjs)
 * @param {() => Promise<string>} [o.webhookSecret] the GitHub App's webhook secret
 * @param {(projectId: string) => void} [o.onSaved] runs after a save: in AWS the table's stream wakes the worker instead
 * @param {() => number} [o.clock] the time, in milliseconds: agents' claims, limits and standups, and comments' times, run on it
 * @param {number} [o.agentCallsPerMinute] each agent's limit on MCP tool calls
 */
export function createApi({ model, accessKey = '', fetchImpl = fetch, log = console, sync = null, stores = createStores({ fetchImpl }), webhookSecret = null, onSaved = null, clock = Date.now, agentCallsPerMinute }) {
  const expected = accessKey ? digest(accessKey) : null;
  const agents = createAgents({ model, clock, callsPerMinute: agentCallsPerMinute });

  function authorize(headers) {
    if (!expected) return;
    const given = headers['x-projectmap-key'] ?? headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
    if (!given || !timingSafeEqual(digest(given), expected)) throw new HttpError(401, 'Access key required');
  }

  async function loadProject(id) {
    const data = await model.projects.getWithNodes(id);
    if (!data) throw new HttpError(404, 'Project not found');
    return data;
  }

  async function touchProject(project, nodes, extra = {}) {
    const root = nodes.find((n) => n.id === ROOT_ID);
    const updated = {
      ...project,
      ...extra,
      title: root?.title ?? project.title,
      summary: root?.summary ?? project.summary,
      nodeCount: nodes.length,
      updatedAt: new Date().toISOString(),
    };
    await model.projects.put(updated);
    return updated;
  }

  async function saveNewProject({ title, summary, nodes }, source, extra = {}) {
    const now = new Date().toISOString();
    const project = { id: newId(), title, summary, source, ...extra, createdAt: now, updatedAt: now, nodeCount: nodes.length };
    await model.nodes.put(project.id, nodes);
    await model.projects.put(project);
    return { project, nodes };
  }

  function blankProject(title, summary) {
    const now = new Date().toISOString();
    const root = { ...sanitizeNode({ title, summary, kind: 'project', status: 'planned' }), id: ROOT_ID, parentId: null, createdAt: now, updatedAt: now };
    return { title: root.title, summary: root.summary, nodes: [root] };
  }

  /** Accept an exported project (or any {nodes:[...]}) and normalise ids, parents and links. */
  function fromImport(body) {
    const input = Array.isArray(body?.nodes) ? body.nodes : null;
    if (!input?.length) throw new ValidationError('nodes: expected a non-empty array');
    if (input.length > 5000) throw new ValidationError('nodes: at most 5000 per project');
    const now = new Date().toISOString();
    const rootIn = input.find((n) => n.id === ROOT_ID) ?? input.find((n) => !n.parentId) ?? input[0];
    const fresh = new Map(input.map((n) => [n, n === rootIn ? ROOT_ID : newId()]));
    const ids = new Map(input.filter((n) => n.id != null).map((n) => [n.id, fresh.get(n)]));
    const nodes = input.map((n) => {
      const clean = sanitizeNode({ ...n, parentId: null, links: [] });
      const isRoot = n === rootIn;
      return {
        ...clean,
        id: fresh.get(n),
        kind: isRoot ? 'project' : clean.kind === 'project' ? 'area' : clean.kind,
        parentId: isRoot ? null : (ids.get(n.parentId) ?? ROOT_ID),
        links: sanitizeNode({ links: (n.links ?? []).map((l) => ({ ...l, to: ids.get(l.to) })).filter((l) => l.to) }, { partial: true }).links,
        createdAt: n.createdAt ?? now,
        updatedAt: now,
      };
    });
    const root = nodes.find((n) => n.id === ROOT_ID);
    return { title: body.project?.title ?? root.title, summary: body.project?.summary ?? root.summary, nodes };
  }

  function subtreeIds(nodes, id) {
    const children = new Map();
    for (const n of nodes) {
      if (!children.has(n.parentId)) children.set(n.parentId, []);
      children.get(n.parentId).push(n.id);
    }
    const out = [];
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      out.push(cur);
      stack.push(...(children.get(cur) ?? []));
    }
    return out;
  }

  const KEY = /^(issue-\d+|node-[\w-]+)$/;
  // Comment ids start with the time, so a thread sorts in order; never reuse a millisecond.
  let lastMs = 0;
  const commentId = () => {
    lastMs = Math.max(Date.now(), lastMs + 1);
    return `${lastMs.toString(36).padStart(9, '0')}${newId().slice(0, 4)}`;
  };
  const author = (v) => String(v ?? '').trim().slice(0, 80) || 'Someone';
  const text = (v, max, what) => {
    if (typeof v !== 'string') throw new ValidationError(`${what}: expected text`);
    if (v.length > max) throw new ValidationError(`${what}: at most ${max} characters`);
    return v;
  };
  const version = (v, what) => ({ title: text(v?.title ?? '', 200, `${what}.title`).trim(), markdown: text(v?.markdown ?? '', 19000, `${what}.markdown`) });

  async function loadChangeset(pid, cid, { open = false } = {}) {
    const cs = await model.changesets.get(pid, cid);
    if (!cs) throw new HttpError(404, 'Changeset not found');
    if (open && cs.status !== 'open') throw new HttpError(409, `This changeset was already ${cs.status}`);
    return cs;
  }

  /**
   * Drop a refinement's new items, and anything inside them: they never reach the store (NEW-06).
   * @returns {Promise<{ deleted: string[], updated: object[] }>}
   */
  async function dropNew(pid, nodes, ids) {
    const doomed = new Set(ids.flatMap((id) => (nodes.some((n) => n.id === id) ? subtreeIds(nodes, id) : [])));
    if (!doomed.size) return { deleted: [], updated: [] };
    return removeNodes(pid, nodes, doomed);
  }

  /** Delete nodes, the links to them, and any refinement's mention of them. */
  async function removeNodes(pid, nodes, doomed) {
    await model.nodes.delete(pid, [...doomed]);
    const now = new Date().toISOString();
    const updated = nodes
      .filter((n) => !doomed.has(n.id) && n.links?.some((l) => doomed.has(l.to)))
      .map((n) => ({ ...n, links: n.links.filter((l) => !doomed.has(l.to)), updatedAt: now }));
    if (updated.length) await model.nodes.put(pid, updated);
    const gone = new Set(nodes.filter((n) => doomed.has(n.id)).map(itemKeyOf));
    for (const cs of await model.changesets.list(pid)) {
      if (cs.status !== 'open' || !cs.items.some((it) => it.new && gone.has(it.key))) continue;
      await model.changesets.put(pid, { ...cs, items: cs.items.filter((it) => !(it.new && gone.has(it.key))), updatedAt: now });
    }
    const { project } = await loadProject(pid);
    await touchProject(project, nodes.filter((n) => !doomed.has(n.id)).map((n) => updated.find((u) => u.id === n.id) ?? n));
    return { deleted: [...doomed], updated };
  }

  /** How a new item's head names its parent: the store's mention, an issue number, #new-<id> for one made here, or nothing for a plain area. */
  function partOf(store, parent) {
    const ref = store?.refOf(parent);
    if (ref) return store.mention(ref);
    const issue = issueOf(parent);
    if (issue) return `#${issue.number}`;
    return parent.refinement || parent.sync ? `#new-${parent.id}` : '';
  }

  const routes = [
    ['GET', /^\/api\/health$/, async () => ({ ok: true, auth: Boolean(expected) }), { public: true }],

    ['GET', /^\/api\/session$/, async () => ({ ok: true })],

    [
      'GET',
      /^\/api\/projects$/,
      async () => {
        let projects = await model.projects.list();
        if (!projects.length && !(await model.flags.has('seeded'))) {
          const { project } = await saveNewProject(demoProject(), 'demo');
          await model.flags.set('seeded');
          projects = [project];
        }
        return { projects };
      },
    ],

    [
      'POST',
      /^\/api\/projects$/,
      async ({ body }) => {
        const data = body?.template === 'demo' ? demoProject() : blankProject(body?.title || 'New project', body?.summary ?? '');
        return saveNewProject(data, body?.template === 'demo' ? 'demo' : 'blank');
      },
      { status: 201 },
    ],

    ['GET', /^\/api\/projects\/([\w-]+)$/, async ({ params: [pid] }) => loadProject(pid)],

    [
      'DELETE',
      /^\/api\/projects\/([\w-]+)$/,
      async ({ params: [pid] }) => {
        const { project } = await loadProject(pid);
        await model.agents.revokeAll(pid);
        await model.projects.delete(pid);
        const store = stores.forProject(project);
        if (store) await model.links.unlink(store.key, pid);
        return { deleted: pid };
      },
    ],

    [
      'POST',
      /^\/api\/projects\/([\w-]+)\/nodes$/,
      async ({ params: [pid], body }) => {
        const { project, nodes } = await loadProject(pid);
        const incoming = Array.isArray(body?.nodes) ? body.nodes : [body?.node ?? body];
        if (incoming.length > 500) throw new ValidationError('at most 500 nodes per request');
        const known = new Set(nodes.map((n) => n.id));
        const now = new Date().toISOString();
        const created = [];
        for (const raw of incoming) {
          const clean = sanitizeNode(raw);
          const id = typeof raw?.id === 'string' && /^[\w-]{4,64}$/.test(raw.id) && !known.has(raw.id) ? raw.id : newId();
          if (clean.kind === 'project') clean.kind = 'area';
          const node = { ...clean, id, parentId: known.has(clean.parentId) ? clean.parentId : ROOT_ID, createdAt: now, updatedAt: now };
          node.links = node.links.filter((l) => known.has(l.to) && l.to !== id);
          known.add(id);
          created.push(node);
        }
        await model.nodes.put(pid, created);
        const updatedProject = await touchProject(project, [...nodes, ...created]);
        return { nodes: created, project: updatedProject };
      },
      { status: 201 },
    ],

    [
      'PATCH',
      /^\/api\/projects\/([\w-]+)\/nodes\/([\w-]+)$/,
      async ({ params: [pid, nid], body }) => {
        const { project, nodes } = await loadProject(pid);
        const current = nodes.find((n) => n.id === nid);
        if (!current) throw new HttpError(404, 'Node not found');
        const patch = sanitizeNode(body ?? {}, { partial: true });
        if (nid === ROOT_ID) {
          delete patch.parentId;
          delete patch.kind;
        } else if ('parentId' in patch) {
          if (!nodes.some((n) => n.id === patch.parentId)) throw new ValidationError('parentId: no such node');
          if (subtreeIds(nodes, nid).includes(patch.parentId)) throw new ValidationError('parentId: cannot move a node inside itself');
        }
        if (patch.kind === 'project') delete patch.kind;
        if (patch.links) {
          const known = new Set(nodes.map((n) => n.id));
          patch.links = patch.links.filter((l) => known.has(l.to) && l.to !== nid);
        }
        let node = { ...current, ...patch, id: nid, updatedAt: new Date().toISOString() };
        // A change to what the store holds (its text or its state) waits for a save (SYNC-07).
        if (['title', 'body', 'status'].some((k) => k in patch && patch[k] !== current[k])) node = markEdited(current, node, stores.forProject(project));
        await model.nodes.put(pid, [node]);
        const all = nodes.map((n) => (n.id === nid ? node : n));
        const updatedProject = await touchProject(project, all);
        return { node, project: updatedProject };
      },
    ],

    [
      'DELETE',
      /^\/api\/projects\/([\w-]+)\/nodes\/([\w-]+)$/,
      async ({ params: [pid, nid] }) => {
        if (nid === ROOT_ID) throw new ValidationError('the project root cannot be deleted');
        const { project, nodes } = await loadProject(pid);
        if (!nodes.some((n) => n.id === nid)) throw new HttpError(404, 'Node not found');
        const { deleted, updated } = await removeNodes(pid, nodes, new Set(subtreeIds(nodes, nid)));
        return { deleted, updated, project: await model.projects.get(project.id) };
      },
    ],

    // ---- Changesets: edits to several items of an area, accepted or discarded together ----

    ['GET', /^\/api\/projects\/([\w-]+)\/changesets$/, async ({ params: [pid] }) => ({ changesets: await model.changesets.list(pid) })],

    [
      'POST',
      /^\/api\/projects\/([\w-]+)\/changesets$/,
      async ({ params: [pid], body }) => {
        const { nodes } = await loadProject(pid);
        const scope = nodes.find((n) => n.id === body?.scopeId) ?? nodes.find((n) => n.id === ROOT_ID);
        const now = new Date().toISOString();
        const changeset = { id: newId(), scopeId: scope.id, scopeTitle: scope.title, status: 'open', author: author(body?.author), items: [], createdAt: now, updatedAt: now };
        await model.changesets.put(pid, changeset);
        return { changeset };
      },
      { status: 201 },
    ],

    [
      'PUT',
      /^\/api\/projects\/([\w-]+)\/changesets\/([\w-]+)\/items$/,
      // Record one item's edits. Its base is what the map holds now, the first time it's edited.
      async ({ params: [pid, cid], body }) => {
        const cs = await loadChangeset(pid, cid, { open: true });
        const key = String(body?.key ?? '');
        if (!KEY.test(key)) throw new ValidationError('key: expected issue-<number> or node-<id>');
        const { nodes } = await loadProject(pid);
        const node = findItem(nodes, key);
        if (!node) throw new HttpError(404, 'No such item on the map');
        const after = version(body, 'item');
        if (!after.title) throw new ValidationError('title: required');
        if (node.refinement && node.refinement !== cs.id) throw new HttpError(409, 'This item is new in another refinement: it changes there until that one is adopted');
        if (node.refinement) {
          // A new item has no spec to protect: its edits change it in place, and everyone sees them (NEW-03).
          const changed = { ...applyTo(node, after, new Date().toISOString()), status: node.status };
          if (/^Kind:\s*Epic\b/im.test(after.markdown)) changed.kind = 'epic';
          await model.nodes.put(pid, [changed]);
          cs.items = cs.items.map((it) => (it.key === key ? { ...it, nodeTitle: changed.title } : it));
          cs.updatedAt = changed.updatedAt;
          await model.changesets.put(pid, cs);
          return { changeset: cs, node: changed };
        }
        const at = cs.items.findIndex((it) => it.key === key);
        // A whole new text, written after reading the item as it is now (an agent's revision, ADOPT-13), is based on
        // that, so an edit made since the refinement opened doesn't leave it a conflict that can never be adopted.
        const rebased = Boolean(body?.rebase) && at >= 0 && !same(cs.items[at].base, editableOf(node));
        const base = at >= 0 && !rebased ? cs.items[at].base : editableOf(node);
        if (same(base, after)) {
          if (at >= 0) cs.items.splice(at, 1);
        } else if (at >= 0) {
          const { conflict, theirs, ...kept } = cs.items[at];
          cs.items[at] = rebased ? { ...kept, base, after } : { ...cs.items[at], after };
        } else cs.items.push({ key, nodeTitle: node.title, base, after });
        cs.updatedAt = new Date().toISOString();
        await model.changesets.put(pid, cs);
        return { changeset: cs, ...(rebased ? { rebased: true } : {}) };
      },
    ],

    [
      'POST',
      /^\/api\/projects\/([\w-]+)\/changesets\/([\w-]+)\/new$/,
      // A new item in an area (NEW-01): on the map at once, in the strict shape's template, part of this refinement (NEW-02).
      async ({ params: [pid, cid], body }) => {
        const cs = await loadChangeset(pid, cid, { open: true });
        const { project, nodes } = await loadProject(pid);
        const parent = nodes.find((n) => n.id === body?.parentId) ?? findItem(nodes, String(body?.parentId ?? '')) ?? nodes.find((n) => n.id === cs.scopeId);
        if (!parent) throw new HttpError(404, 'No such place on the map');
        const kind = KINDS.includes(body?.kind) && !['project', 'area'].includes(body.kind) ? body.kind : 'task';
        const now = new Date().toISOString();
        const title = text(body?.title ?? '', 200, 'title').trim() || `New ${kind}`;
        const markdown = body?.markdown != null ? text(body.markdown, 19000, 'markdown') : newItemMarkdown({ kind, partOf: partOf(stores.forProject(project), parent), place: placeOf(editableOf(parent).markdown) });
        const id = newId();
        const node = { ...applyTo({ ...sanitizeNode({ kind, title, status: 'idea', tags: kind === 'story' ? ['new-feature'] : [] }), id, parentId: parent.id, createdAt: now }, { title, markdown }, now), status: 'idea', refinement: cs.id };
        await model.nodes.put(pid, [node]);
        cs.items.push({ key: itemKeyOf(node), nodeTitle: node.title, new: true });
        cs.updatedAt = now;
        await model.changesets.put(pid, cs);
        await touchProject(project, [...nodes, node]);
        return { changeset: cs, node };
      },
      { status: 201 },
    ],

    [
      'DELETE',
      /^\/api\/projects\/([\w-]+)\/changesets\/([\w-]+)\/items\/(issue-\d+|node-[\w-]+)$/,
      // Take an item out of a refinement: its edits go, and a new item goes altogether, never reaching the store (NEW-06).
      async ({ params: [pid, cid, key] }) => {
        const cs = await loadChangeset(pid, cid, { open: true });
        const entry = cs.items.find((it) => it.key === key);
        if (!entry) throw new HttpError(404, 'That item is not in this refinement');
        if (!entry.new) {
          cs.items = cs.items.filter((it) => it.key !== key);
          cs.updatedAt = new Date().toISOString();
          await model.changesets.put(pid, cs);
          return { changeset: cs, deleted: [], updated: [] };
        }
        const { nodes } = await loadProject(pid);
        const node = findItem(nodes, key);
        const dropped = await dropNew(pid, nodes, node ? [node.id] : []);
        if (!node) await model.changesets.put(pid, { ...cs, items: cs.items.filter((it) => it.key !== key) });
        return { changeset: await model.changesets.get(pid, cid), ...dropped };
      },
    ],

    [
      'POST',
      /^\/api\/projects\/([\w-]+)\/changesets\/([\w-]+)\/items\/(issue-\d+|node-[\w-]+)\/(adopt|decline)$/,
      // A person's yes or no to one item of someone else's refinement (ADOPT-05). Adopting changes the map, and the item
      // waits for a save like any accepted edit (SYNC-07); declining drops it, with a reason its author sees at standup.
      // Agents have no tool that reaches this (ADOPT-10).
      async ({ params: [pid, cid, key, action], body }) => {
        const cs = await loadChangeset(pid, cid, { open: true });
        const entry = cs.items.find((it) => it.key === key);
        if (!entry) throw new HttpError(404, 'That item is not in this refinement');
        if (entry.new) throw new HttpError(409, 'A new item is adopted with the whole refinement');
        const now = new Date(clock()).toISOString(); // the agents' clock: its standup reports what was decided since
        const by = author(body?.by);
        const { project, nodes } = await loadProject(pid);
        let changed = [];
        if (action === 'adopt') {
          // Open questions don't hold it back: they show as badges, and are answered in their threads (ADOPT-08).
          if (conflictsOf({ items: [entry] }, nodes).length) throw Object.assign(new HttpError(409, `Changed since this was proposed: ${entry.nodeTitle}`), { conflicts: [key] });
          const before = findItem(nodes, key);
          changed = [markEdited(before, applyTo(before, entry.after, now), stores.forProject(project))];
          await model.nodes.put(pid, changed);
          await touchProject(project, nodes.map((n) => (n.id === before.id ? changed[0] : n)));
        }
        const cleared = action === 'adopt' ? (await settleNotes(model, pid, cs, now, [key])).map(annotationOf) : [];
        const decided = { key, nodeTitle: entry.nodeTitle, by, at: now, ...(entry.readyForAdoption?.length ? { readyForAdoption: entry.readyForAdoption } : {}) };
        if (action === 'adopt') cs.adopted = [...(cs.adopted ?? []), decided];
        else cs.declined = [...(cs.declined ?? []), { ...decided, reason: text(body?.reason ?? '', 2000, 'reason').trim() }];
        cs.items = cs.items.filter((it) => it.key !== key);
        cs.updatedAt = now;
        // A refinement with nothing left in it is closed: adopted if anything in it was.
        if (!cs.items.length) Object.assign(cs, cs.adopted?.length ? { status: 'accepted', acceptedAt: now } : { status: 'declined' });
        await model.changesets.put(pid, cs);
        return { changeset: cs, nodes: changed, ...(cleared.length ? { cleared } : {}) };
      },
    ],

    [
      'POST',
      /^\/api\/projects\/([\w-]+)\/changesets\/([\w-]+)\/(accept|discard)$/,
      async ({ params: [pid, cid, action] }) => {
        const cs = await loadChangeset(pid, cid, { open: true });
        const now = new Date().toISOString();
        if (action === 'discard') {
          // The refinement's new items go with it (NEW-06).
          const { nodes } = await loadProject(pid);
          const made = nodes.filter((n) => n.refinement === cs.id).map((n) => n.id);
          const { deleted, updated } = await dropNew(pid, nodes, made);
          Object.assign(cs, { status: 'discarded', updatedAt: now });
          await model.changesets.put(pid, cs);
          return { changeset: cs, nodes: updated, deleted };
        }
        if (!cs.items.length) throw new ValidationError('nothing to accept: this changeset has no edits');
        const { project, nodes } = await loadProject(pid);
        const untitled = nodes.filter((n) => n.refinement === cs.id && !editableOf(n).title.trim());
        if (untitled.length) throw new ValidationError('every new item needs a title');
        const conflicts = conflictsOf(cs, nodes);
        if (conflicts.length) throw Object.assign(new HttpError(409, `Changed since you started editing: ${conflicts.map((c) => c.nodeTitle).join(', ')}`), { conflicts: conflicts.map((c) => c.key) });
        // Accepting changes the map. Items from a store are then unsaved: nothing reaches the store until a save (SYNC-07).
        const store = stores.forProject(project);
        const edits = cs.items.filter((it) => !it.new).map((it) => {
          const before = findItem(nodes, it.key);
          return markEdited(before, applyTo(before, it.after, now), store);
        });
        // New items join the spec, and wait for a save like any accepted edit: a save creates them in the store (NEW-04).
        const adopted = nodes.filter((n) => n.refinement === cs.id).map(({ refinement, ...n }) => ({ ...n, status: openQuestions(editableOf(n).markdown) ? 'needs_decision' : n.status, updatedAt: now, ...(store ? { sync: 'unsaved' } : {}) }));
        const changed = [...adopted, ...edits];
        await model.nodes.put(pid, changed);
        const byId = new Map(changed.map((n) => [n.id, n]));
        await touchProject(project, nodes.map((n) => byId.get(n.id) ?? n));
        Object.assign(cs, { status: 'accepted', acceptedAt: now, updatedAt: now });
        await model.changesets.put(pid, cs);
        // Adopting it clears the questions it answered, and an item with nothing else open comes back ready (ANSWER-04).
        // The annotations it acted on clear too, naming it (NOTE-19, NOTE-05).
        const { resolved: answered, ready } = await settleAnswers(model, pid, cs, changed, now);
        const cleared = [...answered, ...(await settleNotes(model, pid, cs, now))].map(annotationOf);
        const marked = ready.filter((n) => n.status !== 'ready').map((n) => markEdited(n, { ...n, status: 'ready', updatedAt: now }, store));
        if (marked.length) await model.nodes.put(pid, marked);
        return { changeset: cs, nodes: changed.map((n) => marked.find((m) => m.id === n.id) ?? n), ...(cleared.length ? { cleared } : {}) };
      },
    ],

    // ---- Annotations (#15): comments with a kind, anchored to the words, block, section or place they are about ----

    ['GET', /^\/api\/projects\/([\w-]+)\/comments$/, async ({ params: [pid] }) => ({ comments: (await model.comments.list(pid)).map(annotationOf) })],
    // What the map badges (NOTE-03, NOTE-04): open annotations of each kind, by item, without sending every thread.
    ['GET', /^\/api\/projects\/([\w-]+)\/notes$/, async ({ params: [pid] }) => ({ open: openByItem(await model.comments.list(pid)) })],
    // One item's threads: the web app loads comments only for what is open, never a whole project's.
    ['GET', /^\/api\/projects\/([\w-]+)\/comments\/(issue-\d+|node-[\w-]+)$/, async ({ params: [pid, itemKey] }) => ({ comments: (await model.comments.list(pid, itemKey)).map(annotationOf) })],

    [
      'POST',
      /^\/api\/projects\/([\w-]+)\/comments$/,
      // A new annotation is its own thread (NOTE-11); a reply joins one, on the same anchor. Only a Change carries a value (NOTE-02).
      async ({ params: [pid], body }) => {
        const { nodes } = await loadProject(pid);
        const itemKey = String(body?.itemKey ?? '');
        if (!KEY.test(itemKey)) throw new ValidationError('itemKey: expected issue-<number> or node-<id>');
        const said = text(body?.text ?? '', 4000, 'text').trim();
        if (!said) throw new ValidationError('text: required');
        if (body?.kind != null && !NOTE_KINDS.includes(body.kind)) throw new ValidationError(`kind: one of ${NOTE_KINDS.join(', ')}`);
        const root = body?.replyTo ? await model.comments.get(pid, { itemKey, id: String(body.replyTo) }) : null;
        if (body?.replyTo && !root) throw new HttpError(404, 'The thread to reply in is gone');
        const anchor = root ? root.anchor : cleanAnchor(body?.anchor ?? {});
        const kind = root ? 'comment' : (body?.kind ?? (anchor.section === 'Open questions' ? 'question' : 'comment'));
        const value = body?.value == null ? '' : text(body.value, 200, 'value').trim();
        if (value && kind !== 'change') throw new ValidationError('value: only a Change carries a value');
        const at = new Date(clock()).toISOString();
        // Addressed to whoever it mentions (NOTE-14). One for an agent waits in the inbox until an agent replies, and
        // every agent call hands it on at once (NOTE-17); the thread says where it is.
        const to = addresseesOf(said, mentionsOf(said).length ? await model.agents.list(pid) : []);
        const fromAgent = typeof body?.fromAgent === 'string' ? body.fromAgent : null;
        const comment = {
          id: commentId(),
          itemKey,
          anchor,
          kind,
          ...(root ? { replyTo: root.id } : {}),
          text: said,
          ...(value ? { value } : {}),
          ...(to.length ? { to } : {}),
          ...(typeof body?.refinement === 'string' && body.refinement ? { refinement: body.refinement.slice(0, 40) } : {}),
          author: author(body?.author),
          resolved: false,
          createdAt: at,
        };
        let thread = root;
        const agent = !fromAgent && to.find((t) => t.agent);
        if (agent) {
          const one = to.find((t) => t.agentId);
          await model.inbox.put(pid, { id: root?.id ?? comment.id, itemKey, at, ...(one ? { agentId: one.agentId } : {}) });
          const delivery = { state: 'waiting', for: one?.name ?? 'any agent', at };
          if (root) thread = { ...root, delivery };
          else comment.delivery = delivery;
        } else if (fromAgent && root?.delivery && root.delivery.state !== 'replied') {
          thread = { ...root, delivery: { ...root.delivery, state: 'replied', by: comment.author, at } };
          await model.inbox.delete(pid, root.id);
        }
        // A person's reply to an open question is its answer, and goes to an agent to apply (ANSWER-01, ANSWER-02). The
        // prompt it goes with is kept only if the person changed it (ANSWER-05). An agent's reply is never the answer.
        let prompt;
        if (root && !fromAgent && answers(root, comment.author)) {
          const built = answerPrompt({ nodes, comments: await model.comments.list(pid, itemKey), question: root, answer: said, answeredBy: comment.author });
          const asked = body?.prompt == null ? '' : text(body.prompt, 40000, 'prompt').trim();
          const answer = { text: said, by: comment.author, at, reply: comment.id, ...(asked && asked !== built.trim() ? { prompt: asked } : {}) };
          thread = { ...thread, answer };
          prompt = answer.prompt ?? built;
        }
        await model.comments.put(pid, comment);
        if (thread !== root) await model.comments.put(pid, thread);
        return { comment: annotationOf(comment), ...(thread !== root ? { thread: annotationOf(thread) } : {}), ...(prompt ? { prompt } : {}) };
      },
      { status: 201 },
    ],

    [
      'POST',
      /^\/api\/projects\/([\w-]+)\/comments\/(issue-\d+|node-[\w-]+)\/([\w-]+)\/read$/,
      // A person has read a plain Comment: it clears into their conversation log, and stays at its words for everyone
      // else (NOTE-05). One addressed to someone counts as read only by whoever it is addressed to.
      async ({ params: [pid, itemKey, id], body }) => {
        const comment = await model.comments.get(pid, { itemKey, id });
        if (!comment) throw new HttpError(404, 'Comment not found');
        if (!isPlain(comment)) throw new ValidationError('only a Comment clears once read; the rest clear once acted on');
        const by = author(body?.by);
        if (!readsFor(comment, by) || comment.readBy?.includes(by)) return { comment: annotationOf(comment) };
        const read = { ...comment, readBy: [...(comment.readBy ?? []), by] };
        await model.comments.put(pid, read);
        return { comment: annotationOf(read) };
      },
    ],

    [
      'POST',
      /^\/api\/projects\/([\w-]+)\/comments\/(issue-\d+|node-[\w-]+)\/([\w-]+)\/prompt$/,
      // The prompt a reply to an open question would go out with, to read and change before posting it (ANSWER-05).
      async ({ params: [pid, itemKey, id], body }) => {
        const question = await model.comments.get(pid, { itemKey, id });
        if (!question) throw new HttpError(404, 'Comment not found');
        if (!isQuestion(question)) throw new ValidationError('only an open question can be answered');
        if (question.resolved) throw new HttpError(409, 'This question is already cleared');
        const said = text(body?.text ?? '', 4000, 'text').trim();
        if (!said) throw new ValidationError('text: required');
        const by = author(body?.author);
        const { nodes } = await loadProject(pid);
        return { prompt: answerPrompt({ nodes, comments: await model.comments.list(pid, itemKey), question, answer: said, answeredBy: by }) };
      },
    ],

    [
      'POST',
      /^\/api\/projects\/([\w-]+)\/comments\/(issue-\d+|node-[\w-]+)\/([\w-]+)\/promote$/,
      // A Problem or a Refactor becomes a child task in the strict shape, linked back to the annotation (NOTE-06). The
      // task is new in the person's refinement, like any item they add (NEW-01). Made a task, the annotation is acted on, so it
      // clears, and its conversation log links the task (NOTE-05).
      async ({ params: [pid, itemKey, id], body }) => {
        const note = await model.comments.get(pid, { itemKey, id });
        if (!note) throw new HttpError(404, 'Comment not found');
        if (!['problem', 'refactor'].includes(kindOf(note)) || note.replyTo) throw new ValidationError('only a Problem or a Refactor becomes a task');
        if (note.resolved) throw new HttpError(409, 'This annotation is already acted on');
        const { project, nodes } = await loadProject(pid);
        const parent = findItem(nodes, itemKey);
        if (!parent) throw new HttpError(404, 'Its item is no longer on the map');
        const by = author(body?.by);
        const call = async (method, path, b) => {
          const res = await handle({ method, path, body: b, trusted: true });
          if (res.status >= 400) throw new HttpError(res.status, res.body?.error ?? 'Failed');
          return res.body;
        };
        const cid = body?.changeset ? String(body.changeset) : (await call('POST', `/api/projects/${pid}/changesets`, { scopeId: parent.id, author: by })).changeset.id;
        const first = note.text.split('\n')[0].replace(/@[A-Za-z][\w.-]*\s*/g, '').trim();
        const title = `${NOTE_KIND_LABEL[kindOf(note)]}: ${first}`.slice(0, 120);
        const template = newItemMarkdown({ kind: 'task', partOf: partOf(stores.forProject(project), parent), place: placeOf(editableOf(parent).markdown) });
        const said = note.anchor?.quote ? ` at “${note.anchor.quote.slice(0, 200)}”` : '';
        const why = `${note.author} raised this ${NOTE_KIND_LABEL[kindOf(note)]} on ${parent.title}, in ${whereOf(note.anchor)}${said}:\n\n${note.text.split('\n').map((l) => `> ${l}`).join('\n')}\n\nFrom annotation ${note.id} on ${itemKey}.`;
        const markdown = writeIssue(parseIssue(template), { Why: why });
        const { node, changeset } = await call('POST', `/api/projects/${pid}/changesets/${encodeURIComponent(cid)}/new`, { parentId: parent.id, kind: 'task', title, markdown });
        const at = new Date(clock()).toISOString();
        const comment = { ...note, resolved: true, cleared: { task: { key: itemKeyOf(node), title: node.title }, by, at } };
        await model.comments.put(pid, comment);
        await model.inbox.delete(pid, id);
        return { comment: annotationOf(comment), node, changeset };
      },
      { status: 201 },
    ],

    [
      'DELETE',
      /^\/api\/projects\/([\w-]+)\/comments\/(issue-\d+|node-[\w-]+)\/([\w-]+)$/,
      async ({ params: [pid, itemKey, id] }) => {
        if (!(await model.comments.get(pid, { itemKey, id }))) throw new HttpError(404, 'Comment not found');
        await model.comments.delete(pid, { itemKey, id });
        return { deleted: id };
      },
    ],

    // ---- Sync with each project's store (#3) ----

    [
      'POST',
      /^\/api\/github\/webhook$/,
      // GitHub signs every delivery with the App's webhook secret; anything unsigned or wrongly signed is refused.
      async ({ headers, rawBody, body }) => {
        if (!sync || !webhookSecret) throw new HttpError(404, 'Webhooks are not set up here');
        if (!signedByGitHub(rawBody, headers['x-hub-signature-256'], await webhookSecret())) throw new HttpError(401, 'Bad signature');
        const delivery = eventsFromWebhook(String(headers['x-github-event'] ?? ''), body);
        return delivery ? sync.onEvents(delivery.key, delivery.events) : { handled: false };
      },
      { public: true },
    ],

    [
      'POST',
      /^\/api\/projects\/([\w-]+)\/save$/,
      // Save: every unsaved item (or just body.keys) goes to the project's store as it is now. It decides nothing (SYNC-08).
      async ({ params: [pid], body }) => {
        const { project } = await loadProject(pid);
        if (!stores.forProject(project)) throw new ValidationError('this project lives only in Overworld: there is no store to save to');
        const keys = Array.isArray(body?.keys) ? body.keys.filter((k) => typeof k === 'string' && KEY.test(k)) : null;
        const result = await saveNow({ model, stores }, pid, { keys });
        if (result.saved.length) onSaved?.(pid);
        return result;
      },
    ],

    [
      'GET',
      /^\/api\/projects\/([\w-]+)\/sync$/,
      // What is still on its way to the store, and what the last reconciliations fixed.
      async ({ params: [pid] }) => {
        if (!(await model.projects.get(pid))) throw new HttpError(404, 'Project not found');
        return { enabled: Boolean(sync), jobs: await model.jobs.list(pid), reports: await model.audits.list(pid) };
      },
    ],

    [
      'POST',
      /^\/api\/projects\/([\w-]+)\/sync$/,
      // Retry now, without waiting for the booked retry.
      async ({ params: [pid] }) => {
        if (!sync) throw new HttpError(409, 'Sync is not set up here');
        if (!(await model.projects.get(pid))) throw new HttpError(404, 'Project not found');
        return sync.drain(pid, { now: true });
      },
    ],

    ['POST', /^\/api\/import\/json$/, async ({ body }) => saveNewProject(fromImport(body), 'json'), { status: 201 }],

    [
      'POST',
      /^\/api\/import\/github$/,
      async ({ body }) => {
        const data = await importGitHub({ repo: body?.repo, token: body?.token || undefined }, fetchImpl);
        const saved = await saveNewProject(data, 'github', { githubRepo: data.title, strictLifecycle: data.strictLifecycle, guide: data.guide });
        await model.links.link(stores.forProject(saved.project).key, saved.project.id);
        return saved;
      },
      { status: 201 },
    ],

    [
      'POST',
      /^\/api\/projects\/([\w-]+)\/refresh$/,
      // Map the project from its store again, in place: same project, same link, today's code and items.
      async ({ params: [pid], body }) => {
        const { project } = await loadProject(pid);
        const store = stores.forProject(project);
        if (!store) throw new ValidationError('only projects imported from a store can be refreshed');
        const data = await store.mapAgain({ token: body?.token || undefined });
        const kept = keepPending(data.nodes, await model.nodes.pending(pid), store);
        await model.nodes.replace(pid, kept.nodes);
        const updated = await touchProject(project, kept.nodes, data.project);
        await model.links.link(store.key, pid);
        return { project: updated, nodes: kept.nodes };
      },
    ],

    // ---- Agents (#4): people make and revoke their tokens, and see what they claimed, changed and remembered ----

    ['GET', /^\/api\/projects\/([\w-]+)\/agents$/, async ({ params: [pid] }) => {
      await loadProjectHead(pid);
      return { agents: (await model.agents.list(pid)).map(({ tokenHash, ...a }) => a) };
    }],

    [
      'POST',
      /^\/api\/projects\/([\w-]+)\/agents$/,
      // The token is shown this once; only its hash is kept (MCP-07).
      async ({ params: [pid], body }) => {
        await loadProjectHead(pid);
        return agents.issueToken(pid, body?.name);
      },
      { status: 201 },
    ],

    [
      'DELETE',
      /^\/api\/projects\/([\w-]+)\/agents\/([\w-]+)$/,
      async ({ params: [pid, aid] }) => {
        const agent = await agents.revoke(pid, aid);
        if (!agent) throw new HttpError(404, 'Agent not found');
        return { agent };
      },
    ],

    ['GET', /^\/api\/projects\/([\w-]+)\/agents\/([\w-]+)\/actions$/, async ({ params: [pid, aid] }) => ({ actions: await model.actions.list(pid, aid) })],

    ['GET', /^\/api\/projects\/([\w-]+)\/claims$/, async ({ params: [pid] }) => {
      await loadProjectHead(pid);
      return { claims: [...(await agents.liveClaims(pid)).live.values()] };
    }],

    ['GET', /^\/api\/projects\/([\w-]+)\/facts$/, async ({ params: [pid] }) => ({ facts: await model.facts.list(pid) })],

    [
      'POST',
      /^\/api\/projects\/([\w-]+)\/facts$/,
      async ({ params: [pid], body }) => {
        await loadProjectHead(pid);
        return { fact: await agents.remember(pid, { name: author(body?.author) }, body?.text) };
      },
      { status: 201 },
    ],

    [
      'DELETE',
      /^\/api\/projects\/([\w-]+)\/facts\/([\w:.-]+)\/([\w-]+)$/,
      async ({ params: [pid, at, id] }) => {
        await model.facts.delete(pid, { at, id });
        return { deleted: id };
      },
    ],
  ];

  // The MCP server signs agents in with their own tokens, and reaches the routes above as a trusted caller.
  const mcp = createMcp({ model, agents, log, call: (method, path, body) => handle({ method, path, body, trusted: true }) });

  async function loadProjectHead(pid) {
    const project = await model.projects.get(pid);
    if (!project) throw new HttpError(404, 'Project not found');
    return project;
  }

  return handle;

  async function handle({ method, path, headers = {}, body = null, rawBody = null, trusted = false }) {
    try {
      if (path === '/api/mcp') return await mcp({ method, headers, body });
      for (const [m, re, fn, opts = {}] of routes) {
        const match = path.match(re);
        if (!match || m !== method) continue;
        if (!opts.public && !trusted) authorize(headers);
        const result = await fn({ params: match.slice(1), body, headers, rawBody });
        return { status: opts.status ?? 200, body: result };
      }
      const pathKnown = routes.some(([, re]) => re.test(path));
      throw new HttpError(pathKnown ? 405 : 404, pathKnown ? 'Method not allowed' : 'Not found');
    } catch (err) {
      const status = err.status ?? 500;
      if (status >= 500) log.error?.(err);
      return { status, body: { error: status >= 500 ? 'Internal error' : err.message, ...(err.conflicts ? { conflicts: err.conflicts } : {}) } };
    }
  }
}
