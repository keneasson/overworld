// Not let in: `signIn` lists the providers to sign in with (#52), empty when only the access key opens it; `notLetIn` means
// signed in, but this account hasn't been let in.
export class AuthError extends Error {
  constructor(message, { signIn = [], notLetIn = false } = {}) {
    super(message);
    this.signIn = signIn;
    this.notLetIn = notLetIn;
  }
}

const KEY = 'projectmap.key';
const storage = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      if (v == null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      // private mode: keep it in memory only
    }
  },
};
export { storage };

let accessKey = storage.get(KEY) ?? '';

export function setAccessKey(k) {
  accessKey = k ?? '';
  storage.set(KEY, k || null);
}

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    // The CSRF header: a signed-in person's changes must carry it (#52), and a page on another site can't send it.
    headers: { 'content-type': 'application/json', 'x-projectmap-csrf': '1', ...(accessKey ? { 'x-projectmap-key': accessKey } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new AuthError(data.error ?? 'Access key required', { signIn: data.signIn ?? [] });
  if (res.status === 403 && data.notLetIn) throw new AuthError(data.error, { notLetIn: true });
  if (!res.ok) throw Object.assign(new Error(data.error ?? `Request failed (${res.status})`), { status: res.status, conflicts: data.conflicts });
  return data;
}

export const api = {
  session: () => request('GET', '/api/session'),
  signOut: () => fetch('/api/auth/signout', { method: 'POST', headers: { 'x-projectmap-csrf': '1' } }),
  listProjects: () => request('GET', '/api/projects'),
  getProject: (id) => request('GET', `/api/projects/${id}`),
  createProject: (body) => request('POST', '/api/projects', body),
  deleteProject: (id) => request('DELETE', `/api/projects/${id}`),
  createNode: (pid, node) => request('POST', `/api/projects/${pid}/nodes`, { node }),
  patchNode: (pid, id, patch) => request('PATCH', `/api/projects/${pid}/nodes/${id}`, patch),
  deleteNode: (pid, id) => request('DELETE', `/api/projects/${pid}/nodes/${id}`),
  importJson: (data) => request('POST', '/api/import/json', data),
  importGithub: (body) => request('POST', '/api/import/github', body),
  refreshGithub: (id, body) => request('POST', `/api/projects/${id}/refresh`, body),
  listChangesets: (pid) => request('GET', `/api/projects/${pid}/changesets`),
  createChangeset: (pid, body) => request('POST', `/api/projects/${pid}/changesets`, body),
  putChangesetItem: (pid, cid, item) => request('PUT', `/api/projects/${pid}/changesets/${cid}/items`, item),
  newChangesetItem: (pid, cid, item) => request('POST', `/api/projects/${pid}/changesets/${cid}/new`, item),
  dropChangesetItem: (pid, cid, key) => request('DELETE', `/api/projects/${pid}/changesets/${cid}/items/${key}`),
  decideChangesetItem: (pid, cid, key, action, body) => request('POST', `/api/projects/${pid}/changesets/${cid}/items/${key}/${action}`, body),
  acceptChangeset: (pid, cid) => request('POST', `/api/projects/${pid}/changesets/${cid}/accept`),
  discardChangeset: (pid, cid) => request('POST', `/api/projects/${pid}/changesets/${cid}/discard`),
  save: (pid, keys) => request('POST', `/api/projects/${pid}/save`, keys ? { keys } : {}),
  itemComments: (pid, itemKey) => request('GET', `/api/projects/${pid}/comments/${itemKey}`),
  addComment: (pid, comment) => request('POST', `/api/projects/${pid}/comments`, comment),
  readComment: (pid, c, body) => request('POST', `/api/projects/${pid}/comments/${c.itemKey}/${c.id}/read`, body),
  promoteComment: (pid, c, body) => request('POST', `/api/projects/${pid}/comments/${c.itemKey}/${c.id}/promote`, body),
  dismissComment: (pid, c, body) => request('POST', `/api/projects/${pid}/comments/${c.itemKey}/${c.id}/dismiss`, body),
  restoreComment: (pid, c) => request('POST', `/api/projects/${pid}/comments/${c.itemKey}/${c.id}/restore`, {}),
  openNotes: (pid) => request('GET', `/api/projects/${pid}/notes`),
  answerQuestion: (pid, itemKey, id, body) => request('POST', `/api/projects/${pid}/questions/${itemKey}/${id}/answer`, body),
  questionPrompt: (pid, itemKey, id, body) => request('POST', `/api/projects/${pid}/questions/${itemKey}/${id}/prompt`, body),
  reportError: (report) => request('POST', '/api/errors', report),
  claims: (pid) => request('GET', `/api/projects/${pid}/claims`),
  coverage: (pid) => request('GET', `/api/projects/${pid}/coverage`),
  builds: (pid) => request('GET', `/api/projects/${pid}/builds`),
  requestBuild: (pid, body) => request('POST', `/api/projects/${pid}/builds`, body),
  splitOf: (pid, key) => request('GET', `/api/projects/${pid}/items/${key}/split`),
  splitItem: (pid, key, body) => request('POST', `/api/projects/${pid}/items/${key}/split`, body),
  listAgents: (pid) => request('GET', `/api/projects/${pid}/agents`),
  createAgent: (pid, body) => request('POST', `/api/projects/${pid}/agents`, body),
  revokeAgent: (pid, id) => request('DELETE', `/api/projects/${pid}/agents/${id}`),
  pinComment: (pid, c, body) => request('POST', `/api/projects/${pid}/comments/${c.itemKey}/${c.id}/pin`, body),
  photos: (pid, itemKey) => request('GET', `/api/projects/${pid}/photos/${itemKey}`),
  photo: (pid, itemKey, id) => request('GET', `/api/projects/${pid}/photos/${itemKey}/${id}`),
  addPhoto: (pid, body) => request('POST', `/api/projects/${pid}/photos`, body),
  deletePhoto: (pid, p) => request('DELETE', `/api/projects/${pid}/photos/${p.itemKey}/${p.id}`),
  deleteComment: (pid, c) => request('DELETE', `/api/projects/${pid}/comments/${c.itemKey}/${c.id}`),
};
