// Writing to GitHub as the Overworld GitHub App. Each request uses a short-lived installation token,
// minted from the App's private key and kept in memory only, never stored. The key itself comes from
// .conf/ locally and from AWS once deployed; this file is only handed a way to read it.

import { createSign } from 'node:crypto';

const API = 'https://api.github.com';

/** A failure worth retrying (GitHub slow, down or rate-limited), and when to try again at the earliest. */
export class TransientError extends Error {
  constructor(message, retryAt = null) {
    super(message);
    this.transient = true;
    this.retryAt = retryAt;
  }
}

/** A failure that retrying won't fix (no such issue, no access, a rejected edit): it needs a person. */
export class PermanentError extends Error {}

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

/**
 * @param {object} o
 * @param {string|number} o.appId
 * @param {string|number} o.installationId
 * @param {string} o.slug the App's slug: issues it creates are by `<slug>[bot]`
 * @param {() => Promise<string>} o.privateKey reads the PEM when first needed
 */
export function githubApp({ appId, installationId, slug, privateKey, fetchImpl = fetch, now = () => Date.now() }) {
  let cached = null;

  async function appJwt() {
    const iat = Math.floor(now() / 1000) - 60; // GitHub allows for clock drift
    const body = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({ iat, exp: iat + 540, iss: String(appId) })}`;
    return `${body}.${createSign('RSA-SHA256').update(body).sign(await privateKey(), 'base64url')}`;
  }

  /** An installation token, minted again five minutes before it runs out. */
  async function token() {
    if (cached && cached.expiresAt - 300_000 > now()) return cached.token;
    const json = await send('POST', `/app/installations/${installationId}/access_tokens`, null, `Bearer ${await appJwt()}`);
    cached = { token: json.token, expiresAt: Date.parse(json.expires_at) };
    return cached.token;
  }

  async function send(method, path, body, auth) {
    let res;
    try {
      res = await fetchImpl(`${API}${path}`, {
        method,
        headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'projectmap', authorization: auth, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new TransientError(`GitHub unreachable: ${err.message}`);
    }
    if (res.ok) return res.status === 204 ? null : res.json();
    const h = (k) => res.headers?.get?.(k);
    const limited = res.status === 429 || (res.status === 403 && (h('x-ratelimit-remaining') === '0' || h('retry-after')));
    if (limited) {
      const at = h('retry-after') ? now() + Number(h('retry-after')) * 1000 : h('x-ratelimit-reset') ? Number(h('x-ratelimit-reset')) * 1000 : null;
      throw new TransientError(`GitHub rate limit on ${path}`, at && new Date(at).toISOString());
    }
    if (res.status === 401) {
      cached = null;
      throw new TransientError('GitHub refused the token; a new one is minted next time');
    }
    if (res.status >= 500) throw new TransientError(`GitHub ${res.status} on ${path}`);
    throw new PermanentError(`GitHub ${res.status} on ${method} ${path}`);
  }

  const call = async (method, path, body) => send(method, path, body, `Bearer ${await token()}`);

  return {
    token,
    getIssue: (repo, number) => call('GET', `/repos/${repo}/issues/${number}`),
    /** Only the fields given: title, body, state, state_reason, labels. */
    updateIssue: (repo, number, patch) => call('PATCH', `/repos/${repo}/issues/${number}`, patch),
    createIssue: (repo, { title, body, labels }) => call('POST', `/repos/${repo}/issues`, { title, body, labels }),
    /** The issue this App created, since `since`, whose body carries `marker`: the record of a create that crashed before it was written down. */
    async findCreated(repo, marker, since) {
      const q = new URLSearchParams({ creator: `${slug}[bot]`, state: 'all', since, sort: 'created', direction: 'desc', per_page: '50' });
      const list = await call('GET', `/repos/${repo}/issues?${q}`);
      return list.find((i) => !i.pull_request && (i.body ?? '').includes(marker)) ?? null;
    },
  };
}
