import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { setup, DAY } from './helpers.mjs';

const ada = { id: 101, login: 'ada', name: 'Ada', emails: [{ email: 'Ada@Example.com', verified: true, primary: true }, { email: 'old@example.com', verified: false }] };
const bob = { id: 202, login: 'bob', name: 'Bob', emails: [{ email: 'bob@example.com', verified: true, primary: true }] };

test('AUTH-01 nothing is reachable until someone signs in with GitHub', async () => {
  const { auth, signIn } = setup({ people: { ada } });
  assert.equal(await auth.person({}), null);
  await assert.rejects(auth.requirePerson({ cookie: 'session=made-up' }), { status: 401 });
  const me = await auth.handle({ path: '/auth/me' });
  assert.equal(me.status, 401);
  assert.deepEqual(JSON.parse(me.body).providers, ['github']);
  // A callback with no matching state from this browser is refused.
  assert.equal((await auth.handle({ path: '/auth/github/callback', query: { code: 'ada', state: 'forged' } })).status, 400);
  const { done, cookie } = await signIn('ada');
  assert.equal(done.status, 302);
  assert.equal((await auth.person({ cookie })).profile.name, 'Ada');
});

test('AUTH-02 GitHub is asked only who someone is, and its token is never kept', async () => {
  const { auth, store, signIn } = setup({ people: { ada } });
  const start = await auth.handle({ path: '/auth/github' });
  const url = new URL(start.headers.location);
  assert.equal(url.origin + url.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(url.searchParams.get('scope'), 'user:email');
  await signIn('ada');
  const everything = JSON.stringify(await store.list(''));
  assert.ok(!everything.includes('gho_'), 'no GitHub token in the store');
});

test('AUTH-03 a session lasts 30 days in an HttpOnly cookie, and signing out ends it at once', async () => {
  const { auth, cognito, clock, signIn } = setup({ people: { ada, bob } });
  const { done, cookie } = await signIn('ada');
  const session = done.cookies.find((c) => c.startsWith('session='));
  for (const part of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=2592000']) assert.ok(session.includes(part), part);
  clock.now += 29 * DAY;
  assert.ok(await auth.person({ cookie }), 'still signed in on day 29');
  clock.now += 2 * DAY;
  assert.equal(await auth.person({ cookie }), null, 'gone after 30 days');

  const again = await signIn('ada');
  const out = await auth.handle({ method: 'POST', path: '/auth/signout', headers: { cookie: again.cookie } });
  assert.equal(out.status, 204);
  assert.ok(out.cookies[0].includes('Max-Age=0'));
  assert.equal(await auth.person({ cookie: again.cookie }), null);
  assert.ok(cognito.calls.includes('RevokeToken'));

  // Disabled in Cognito: the next refresh ends the session.
  const third = await signIn('bob');
  cognito.disable('github_202');
  clock.now += 2 * 3_600_000;
  assert.equal(await auth.person({ cookie: third.cookie }), null);
});

test('AUTH-05 a person sees only the accounts they belong to', async () => {
  const { auth, signIn } = setup({ people: { ada, bob } });
  const a = await auth.person({ cookie: (await signIn('ada')).cookie });
  const b = await auth.person({ cookie: (await signIn('bob')).cookie });
  const adas = await auth.accounts.create(a.id, 'Ada\'s');
  await auth.accounts.create(b.id, 'Bob\'s');
  assert.deepEqual((await auth.accounts.of(a.id)).map((x) => [x.name, x.role]), [['Ada\'s', 'owner']]);
  assert.equal(await auth.accounts.require(a.id, adas.id), 'owner');
  await assert.rejects(auth.accounts.require(b.id, adas.id), { status: 403 });
});

test('AUTH-06 an invite by email is taken up at first sign-in, and removing someone ends their sessions', async () => {
  const { auth, signIn } = setup({ people: { ada, bob } });
  const a = await auth.person({ cookie: (await signIn('ada')).cookie });
  const team = await auth.accounts.create(a.id, 'Team');
  await auth.accounts.invite(a.id, team.id, 'BOB@example.com');
  const bobIn = await signIn('bob');
  const b = await auth.person({ cookie: bobIn.cookie });
  assert.equal(await auth.accounts.require(b.id, team.id), 'member');
  assert.deepEqual(await auth.accounts.invites(team.id), []);
  await assert.rejects(auth.accounts.invite(b.id, team.id, 'eve@example.com'), { status: 403 }, 'only the owner invites');
  // An email GitHub hasn't verified doesn't take up an invite.
  await auth.accounts.invite(a.id, team.id, 'old@example.com');
  await signIn('ada');
  assert.deepEqual((await auth.accounts.invites(team.id)).map((i) => i.email), ['old@example.com']);
  await auth.accounts.remove(a.id, team.id, b.id);
  await assert.rejects(auth.accounts.require(b.id, team.id), { status: 403 });
  assert.equal(await auth.person({ cookie: bobIn.cookie }), null);
});

test('AUTH-09 GitHub users are direct users of the pool, signed in through the bridge, with no federated provider', async () => {
  const { cognito, signIn } = setup({ people: { ada } });
  await signIn('ada');
  assert.equal(cognito.users.get('github_101').status, 'CONFIRMED');
  assert.ok(cognito.calls.includes('AdminInitiateAuth:CUSTOM_AUTH') && cognito.calls.includes('AdminRespondToAuthChallenge'));
  // The bridge refuses an answer made without its secret.
  const start = await cognito.adminInitiateAuth({ AuthFlow: 'CUSTOM_AUTH', AuthParameters: { USERNAME: 'github_101' } });
  await assert.rejects(cognito.adminRespondToAuthChallenge({ Session: start.Session, ChallengeResponses: { USERNAME: 'github_101', ANSWER: 'guess' } }), { name: 'NotAuthorizedException' });
  const template = await readFile(new URL('../template.yaml', import.meta.url), 'utf8');
  assert.match(template, /UserPoolTier: LITE/);
  assert.doesNotMatch(template, /UserPoolIdentityProvider|ProviderType: (OIDC|SAML)/);
});

test('AUTH-10 the package stands alone, configured only by the project that uses it', async () => {
  const dir = new URL('../src/', import.meta.url);
  for (const f of await readdir(dir)) {
    const src = await readFile(new URL(f, dir), 'utf8');
    for (const [, spec] of src.matchAll(/(?:from|import\()\s*'([^']+)'/g)) assert.ok(spec.startsWith('./') || spec.startsWith('node:') || spec.startsWith('@aws-sdk/'), `${f} imports ${spec}`);
    assert.doesNotMatch(src, /overworld|projectmap/i, f);
  }
});
