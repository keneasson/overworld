// A collaborator without an editor (prototype): joins an item's live document under its own name and colour, so every
// open editor shows its caret and label, and reaches the app's API for what lives beside the text (comments).

import { parseArgs } from 'node:util';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';

export function options(extra = {}) {
  const { values } = parseArgs({
    options: {
      item: { type: 'string' },
      project: { type: 'string' },
      app: { type: 'string', default: process.env.APP_URL ?? 'http://localhost:5173' },
      live: { type: 'string', default: process.env.LIVE_URL ?? 'ws://localhost:1234' },
      ...extra,
    },
  });
  if (!values.item || !/^(issue-\d+|node-[\w-]+)$/.test(values.item)) throw new Error('--item issue-<number> (or node-<id>) is required');
  return values;
}

export function http(app) {
  const key = process.env.ACCESS_KEY ?? '';
  return async (method, path, body) => {
    const res = await fetch(`${app}${path}`, { method, headers: { 'content-type': 'application/json', ...(key ? { 'x-projectmap-key': key } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const out = res.status === 204 ? null : await res.json();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${out?.error ?? ''}`);
    return out;
  };
}

/** The project holding the item, and the item: the one named, or the first project that has it (mapped repositories first). */
export async function findItem(call, item, project) {
  const nid = item.startsWith('issue-') ? item : item.slice(5);
  const { projects } = await call('GET', '/api/projects');
  const order = project ? projects.filter((p) => p.id === project) : [...projects].sort((a, b) => Number(Boolean(b.githubRepo)) - Number(Boolean(a.githubRepo)));
  for (const p of order) {
    const { nodes } = await call('GET', `/api/projects/${p.id}`);
    const node = nodes.find((n) => n.id === nid);
    if (node) return { pid: p.id, node };
  }
  throw new Error(`No project here has ${item}${project ? ` (looked in ${project})` : ''}`);
}

/** Joins the item's live document as `user` ({ name, color }). Resolves once the document has arrived. */
export async function join({ live, pid, item, user }) {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({ url: live, name: `${pid}/${item}`, document: doc });
  provider.awareness.setLocalStateField('user', user);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`No live document at ${live}: is npm run dev running?`)), 8000);
    provider.on('synced', () => {
      clearTimeout(t);
      resolve();
    });
  });
  const leave = async () => {
    provider.awareness.setLocalState(null);
    await new Promise((r) => setTimeout(r, 300));
    provider.destroy();
  };
  return { doc, provider, leave, setCursor: (cursor) => provider.awareness.setLocalStateField('cursor', cursor) };
}
