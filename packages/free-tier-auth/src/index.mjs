import { AuthError, random, sha256 } from './util.mjs';
import { cookie, clearCookie, readCookies } from './cookies.mjs';
import { githubProvider } from './github.mjs';
import { refresh, revoke, signInNative } from './bridge.mjs';
import { createAccounts } from './accounts.mjs';

export { AuthError } from './util.mjs';
export { memoryStore } from './memory-store.mjs';

const DAY = 86_400_000;
const value = async (v) => (typeof v === 'function' ? v() : v);

// Sign-in on Amazon Cognito's free tier. Framework-neutral: `handle` takes { method, path, query, headers } and returns
// { status, headers, cookies, body } for the sign-in routes (or null for anything else); `person` reads the session cookie.
//
// config: baseUrl (where the app is served), basePath ('/auth'), cookieName ('session'), afterSignIn ('/'), sessionDays (30),
//   refreshEveryMs (1 hour), store (see memory-store.mjs), cognito: { client, userPoolId, clientId, clientSecret },
//   github: { clientId, clientSecret }, bridgeSecret, fetchImpl, clock.
// Secrets may be given as values or as async functions that fetch them.
//
// Providers share one shape ({ name, authorizeUrl, identify }), so another (Google, GitLab) can be added beside GitHub later.
export function createAuth(config) {
  const { store, cognito, fetchImpl = fetch, clock = Date.now } = config;
  if (!store || !cognito?.client || !config.baseUrl) throw new Error('free-tier-auth needs baseUrl, store and cognito');
  const basePath = config.basePath ?? '/auth';
  const cookieName = config.cookieName ?? 'session';
  const stateCookie = `${cookieName}_state`;
  const afterSignIn = config.afterSignIn ?? '/';
  const sessionMs = (config.sessionDays ?? 30) * DAY;
  const refreshEveryMs = config.refreshEveryMs ?? 3_600_000;
  const redirectUri = (provider) => `${config.baseUrl}${basePath}/${provider}/callback`;
  const pool = async () => ({ cognito: cognito.client, userPoolId: cognito.userPoolId, clientId: cognito.clientId, clientSecret: await value(cognito.clientSecret) });
  const bridge = async (username, profile) => signInNative({ ...(await pool()), bridgeSecret: await value(config.bridgeSecret), username, profile });

  const providers = {};
  if (config.github) providers.github = githubProvider({ ...config.github, bridge, fetchImpl });

  async function endSession(key) {
    const s = await store.get(`session#${key}`);
    if (!s) return;
    await revoke({ ...(await pool()), refreshToken: s.refreshToken });
    await store.delete(`session#${key}`);
    await store.delete(`personsession#${s.personId}#${key}`);
  }
  async function endSessionsOf(personId) {
    for (const { key } of await store.list(`personsession#${personId}#`)) await endSession(key.split('#')[2]);
  }
  const accounts = createAccounts({ store, endSessionsOf, clock });

  async function startSession(personId, { refreshToken, cognitoUsername }) {
    const sid = random(32);
    const key = sha256(sid); // the store holds only a hash, so a copy of the store can't be replayed as cookies
    const expiresAt = clock() + sessionMs;
    await store.put(`session#${key}`, { personId, refreshToken, cognitoUsername, expiresAt, refreshedAt: clock() }, { expiresAt });
    await store.put(`personsession#${personId}#${key}`, {}, { expiresAt });
    return cookie(cookieName, sid, { maxAge: sessionMs / 1000 });
  }

  // Who is signed in, from the cookie. Every so often the session is refreshed with Cognito; if Cognito says no, it ends.
  async function current(headers) {
    const sid = readCookies(headers)[cookieName];
    if (!sid) return null;
    const key = sha256(sid);
    const s = await store.get(`session#${key}`);
    if (!s || s.expiresAt <= clock()) return null;
    if (clock() - s.refreshedAt > refreshEveryMs) {
      if (!(await refresh({ ...(await pool()), cognitoUsername: s.cognitoUsername, refreshToken: s.refreshToken }))) { await endSession(key); return null; }
      await store.put(`session#${key}`, { ...s, refreshedAt: clock() }, { expiresAt: s.expiresAt });
    }
    const person = await store.get(`person#${s.personId}`);
    return person ? { person, sessionKey: key } : null;
  }

  const json = (status, body) => ({ status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, cookies: [], body: JSON.stringify(body) });
  const redirect = (location, cookies = []) => ({ status: 302, headers: { location, 'cache-control': 'no-store' }, cookies, body: '' });

  async function start(provider) {
    const state = random(24);
    await store.put(`state#${state}`, { provider: provider.name }, { expiresAt: clock() + 600_000 });
    return redirect(provider.authorizeUrl({ redirectUri: redirectUri(provider.name), state }), [cookie(stateCookie, state, { maxAge: 600, path: basePath })]);
  }

  async function callback(provider, query, headers) {
    // The state must match both the store and this browser's cookie, so a sign-in started elsewhere can't be finished here.
    const state = String(query.state ?? '');
    const saved = state && readCookies(headers)[stateCookie] === state ? await store.get(`state#${state}`) : null;
    if (state) await store.delete(`state#${state}`);
    if (!saved || saved.provider !== provider.name || !query.code) throw new AuthError(400, 'This sign-in link has expired; try again');
    const who = await provider.identify({ redirectUri: redirectUri(provider.name), code: String(query.code) });
    const tokens = await who.signIn();
    const idKey = `identity#${who.provider}#${who.subject}`;
    let personId = (await store.get(idKey))?.personId;
    if (!personId) {
      personId = random(16);
      await store.put(idKey, { personId });
      await store.put(`personidentity#${personId}#${who.provider}#${who.subject}`, { provider: who.provider, subject: who.subject });
    }
    const before = await store.get(`person#${personId}`);
    await store.put(`person#${personId}`, { id: personId, profile: who.profile, createdAt: before?.createdAt ?? clock() });
    await accounts.claimInvites(personId, who.verifiedEmails);
    return redirect(afterSignIn, [clearCookie(stateCookie, { path: basePath }), await startSession(personId, tokens)]);
  }

  async function handle({ method = 'GET', path = '', query = {}, headers = {} }) {
    if (path !== basePath && !path.startsWith(`${basePath}/`)) return null;
    const [name, step] = path.slice(basePath.length + 1).split('/');
    const provider = Object.hasOwn(providers, name) ? providers[name] : null;
    try {
      if (method === 'GET' && provider && !step) return await start(provider);
      if (method === 'GET' && provider && step === 'callback') return await callback(provider, query, headers);
      if (method === 'POST' && name === 'signout' && !step) {
        const me = await current(headers);
        if (me) await endSession(me.sessionKey);
        return { status: 204, headers: { 'cache-control': 'no-store' }, cookies: [clearCookie(cookieName)], body: '' };
      }
      if (method === 'GET' && name === 'me' && !step) {
        const me = await current(headers);
        if (!me) return json(401, { error: 'Not signed in', providers: Object.keys(providers) });
        return json(200, { person: me.person, accounts: await accounts.of(me.person.id) });
      }
      return json(404, { error: 'No such sign-in route' });
    } catch (e) {
      if (e instanceof AuthError) return json(e.status, { error: e.message });
      throw e;
    }
  }

  async function person(headers) { return (await current(headers))?.person ?? null; }

  return {
    handle,
    accounts,
    endSessionsOf,
    providers: Object.keys(providers),
    // The signed-in person for a request, or null (AUTH-01): the app answers 401 to anything else.
    person,
    async requirePerson(headers) { const p = await person(headers); if (!p) throw new AuthError(401, 'Sign in first'); return p; },
    // What to register with each provider.
    callbackUrls() { return Object.fromEntries(Object.keys(providers).map((n) => [n, redirectUri(n)])); },
  };
}
