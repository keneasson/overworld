import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuth } from 'free-tier-auth';
import { createApi } from '../app.mjs';
import { createModel } from '../model/index.mjs';
import { allowedLogins } from '../aws.mjs';
import { fakeCognito, fakeGitHub } from '../../packages/free-tier-auth/test/helpers.mjs';

const ada = { id: 101, login: 'ada', name: 'Ada Lovelace', emails: [{ email: 'ada@example.com', verified: true, primary: true }] };
const eve = { id: 666, login: 'eve', name: 'Eve', emails: [] };

// The API as deployed with sign-in (#52): the package on the app's own table, Cognito and GitHub stubbed.
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'projectmap-'));
  const model = await createModel({ DATA_FILE: join(dir, 'db.json') });
  const auth = createAuth({
    baseUrl: 'https://overworld.example', basePath: '/api/auth', cookieName: 'projectmap_session', store: model.signIn, fetchImpl: fakeGitHub({ ada, eve }),
    cognito: { client: fakeCognito({ bridgeSecret: 'bridge' }), userPoolId: 'pool', clientId: 'client', clientSecret: 'pool-secret' },
    github: { clientId: 'gh', clientSecret: 'gh-secret' }, bridgeSecret: 'bridge',
  });
  const api = createApi({ model, accessKey: 'script-key', log: { error() {} }, auth, mayEnter: allowedLogins('ada') });
  const jar = (cookies = []) => cookies.map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');
  async function signIn(code) {
    const start = await api({ method: 'GET', path: '/api/auth/github' });
    assert.equal(start.status, 302);
    const state = new URL(start.headers.location).searchParams.get('state');
    const done = await api({ method: 'GET', path: '/api/auth/github/callback', query: { code, state }, headers: { cookie: jar(start.cookies) } });
    assert.equal(done.status, 302);
    return jar(done.cookies);
  }
  const as = (cookie, csrf = true) => (method, path, body) => api({ method, path, body, headers: { cookie, ...(csrf ? { 'x-projectmap-csrf': '1' } : {}) } });
  const script = (method, path, body) => api({ method, path, body, headers: { 'x-projectmap-key': 'script-key' } });
  return { api, signIn, as, script };
}

test('AUTH-08 people come in by signing in with GitHub, and the access key is left for scripts', async () => {
  const { api, signIn, as, script } = await setup();
  const nobody = await api({ method: 'GET', path: '/api/projects', headers: {} });
  assert.equal(nobody.status, 401);
  assert.deepEqual(nobody.body.signIn, ['github'], 'the start screen offers GitHub, not the key');
  assert.deepEqual((await api({ method: 'GET', path: '/api/health' })).body.signIn, ['github']);
  assert.equal((await script('GET', '/api/projects')).status, 200, 'a script still gets in with the key');

  const cookie = await signIn('ada');
  const people = as(cookie);
  assert.equal((await people('GET', '/api/projects')).status, 200);
  assert.equal((await people('GET', '/api/session')).body.person.login, 'ada');
  // The session is a cookie, so a change must carry the header no other site can send.
  const forged = await as(await signIn('ada'), false)('POST', '/api/projects', { title: 'Forged' });
  assert.equal(forged.status, 403);
  assert.equal((await people('POST', '/api/projects', { title: 'Mine' })).status, 201);

  // Signed in with GitHub, but not let in.
  const outsider = await as(await signIn('eve'))('GET', '/api/projects');
  assert.equal(outsider.status, 403);
  assert.equal(outsider.body.notLetIn, true);

  assert.equal((await api({ method: 'POST', path: '/api/auth/signout', headers: { cookie } })).status, 204);
  assert.equal((await people('GET', '/api/projects')).status, 401, 'signed out, the cookie opens nothing');
});

test('AUTH-07 what a signed-in person saves or comments carries them as its author', async () => {
  const { signIn, as, script } = await setup();
  const ada = as(await signIn('ada'));
  const { project } = (await ada('POST', '/api/projects', { title: 'Shop' })).body;
  const pid = project.id;
  const said = await ada('POST', `/api/projects/${pid}/comments`, { itemKey: 'node-root', anchor: { section: 'Why' }, text: 'Agreed.', author: 'Someone else' });
  assert.equal(said.status, 201);
  assert.equal(said.body.comment.author, 'Ada Lovelace');
  const cs = (await ada('POST', `/api/projects/${pid}/changesets`, { scopeId: 'root', author: 'you' })).body.changeset;
  assert.equal(cs.author, 'Ada Lovelace');
  // A script with the key says who it writes for, as before.
  assert.equal((await script('POST', `/api/projects/${pid}/comments`, { itemKey: 'node-root', anchor: { section: 'Why' }, text: 'Ran.', author: 'deploy' })).body.comment.author, 'deploy');
});
