export class AuthError extends Error {}

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
    headers: { 'content-type': 'application/json', ...(accessKey ? { 'x-projectmap-key': accessKey } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new AuthError(data.error ?? 'Access key required');
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

export const api = {
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
};
