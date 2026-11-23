// HTTP-agnostic API. `handle({ method, path, headers, body })` -> { status, body }.
// Used by the Lambda handler in AWS and by the Vite dev server locally.

import { createHash, timingSafeEqual } from 'node:crypto';
import { KINDS, ROOT_ID, ValidationError, newId, sanitizeNode } from '../shared/schema.js';
import { changeKeys, compareItems, issueOf, mergeChanges, newItemMarkdown, parseBehaviours, parseIssue, placeOf, sectionText, writeIssue } from '../shared/issue-shape.js';
import { demoProject } from './seed.mjs';
import { importGitHub } from './github.mjs';
import { applyTo, conflictsOf, editableOf, findItem, itemKeyOf, same } from './edits.mjs';
import { keepPending, markEdited, saveNow } from './sync.mjs';
import { createStores } from './stores/index.mjs';
import { eventsFromWebhook, githubKey, signedByGitHub } from './stores/github/index.mjs';
import { answerPrompt, awaitsApplying, questionsOfNode, questionsOnMap, settleAnswers } from './answers.mjs';
import { annotationOf, cleanAnchor, isDismissed, mentionsOf, notesByItem, whereOf } from '../shared/annotations.js';
import { questionId, questionsIn, withAnswer, withQuestion } from '../shared/questions.js';
import { addresseesOf } from './notes.mjs';
import { createAgents } from './agents.mjs';
import { createMcp } from './mcp.mjs';
import { behavioursOf, childrenOf, keyOf, nextWork, splitOf } from './work.mjs';
import { VOCABULARY, duplicateIds, pairKey, textHash, vocabularyDrift } from '../shared/coherence.js';
import { openQuestions } from './engine/lifecycle.mjs';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const BEHAVIOUR = /^[A-Z][A-Z0-9]*-\d+$/;
const VERDICTS = ['duplicate', 'contradiction', 'related', 'unrelated'];

/** Every behaviour on the map, as the spec's check reads them (#36): { id, item, title, text, hash }. */
const behavioursOn = (nodes) => nodes.flatMap((n) => behavioursOf(n).map((b) => ({ id: b.id, item: keyOf(n), title: n.title, text: b.text, hash: textHash(b.text) })));

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

  /** A thread's first comment: reading, dismissing and making a task act on the thread, never on one reply in it. */
  async function rootOf(pid, itemKey, id) {
    const c = await model.comments.get(pid, { itemKey, id });
    if (!c) throw new HttpError(404, 'Comment not found');
    if (c.replyTo) throw new ValidationError('that is a reply: act on its thread');
    return c;
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

  /**
   * A person's yes or no to a new item of someone else's refinement, as a whole: its title and its behaviours (ADOPT-05).
   * Adopting does what accepting a person's own new item does: it joins the spec and waits for a save, which creates it
   * in the store (NEW-04). Declining drops it, and what is inside it, so it never reaches the store (NEW-06).
   */
  async function decideNew(pid, cs, entry, action, body) {
    const now = new Date(clock()).toISOString(); // the agents' clock: its standup reports what was decided since
    const { project, nodes } = await loadProject(pid);
    const node = findItem(nodes, entry.key);
    if (!node) throw new HttpError(404, 'No such item on the map');
    const behavioursOf = (n) => compareItems({ title: '', markdown: '' }, editableOf(n)).behaviours.map((b) => b.id).filter(Boolean);
    const decided = (n) => ({ key: itemKeyOf(n), nodeTitle: n.title, new: true, behaviours: behavioursOf(n), by: author(body?.by), at: now });
    let changed = [];
    let deleted = [];
    if (action === 'adopt') {
      // A new item inside a new item is part of it: the spec takes the parent first.
      const parent = nodes.find((n) => n.id === node.parentId);
      if (parent?.refinement) throw new HttpError(409, `Adopt “${parent.title}” first: this item is inside it, and it is new too`);
      if (!editableOf(node).title.trim()) throw new ValidationError('a new item needs a title');
      const store = stores.forProject(project);
      const { refinement, ...adopted } = node;
      changed = [{ ...adopted, status: openQuestions(editableOf(node).markdown) ? 'needs_decision' : node.status, updatedAt: now, ...(store ? { sync: 'unsaved' } : {}) }];
      await model.nodes.put(pid, changed);
      await touchProject(project, nodes.map((n) => (n.id === node.id ? changed[0] : n)));
      cs.items = cs.items.filter((it) => it.key !== entry.key);
      cs.adopted = [...(cs.adopted ?? []), decided(node)];
    } else {
      const reason = text(body?.reason ?? '', 2000, 'reason').trim();
      const inside = new Set(subtreeIds(nodes, node.id));
      const gone = nodes.filter((n) => inside.has(n.id) && n.refinement === cs.id);
      ({ deleted } = await dropNew(pid, nodes, [node.id]));
      cs = await model.changesets.get(pid, cs.id); // dropping took them out of it
      cs.declined = [...(cs.declined ?? []), ...gone.map((n) => ({ ...decided(n), reason }))];
    }
    cs.updatedAt = now;
    if (!cs.items.length) Object.assign(cs, cs.adopted?.length ? { status: 'accepted', acceptedAt: now } : { status: 'declined' });
    await model.changesets.put(pid, cs);
    return { changeset: cs, nodes: changed, deleted };
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

  /**
   * Change an item's text in place, the way accepting an edit does: it waits for a save (SYNC-07). Asking and answering a
   * question are such changes (ANSWER-01, ANSWER-07). Each open refinement of the item gets the same change, so what it
   * proposes is still proposed against the item as it now is, and no question leaves it a conflict.
   * @param {(markdown: string) => string | null} change  the new markdown, or null if it can't be made
   * @returns {Promise<{ node: object, changesets: object[] }>}
   */
  async function rewrite(pid, itemKey, change) {
    const { project, nodes } = await loadProject(pid);
    const node = findItem(nodes, itemKey);
    if (!node) throw new HttpError(404, 'No such item on the map');
    const before = editableOf(node);
    const markdown = change(before.markdown);
    if (markdown == null) throw new HttpError(404, 'That question is no longer in its item\'s Open questions');
    const now = new Date(clock()).toISOString();
    const after = { title: before.title, markdown };
    // A new item is part of its refinement, which adopts it (NEW-03): its state waits for that.
    const changed = node.refinement ? { ...applyTo(node, after, now), status: node.status } : markEdited(node, applyTo(node, after, now), stores.forProject(project));
    await model.nodes.put(pid, [changed]);
    await touchProject(project, nodes.map((n) => (n.id === node.id ? changed : n)));
    const carried = [];
    for (const cs of await model.changesets.list(pid)) {
      const at = cs.status === 'open' ? cs.items.findIndex((it) => it.key === itemKey && !it.new && same(it.base, before)) : -1;
      if (at < 0) continue;
      const it = cs.items[at];
      const theirs = change(it.after.markdown);
      cs.items[at] = { ...it, base: after, after: theirs == null ? it.after : { ...it.after, markdown: theirs } };
      if (same(cs.items[at].base, cs.items[at].after)) cs.items.splice(at, 1);
      cs.updatedAt = now;
      await model.changesets.put(pid, cs);
      carried.push(cs);
    }
    return { node: changed, changesets: carried };
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
        // A change to what the store holds (its text, its state or its priority) waits for a save (SYNC-07, SYNC-15).
        if (['title', 'body', 'status', 'priority'].some((k) => k in patch && patch[k] !== current[k])) node = markEdited(current, node, stores.forProject(project));
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
        } else cs.items.push({ key, nodeTitle: node.title, base, after, at: new Date().toISOString() }); // `at`: waiting since (#62 REVIEW-02)
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
        cs.items.push({ key: itemKeyOf(node), nodeTitle: node.title, new: true, at: now });
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
      // A person's yes or no to someone else's refinement of an item, one behaviour at a time (ADOPT-05): `behaviours`
      // lists the ticked changes (behaviour IDs, and 'other' for its title and other sections), and without it, all of
      // them. Adopting merges just those into the item, which waits for a save like any accepted edit (SYNC-07);
      // declining takes them out of the proposal, with a reason its author sees at standup. The item stays in the
      // refinement until nothing is left in it, and the refinement until no item is (ADOPT-06).
      // Agents have no tool that reaches this (ADOPT-10).
      async ({ params: [pid, cid, key, action], body }) => {
        const cs = await loadChangeset(pid, cid, { open: true });
        const entry = cs.items.find((it) => it.key === key);
        if (!entry) throw new HttpError(404, 'That item is not in this refinement');
        if (entry.new) return decideNew(pid, cs, entry, action, body);
        const now = new Date(clock()).toISOString(); // the agents' clock: its standup reports what was decided since
        const by = author(body?.by);
        const { project, nodes } = await loadProject(pid);
        const before = findItem(nodes, key);
        if (!before) throw new HttpError(404, 'No such item on the map');
        const all = changeKeys(compareItems(editableOf(before), entry.after));
        if (body?.behaviours != null && !Array.isArray(body.behaviours)) throw new ValidationError('behaviours: expected a list of behaviour IDs');
        const picks = body?.behaviours == null ? all : [...new Set(body.behaviours.map(String))];
        if (!picks.length && all.length) throw new ValidationError('behaviours: tick at least one');
        const unknown = picks.filter((p) => !all.includes(p));
        if (unknown.length) throw new ValidationError(`behaviours: not changed in this refinement: ${unknown.join(', ')}`);
        const whole = all.every((p) => picks.includes(p));
        let changed = [];
        if (action === 'adopt') {
          // Open questions don't hold it back: they show as badges, and are answered in their threads (ADOPT-08).
          if (conflictsOf({ items: [entry] }, nodes).length) throw Object.assign(new HttpError(409, `Changed since this was proposed: ${entry.nodeTitle}`), { conflicts: [key] });
          const adopted = whole ? entry.after : mergeChanges(editableOf(before), entry.after, picks);
          changed = [markEdited(before, applyTo(before, adopted, now), stores.forProject(project))];
          await model.nodes.put(pid, changed);
          await touchProject(project, nodes.map((n) => (n.id === before.id ? changed[0] : n)));
          // What is left is proposed against the item as it now is.
          entry.base = editableOf(changed[0]);
        } else entry.after = mergeChanges(entry.after, editableOf(before), picks);
        const ready = entry.readyForAdoption?.filter((id) => picks.includes(id)) ?? [];
        const decided = { key, nodeTitle: entry.nodeTitle, behaviours: picks, by, at: now, ...(ready.length ? { readyForAdoption: ready } : {}) };
        if (action === 'adopt') cs.adopted = [...(cs.adopted ?? []), decided];
        else cs.declined = [...(cs.declined ?? []), { ...decided, reason: text(body?.reason ?? '', 2000, 'reason').trim() }];
        const spec = changed[0] ? editableOf(changed[0]) : editableOf(before);
        const left = whole ? [] : changeKeys(compareItems(spec, entry.after));
        if (left.length) {
          entry.readyForAdoption = entry.readyForAdoption?.filter((id) => left.includes(id));
          if (!entry.readyForAdoption?.length) delete entry.readyForAdoption;
        } else cs.items = cs.items.filter((it) => it.key !== key);
        cs.updatedAt = now;
        // A refinement with nothing left in it is closed: adopted if anything in it was.
        if (!cs.items.length) Object.assign(cs, cs.adopted?.length ? { status: 'accepted', acceptedAt: now } : { status: 'declined' });
        await model.changesets.put(pid, cs);
        return { changeset: cs, nodes: changed };
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
        // Adopting it applies the answers it carries, and an item with nothing else open comes back ready (ANSWER-04).
        // The comments it acted on stay where they are: adopting dismisses nothing (NOTE-19, NOTE-05).
        const { applied, ready } = await settleAnswers(model, pid, cs, nodes, changed, now);
        const marked = ready.filter((n) => n.status !== 'ready').map((n) => markEdited(n, { ...n, status: 'ready', updatedAt: now }, store));
        if (marked.length) await model.nodes.put(pid, marked);
        return { changeset: cs, nodes: changed.map((n) => marked.find((m) => m.id === n.id) ?? n), ...(applied.length ? { applied } : {}) };
      },
    ],

    // ---- Comments (#15): anchored to the words, block, section or place they are about; no kinds ----

    ['GET', /^\/api\/projects\/([\w-]+)\/comments$/, async ({ params: [pid] }) => ({ comments: (await model.comments.list(pid)).map(annotationOf) })],
    // What the map badges (NOTE-03, NOTE-04): comments not dismissed, by item, and who has read them all, without sending every thread.
    // Beside them, the open questions waiting on someone (#62 REVIEW-02), from the items' Open questions sections: asked and
    // not answered, or answered and not yet written in. Comments are never among them (NOTE-22).
    [
      'GET',
      /^\/api\/projects\/([\w-]+)\/notes$/,
      async ({ params: [pid] }) => {
        const { nodes } = await loadProject(pid);
        const questions = {};
        const byKey = new Map(nodes.map((n) => [itemKeyOf(n), n]));
        for (const q of await questionsOnMap(model, pid, nodes)) {
          const waits = !q.answer ? 'asked' : awaitsApplying(q, byKey.get(q.itemKey)) ? 'answered' : null;
          if (!waits) continue;
          const here = (questions[q.itemKey] ??= { asked: 0, answered: 0 });
          here[waits] += 1;
          const since = (waits === 'asked' ? q.asked?.at : q.answered?.at) ?? byKey.get(q.itemKey).updatedAt;
          if (since && (!here.since || since < here.since)) here.since = since;
        }
        return { open: notesByItem(await model.comments.list(pid)), questions };
      },
    ],
    // One item's threads: the web app loads comments only for what is open, never a whole project's.
    ['GET', /^\/api\/projects\/([\w-]+)\/comments\/(issue-\d+|node-[\w-]+)$/, async ({ params: [pid, itemKey] }) => ({ comments: (await model.comments.list(pid, itemKey)).map(annotationOf) })],

    [
      'POST',
      /^\/api\/projects\/([\w-]+)\/comments$/,
      // A new comment is its own thread (NOTE-11); a reply joins one, on the same anchor, and makes it unread again for everyone else (NOTE-03).
      async ({ params: [pid], body }) => {
        await loadProject(pid);
        const itemKey = String(body?.itemKey ?? '');
        if (!KEY.test(itemKey)) throw new ValidationError('itemKey: expected issue-<number> or node-<id>');
        const said = text(body?.text ?? '', 4000, 'text').trim();
        if (!said) throw new ValidationError('text: required');
        const root = body?.replyTo ? await model.comments.get(pid, { itemKey, id: String(body.replyTo) }) : null;
        if (body?.replyTo && !root) throw new HttpError(404, 'The thread to reply in is gone');
        const anchor = root ? root.anchor : cleanAnchor(body?.anchor ?? {});
        const at = new Date(clock()).toISOString();
        const fromAgent = typeof body?.fromAgent === 'string' ? body.fromAgent : null;
        // On a behaviour in a refinement (#13 ADOPT-14): it is for the refinement's author, as a comment on a pull request is.
        const refinement = anchor.refinement ? await model.changesets.get(pid, anchor.refinement) : null;
        if (anchor.refinement && !refinement) throw new HttpError(404, 'That refinement is gone');
        // Every comment says who wrote it (#15 NOTE-21): one with no name would show as "Someone", and nobody could tell whose it is.
        if (!String(body?.author ?? '').trim()) throw new ValidationError('author: say who is commenting');
        const writer = author(body?.author);
        const forAuthor = refinement && !fromAgent && refinement.author !== writer;
        const agents = mentionsOf(said).length || forAuthor ? await model.agents.list(pid) : [];
        // Addressed to whoever it mentions (NOTE-14). One for an agent waits in the inbox until an agent replies, and
        // every agent call hands it on at once (NOTE-17); the thread says where it is.
        const to = addresseesOf(said, agents);
        if (forAuthor && !to.some((t) => t.name === refinement.author)) {
          const agent = agents.find((a) => !a.revokedAt && refinement.author === `${a.name} (${a.id})`);
          to.unshift(agent ? { name: refinement.author, agent: true, agentId: agent.id } : { name: refinement.author });
        }
        const comment = {
          id: commentId(),
          itemKey,
          anchor,
          ...(root ? { replyTo: root.id } : {}),
          text: said,
          ...(to.length ? { to } : {}),
          ...(typeof body?.refinement === 'string' && body.refinement ? { refinement: body.refinement.slice(0, 40) } : {}),
          author: writer,
          createdAt: at,
        };
        if (!root) comment.readBy = [comment.author];
        let thread = root && { ...root, readBy: [comment.author] };
        const agent = !fromAgent && to.find((t) => t.agent);
        if (agent) {
          const one = to.find((t) => t.agentId);
          await model.inbox.put(pid, { id: root?.id ?? comment.id, itemKey, at, ...(one ? { agentId: one.agentId } : {}) });
          const delivery = { state: 'waiting', for: one?.name ?? 'any agent', at };
          if (root) thread = { ...thread, delivery };
          else comment.delivery = delivery;
        } else if (fromAgent && root?.delivery && root.delivery.state !== 'replied') {
          thread = { ...thread, delivery: { ...root.delivery, state: 'replied', by: comment.author, at } };
          await model.inbox.delete(pid, root.id);
        }
        // A reply is a reply, wherever its thread is anchored: a comment is never an open question, so it answers none (NOTE-22).
        await model.comments.put(pid, comment);
        if (thread !== root) await model.comments.put(pid, thread);
        return { comment: annotationOf(comment), ...(thread !== root ? { thread: annotationOf(thread) } : {}) };
      },
      { status: 201 },
    ],

    [
      'POST',
      /^\/api\/projects\/([\w-]+)\/comments\/(issue-\d+|node-[\w-]+)\/([\w-]+)\/read$/,
      // A person has read a thread (NOTE-03): it shows as read for them until someone replies. Nothing moves.
      async ({ params: [pid, itemKey, id], body }) => {
        const comment = await rootOf(pid, itemKey, id);
        const by = author(body?.by);
        if ((comment.readBy ?? [comment.author]).includes(by)) return { comment: annotationOf(comment) };
        const read = { ...comment, readBy: [...(comment.readBy ?? [comment.author]), by] };
        await model.comments.put(pid, read);
        return { comment: annotationOf(read) };
      },
    ],

    [
      'POST',
      /^\/api\/projects\/([\w-]+)\/comments\/(issue-\d+|node-[\w-]+)\/([\w-]+)\/(dismiss|restore)$/,
      // Dismissing moves a thread to the item's conversation log, still readable there, naming who did it; restoring brings it
      // back (NOTE-05). People and agents both can; nothing dismisses itself.
      async ({ params: [pid, itemKey, id, action], body }) => {
        const comment = await rootOf(pid, itemKey, id);
        const at = new Date(clock()).toISOString();
        if (action === 'restore') {
          const { dismissed, resolved, cleared, ...back } = comment;
          if (!isDismissed(comment)) return { comment: annotationOf(comment) };
          await model.comments.put(pid, back);
          return { comment: annotationOf(back) };
        }
        if (isDismissed(comment)) throw new HttpError(409, 'This comment is already dismissed');
        const note = text(body?.note ?? '', 2000, 'note').trim();
        const done = { ...comment, dismissed: { by: author(body?.by), at, ...(note ? { note } : {}) } };
        await model.comments.put(pid, done);
        await model.inbox.delete(pid, id);
        return { comment: annotationOf(done) };
      },
    ],

    // ---- Open questions (#68): lines in an item's Open questions section, answered directly under each ----

    [
      'POST',
      /^\/api\/projects\/([\w-]+)\/questions$/,
      // A question is added to its item's Open questions, in place of "None.", at once: a question decides nothing, so it
      // waits for no adoption, and reaches the store with the next save like any accepted edit (ANSWER-07). Who asked, and
      // when, are kept beside the text. Asking the same question again changes nothing.
      async ({ params: [pid], body }) => {
        const itemKey = String(body?.itemKey ?? '');
        if (!KEY.test(itemKey)) throw new ValidationError('itemKey: expected issue-<number> or node-<id>');
        const said = text(body?.text ?? '', 2000, 'text').replace(/\s+/g, ' ').trim();
        if (!said) throw new ValidationError('text: required');
        const id = questionId(itemKey, said);
        const { nodes } = await loadProject(pid);
        const node = findItem(nodes, itemKey);
        if (!node) throw new HttpError(404, 'No such item on the map');
        const there = questionsIn(itemKey, editableOf(node).markdown).some((q) => q.id === id);
        const res = there ? { node } : await rewrite(pid, itemKey, (md) => withQuestion(md, said));
        const meta = await model.questions.get(pid, { itemKey, id });
        if (!meta?.asked) {
          const agentId = typeof body?.agentId === 'string' ? body.agentId.slice(0, 40) : null;
          await model.questions.put(pid, { ...meta, itemKey, id, text: said, asked: { by: author(body?.author), at: new Date(clock()).toISOString(), ...(agentId ? { agentId } : {}) } });
        }
        return { question: { id, itemKey, text: said }, ...res };
      },
      { status: 201 },
    ],

    [
      'POST',
      /^\/api\/projects\/([\w-]+)\/questions\/(issue-\d+|node-[\w-]+)\/([\w-]+)\/(answer|prompt)$/,
      // Answering writes the answer directly under its question, as "Answer: …" (ANSWER-01), and it goes to an agent with
      // one prompt (ANSWER-02); the prompt is kept only if the person changed it (ANSWER-05). Who answered, and when, are
      // kept beside the text. `prompt` is that prompt, built as if the answer were written, to read and change first.
      async ({ params: [pid, itemKey, id, action], body }) => {
        const said = text(body?.text ?? '', 4000, 'text').replace(/\s+/g, ' ').trim();
        if (!said) throw new ValidationError('text: required');
        const by = author(body?.by ?? body?.author);
        const { nodes } = await loadProject(pid);
        const node = findItem(nodes, itemKey);
        if (!node) throw new HttpError(404, 'No such item on the map');
        const meta = await model.questions.get(pid, { itemKey, id });
        const question = questionsOfNode(node, meta ? [meta] : []).find((q) => q.id === id);
        if (!question) throw new HttpError(404, 'That question is no longer in its item\'s Open questions');
        const answered = withAnswer(editableOf(node).markdown, itemKey, id, said);
        const as = nodes.map((n) => (n === node ? applyTo(n, { ...editableOf(n), markdown: answered }, n.updatedAt) : n));
        const built = answerPrompt({ nodes: as, question, answer: said, answeredBy: by });
        if (action === 'prompt') return { prompt: built };
        const res = await rewrite(pid, itemKey, (md) => withAnswer(md, itemKey, id, said));
        const asked = body?.prompt == null ? '' : text(body.prompt, 40000, 'prompt').trim();
        const { handedAt, refinement, applied, ...kept } = meta ?? {};
        const answer = { text: said, by, at: new Date(clock()).toISOString(), ...(asked && asked !== built.trim() ? { prompt: asked } : {}) };
        await model.questions.put(pid, { ...kept, itemKey, id, text: question.text, answered: answer });
        return { question: { ...question, answer: said, answered: answer }, prompt: answer.prompt ?? built, ...res };
      },
    ],

    [
      'POST',
      /^\/api\/projects\/([\w-]+)\/comments\/(issue-\d+|node-[\w-]+)\/([\w-]+)\/promote$/,
      // Any comment becomes a child task in the strict shape (NOTE-06), linked both ways: the task names the comment, and
      // the comment names the task. The task is new in the person's refinement, like any item they add (NEW-01). The
      // thread says so, and the comment is dismissed into the conversation log, since the task has taken it on (NOTE-05).
      async ({ params: [pid, itemKey, id], body }) => {
        const note = await rootOf(pid, itemKey, id);
        if (isDismissed(note)) throw new HttpError(409, 'This comment is dismissed: restore it first');
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
        const title = (first || 'From a comment').slice(0, 120);
        const template = newItemMarkdown({ kind: 'task', partOf: partOf(stores.forProject(project), parent), place: placeOf(editableOf(parent).markdown) });
        const said = note.anchor?.quote ? ` at “${note.anchor.quote.slice(0, 200)}”` : '';
        const why = `${note.author} commented on ${parent.title}, in ${whereOf(note.anchor)}${said}:\n\n${note.text.split('\n').map((l) => `> ${l}`).join('\n')}\n\nFrom comment ${note.id} on ${itemKey}.`;
        const markdown = writeIssue(parseIssue(template), { Why: why });
        const { node, changeset } = await call('POST', `/api/projects/${pid}/changesets/${encodeURIComponent(cid)}/new`, { parentId: parent.id, kind: 'task', title, markdown });
        const at = new Date(clock()).toISOString();
        const task = { key: itemKeyOf(node), title: node.title };
        const told = { id: commentId(), itemKey, anchor: note.anchor, replyTo: note.id, text: `Made it a task: ${node.title}.`, task, author: by, createdAt: at };
        const comment = { ...note, task, readBy: [by], dismissed: { by, at, task } };
        await model.comments.put(pid, told);
        await model.comments.put(pid, comment);
        await model.inbox.delete(pid, id);
        return { comment: annotationOf(comment), reply: told, node, changeset };
      },
      { status: 201 },
    ],

    // ---- Splitting an item (#32 STATE-14) ----

    [
      'GET',
      /^\/api\/projects\/([\w-]+)\/items\/(issue-\d+|node-[\w-]+)\/split$/,
      // Whether an item needs a split before it can be built (STATE-10), and what would move: the panel offers Split from this.
      async ({ params: [pid, key] }) => {
        const { project, nodes } = await loadProject(pid);
        const node = findItem(nodes, key);
        if (!node) throw new HttpError(404, 'No such item on the map');
        return { split: splitOf(node, childrenOf(nodes).get(node.id) ?? [], new Set(project?.tested ?? [])) };
      },
    ],

    [
      'POST',
      /^\/api\/projects\/([\w-]+)\/items\/(issue-\d+|node-[\w-]+)\/split$/,
      // Split an item that needs it (STATE-10, STATE-14): the behaviours it still has to build move, word for word and with
      // their IDs, into a new child task; the item keeps what's built and says where the rest went. Both changes are in the
      // person's refinement, to accept or discard like any edit (NEW-01), and nothing else about the item changes.
      async ({ params: [pid, key], body }) => {
        const { project, nodes } = await loadProject(pid);
        const parent = findItem(nodes, key);
        if (!parent) throw new HttpError(404, 'No such item on the map');
        const split = splitOf(parent, childrenOf(nodes).get(parent.id) ?? [], new Set(project?.tested ?? []));
        if (!split) throw new HttpError(409, 'This item doesn\'t need a split');
        const by = author(body?.by);
        const call = async (method, path, b) => {
          const res = await handle({ method, path, body: b, trusted: true });
          if (res.status >= 400) throw new HttpError(res.status, res.body?.error ?? 'Failed');
          return res.body;
        };
        const was = editableOf(parent);
        const shape = parseIssue(was.markdown);
        const leaving = new Set(split.still_to_build);
        const kept = [];
        const moved = [];
        for (const row of parseBehaviours(sectionText(shape, 'Behaviours'))) {
          if (!leaving.has(row.id)) {
            kept.push(row.raw);
            continue;
          }
          // A heading or note written after a behaviour is read as part of it: it stays with the item, not the behaviour.
          const lines = row.raw.split('\n');
          const cut = lines.findIndex((l, i) => i > 0 && /^\s*(#|$)/.test(l));
          moved.push(lines.slice(0, cut < 0 ? lines.length : cut).join('\n'));
          if (cut >= 0) kept.push(lines.slice(cut).join('\n'));
        }
        const short = parent.title.replace(/^#\d+\s+/, '');
        const title = `${short}: what's left to build`.slice(0, 120);
        const cid = body?.changeset ? String(body.changeset) : (await call('POST', `/api/projects/${pid}/changesets`, { scopeId: parent.id, author: by })).changeset.id;
        const template = newItemMarkdown({ kind: 'task', partOf: partOf(stores.forProject(project), parent), place: placeOf(was.markdown) });
        const why = `Split from ${parent.title} (STATE-10): the behaviours it still had to build, moved here word for word. ${parent.title} keeps ${split.looks_built.join(', ') || 'what is built'}.`;
        const markdown = writeIssue(parseIssue(template), { Why: why, Behaviours: moved.join('\n'), 'Open questions': 'None.' });
        const { node } = await call('POST', `/api/projects/${pid}/changesets/${encodeURIComponent(cid)}/new`, { parentId: parent.id, kind: 'task', title, markdown });
        const oldWhy = sectionText(shape, 'Why').trim();
        const note = `What was left to build (${split.still_to_build.join(', ')}) moved to the child "${node.title}".`;
        const after = { title: was.title, markdown: writeIssue(shape, { Why: oldWhy ? `${oldWhy}\n\n${note}` : note, Behaviours: kept.join('\n') }) };
        const { changeset } = await call('PUT', `/api/projects/${pid}/changesets/${encodeURIComponent(cid)}/items`, { key, ...after });
        return { node, changeset, moved: split.still_to_build };
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
        if (!delivery) return { handled: false };
        // What a pull request's closing means for the claims it carries is agents' business, not the map's (HANDOFF-11).
        const pulls = delivery.events.filter((e) => e.type === 'pull_closed');
        for (const pid of pulls.length ? await model.links.projectsOf(delivery.key) : []) for (const e of pulls) await agents.pullClosed(pid, e);
        return sync.onEvents(delivery.key, delivery.events.filter((e) => e.type !== 'pull_closed'));
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
        const saved = await saveNewProject(data, 'github', { githubRepo: data.title, strictLifecycle: data.strictLifecycle, guide: data.guide, tested: data.tested, airports: data.airports, waste: data.waste });
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
        const data = await store.mapAgain({ token: body?.token || undefined, previous: project });
        const kept = keepPending(data.nodes, await model.nodes.pending(pid), store);
        await model.nodes.replace(pid, kept.nodes);
        const updated = await touchProject(project, kept.nodes, data.project);
        await model.links.link(store.key, pid);
        return { project: updated, nodes: kept.nodes };
      },
    ],

    // ---- The spec checks itself (#36): deterministic checks on every read, near pairs found by a script with a model ----

    [
      'GET',
      /^\/api\/projects\/([\w-]+)\/coherence$/,
      // The same behaviour ID in two items and two words for one thing (COHERE-01), worked out from the map as it is now, and
      // the close pairs a check found whose behaviours still read as they did (COHERE-04), each naming its model (COHERE-07).
      async ({ params: [pid] }) => {
        const { nodes } = await loadProject(pid);
        const list = behavioursOn(nodes);
        const now = new Map(list.map((b) => [`${b.item}:${b.id}`, b]));
        const current = (s) => now.get(`${s.item}:${s.id}`)?.hash === s.hash;
        const found = await model.findings.list(pid);
        const show = (s) => ({ id: s.id, item: s.item, title: now.get(`${s.item}:${s.id}`).title, text: now.get(`${s.item}:${s.id}`).text });
        const pairs = found.filter((f) => current(f.a) && current(f.b)).sort((p, q) => q.cosine - p.cosine || (p.key < q.key ? -1 : 1));
        return {
          vocabulary: VOCABULARY,
          duplicate_ids: duplicateIds(list),
          drift: vocabularyDrift(list),
          pairs: pairs.map((f) => ({ key: f.key, cosine: f.cosine, model: f.model, ...(f.version ? { version: f.version } : {}), a: show(f.a), b: show(f.b), ...(f.judged ? { judged: f.judged } : {}) })),
          stale: found.length - pairs.length,
        };
      },
    ],

    // Every behaviour with the hash of its words: what a check embeds, and how it tells what changed since it last ran.
    ['GET', /^\/api\/projects\/([\w-]+)\/coherence\/behaviours$/, async ({ params: [pid] }) => ({ behaviours: behavioursOn((await loadProject(pid)).nodes) })],

    [
      'PUT',
      /^\/api\/projects\/([\w-]+)\/coherence\/pairs$/,
      // A check's close pairs. A pair found again with the same words keeps its judgement; one whose words changed starts over.
      async ({ params: [pid], body }) => {
        await loadProjectHead(pid);
        const pairs = Array.isArray(body?.pairs) ? body.pairs : null;
        if (!pairs) throw new ValidationError('pairs: expected an array');
        if (pairs.length > 500) throw new ValidationError('pairs: at most 500 at once');
        const side = (s, what) => {
          if (!KEY.test(String(s?.item)) || !BEHAVIOUR.test(String(s?.id)) || !/^[0-9a-f]{16}$/.test(String(s?.hash))) throw new ValidationError(`${what}: expected { id, item, hash }`);
          return { id: s.id, item: s.item, hash: s.hash };
        };
        const at = new Date(clock()).toISOString();
        const had = new Map((await model.findings.list(pid)).map((f) => [f.key, f]));
        const list = pairs.map((p, i) => {
          const a = side(p.a, `pairs[${i}].a`);
          const b = side(p.b, `pairs[${i}].b`);
          const key = pairKey(a, b);
          const cosine = Number(p.cosine);
          if (!(cosine >= -1 && cosine <= 1)) throw new ValidationError(`pairs[${i}].cosine: expected a number from -1 to 1`);
          const was = had.get(key);
          const same = was && was.a.hash === a.hash && was.b.hash === b.hash;
          const modelName = text(p.model ?? '', 200, `pairs[${i}].model`);
          if (!modelName) throw new ValidationError(`pairs[${i}].model: required, so a finding says what found it (COHERE-07)`);
          return { key, a, b, cosine, model: modelName, ...(p.version ? { version: text(p.version, 200, `pairs[${i}].version`) } : {}), foundAt: same ? was.foundAt : at, ...(same && was.judged ? { judged: was.judged } : {}) };
        });
        await model.findings.put(pid, list);
        return { recorded: list.length };
      },
    ],

    [
      'POST',
      /^\/api\/projects\/([\w-]+)\/coherence\/judge$/,
      // Someone looked at a pair. A duplicate or a contradiction becomes an open question on both items, each naming the
      // other, so reconciling them is ordinary refinement (COHERE-05).
      async ({ params: [pid], body }) => {
        const key = String(body?.pair ?? '');
        const verdict = String(body?.verdict ?? '');
        if (!VERDICTS.includes(verdict)) throw new ValidationError(`verdict: one of ${VERDICTS.join(', ')}`);
        const finding = await model.findings.get(pid, key);
        if (!finding) throw new HttpError(404, 'No such pair: coherence() lists them');
        const note = text(body?.note ?? '', 1000, 'note').replace(/\s+/g, ' ').trim();
        const by = author(body?.by);
        const asked = [];
        if (verdict === 'duplicate' || verdict === 'contradiction') {
          const { nodes } = await loadProject(pid);
          const titleOf = (item) => findItem(nodes, item)?.title ?? item;
          const say = (here, there) => `${here.id} and ${there.id} in ${titleOf(there.item)} look like a ${verdict}${note ? `: ${note}` : ''}. Which should hold, and should one change?`;
          for (const [here, there] of [[finding.a, finding.b], [finding.b, finding.a]]) {
            const res = await handle({ method: 'POST', path: `/api/projects/${pid}/questions`, body: { itemKey: here.item, text: say(here, there), author: by, agentId: body?.agentId }, trusted: true });
            if (res.status >= 400) throw new HttpError(res.status, res.body?.error ?? 'Could not ask');
            asked.push({ item: here.item, question: res.body.question.id });
          }
        }
        const judged = { verdict, by, at: new Date(clock()).toISOString(), ...(note ? { note } : {}), ...(asked.length ? { asked } : {}) };
        await model.findings.put(pid, [{ ...finding, judged }]);
        return { pair: key, judged };
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

    // What went wrong in someone's browser (#71 SHIP-14): the app sends each error it catches, so it can be read here.
    [
      'POST',
      /^\/api\/errors$/,
      async ({ body }) => {
        const clip = (v, max) => (v == null ? undefined : String(v).slice(0, max));
        const report = {
          id: newId(),
          at: new Date(clock()).toISOString(),
          message: clip(body?.message, 1000) || 'Unknown error',
          stack: clip(body?.stack, 8000),
          componentStack: clip(body?.componentStack, 8000),
          where: clip(body?.where, 80),
          url: clip(body?.url, 500),
          userAgent: clip(body?.userAgent, 300),
          build: clip(body?.build, 200),
        };
        log.error?.(`Browser error (${report.where ?? 'app'}): ${report.message}`);
        await model.errors.put(report);
        return { id: report.id };
      },
      { status: 201 },
    ],
    ['GET', /^\/api\/errors$/, async () => ({ errors: await model.errors.list(clock()) })],

    // A production deploy finished (#14 HANDOFF-11): the Production workflow says which merged pull requests it carried, and
    // whether it succeeded. Their claims end only when it did.
    [
      'POST',
      /^\/api\/deploys$/,
      async ({ body }) => {
        const repo = String(body?.repo ?? '');
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new ValidationError('repo: expected owner/name');
        if (!['success', 'failure'].includes(body?.outcome)) throw new ValidationError('outcome: success or failure');
        const pulls = Array.isArray(body?.pulls) ? body.pulls.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 200) : [];
        const sha = String(body?.sha ?? '').slice(0, 40);
        const projects = await model.links.projectsOf(githubKey(repo));
        return { projects: await Promise.all(projects.map(async (pid) => ({ project: pid, ...(await agents.deployed(pid, { sha, outcome: body.outcome, pulls })) }))) };
      },
    ],

    // Build requests (#14 HANDOFF-05): what waits for a builder, and what the card may offer to build.
    ['GET', /^\/api\/projects\/([\w-]+)\/builds$/, async ({ params: [pid] }) => {
      const { project, nodes } = await loadProject(pid);
      const { live } = await agents.liveClaims(pid);
      const [requests, notes] = await Promise.all([agents.buildRequests(pid, { nodes, live }), agents.buildNotes(pid, { live })]);
      const asked = new Set(requests.flatMap((r) => r.waiting));
      const buildable = {};
      for (const w of nextWork(nodes, live, { tested: project?.tested }).work) {
        const open = w.behaviours.map((b) => b.id).filter((id) => !asked.has(id));
        if (open.length) buildable[w.item] = open;
      }
      return { requests: requests.map(({ prompt, ...r }) => r), buildable, notes };
    }],

    // Only people choose Build: an agent's call through MCP is refused. Anyone with the project's access key may, since that
    // is who can change it today; checking the person's own write access to the repository comes with #52 (Sign in with GitHub).
    [
      'POST',
      /^\/api\/projects\/([\w-]+)\/builds$/,
      async ({ params: [pid], body }) => {
        const key = String(body?.item ?? '');
        if (!KEY.test(key)) throw new ValidationError('item: expected an item key');
        const behaviours = body?.behaviours == null ? [] : Array.isArray(body.behaviours) ? body.behaviours.map(String) : null;
        if (!behaviours) throw new ValidationError('behaviours: expected a list of behaviour IDs');
        const project = await loadProjectHead(pid);
        let { request, already } = await agents.requestBuild(pid, { item: key, behaviours, by: author(body?.by) });
        // A new request starts the project's runner, its own GitHub Actions (HANDOFF-07). If it can't be started, the request
        // still waits for an open session (HANDOFF-10), and the card says why the runner didn't start.
        const store = !already && stores.forProject(project);
        if (store?.startBuild) {
          const at = new Date(clock()).toISOString();
          const runner = await store.startBuild({ request: request.id, item: key, behaviours: request.behaviours }).then(
            () => ({ state: 'started', at }),
            (err) => ({ state: 'not_started', at, reason: err.message }),
          );
          const { waiting, stale, ...stored } = request;
          await model.builds.put(pid, { ...stored, runner });
          request = { ...request, runner };
        }
        const { prompt, ...shown } = request;
        return { request: shown, ...(already ? { already: true } : {}) };
      },
      { status: 201, people: true },
    ],

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
        if (opts.people && trusted) throw new HttpError(403, 'Only a person can do this');
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
