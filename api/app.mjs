// HTTP-agnostic API. `handle({ method, path, headers, body })` -> { status, body }.
// Used by the Lambda handler in AWS and by the Vite dev server locally.

import { createHash, timingSafeEqual } from 'node:crypto';
import { ROOT_ID, ValidationError, newId, sanitizeNode } from '../shared/schema.js';
import { demoProject } from './seed.mjs';
import { importGitHub } from './github.mjs';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const digest = (s) => createHash('sha256').update(String(s)).digest();

export function createApi({ model, accessKey = '', fetchImpl = fetch, log = console }) {
  const expected = accessKey ? digest(accessKey) : null;

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
        await loadProject(pid);
        await model.projects.delete(pid);
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
        const node = { ...current, ...patch, id: nid, updatedAt: new Date().toISOString() };
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
        const doomed = new Set(subtreeIds(nodes, nid));
        await model.nodes.delete(pid, [...doomed]);
        const now = new Date().toISOString();
        const updated = nodes
          .filter((n) => !doomed.has(n.id) && n.links?.some((l) => doomed.has(l.to)))
          .map((n) => ({ ...n, links: n.links.filter((l) => !doomed.has(l.to)), updatedAt: now }));
        if (updated.length) await model.nodes.put(pid, updated);
        const remaining = nodes.filter((n) => !doomed.has(n.id));
        const updatedProject = await touchProject(project, remaining);
        return { deleted: [...doomed], updated, project: updatedProject };
      },
    ],

    ['POST', /^\/api\/import\/json$/, async ({ body }) => saveNewProject(fromImport(body), 'json'), { status: 201 }],

    [
      'POST',
      /^\/api\/import\/github$/,
      async ({ body }) => {
        const data = await importGitHub({ repo: body?.repo, token: body?.token || undefined }, fetchImpl);
        return saveNewProject(data, 'github', { githubRepo: data.title });
      },
      { status: 201 },
    ],

    [
      'POST',
      /^\/api\/projects\/([\w-]+)\/refresh$/,
      // Map the repository again, in place: same project, same link, today's code and issues.
      async ({ params: [pid], body }) => {
        const { project } = await loadProject(pid);
        if (!project.githubRepo) throw new ValidationError('only projects imported from GitHub can be refreshed');
        const data = await importGitHub({ repo: project.githubRepo, token: body?.token || undefined }, fetchImpl);
        await model.nodes.replace(pid, data.nodes);
        const updated = await touchProject(project, data.nodes);
        return { project: updated, nodes: data.nodes };
      },
    ],
  ];

  return async function handle({ method, path, headers = {}, body = null }) {
    try {
      for (const [m, re, fn, opts = {}] of routes) {
        const match = path.match(re);
        if (!match || m !== method) continue;
        if (!opts.public) authorize(headers);
        const result = await fn({ params: match.slice(1), body, headers });
        return { status: opts.status ?? 200, body: result };
      }
      const pathKnown = routes.some(([, re]) => re.test(path));
      throw new HttpError(pathKnown ? 405 : 404, pathKnown ? 'Method not allowed' : 'Not found');
    } catch (err) {
      const status = err.status ?? 500;
      if (status >= 500) log.error?.(err);
      return { status, body: { error: status >= 500 ? 'Internal error' : err.message } };
    }
  };
}
