import { createAuth, memoryStore } from '../src/index.mjs';
import { createTriggers } from '../src/triggers.mjs';

// A stand-in for Cognito that runs the package's own triggers, so the GitHub bridge is tested end to end.
export function fakeCognito({ bridgeSecret }) {
  const triggers = createTriggers({ bridgeSecret: async () => bridgeSecret });
  const users = new Map();
  const sessions = new Map();
  const refreshTokens = new Map();
  const calls = [];
  const fail = (name) => Object.assign(new Error(name), { name });
  const fire = (triggerSource, userName, request) => triggers({ triggerSource, userName, request, response: {} });
  return {
    users, calls, refreshTokens,
    disable(username) { users.get(username).enabled = false; },
    async adminCreateUser(i) {
      calls.push('AdminCreateUser');
      if (users.has(i.Username)) throw fail('UsernameExistsException');
      await fire('PreSignUp_AdminCreateUser', i.Username, {});
      users.set(i.Username, { status: 'FORCE_CHANGE_PASSWORD', enabled: true, attributes: i.UserAttributes });
    },
    async adminSetUserPassword(i) { calls.push('AdminSetUserPassword'); users.get(i.Username).status = 'CONFIRMED'; },
    async adminInitiateAuth(i) {
      calls.push(`AdminInitiateAuth:${i.AuthFlow}`);
      if (i.AuthFlow === 'REFRESH_TOKEN_AUTH') {
        const u = refreshTokens.get(i.AuthParameters.REFRESH_TOKEN);
        if (!u || !users.get(u)?.enabled) throw fail('NotAuthorizedException');
        return { AuthenticationResult: { AccessToken: 'access' } };
      }
      const user = users.get(i.AuthParameters.USERNAME);
      if (!user?.enabled || user.status !== 'CONFIRMED') throw fail('NotAuthorizedException');
      const defined = await fire('DefineAuthChallenge_Authentication', i.AuthParameters.USERNAME, { session: [] });
      const created = await fire('CreateAuthChallenge_Authentication', i.AuthParameters.USERNAME, {});
      const session = `s${sessions.size}`;
      sessions.set(session, { username: i.AuthParameters.USERNAME, private: created.response.privateChallengeParameters });
      return { ChallengeName: defined.response.challengeName, Session: session, ChallengeParameters: created.response.publicChallengeParameters };
    },
    async adminRespondToAuthChallenge(i) {
      calls.push('AdminRespondToAuthChallenge');
      const s = sessions.get(i.Session);
      const verified = await fire('VerifyAuthChallengeResponse_Authentication', s.username, { privateChallengeParameters: s.private, challengeAnswer: i.ChallengeResponses.ANSWER });
      const defined = await fire('DefineAuthChallenge_Authentication', s.username, { session: [{ challengeName: 'CUSTOM_CHALLENGE', challengeResult: verified.response.answerCorrect }] });
      if (!defined.response.issueTokens) throw fail('NotAuthorizedException');
      const token = `refresh-${refreshTokens.size}`;
      refreshTokens.set(token, s.username);
      return { AuthenticationResult: { AccessToken: 'access', RefreshToken: token } };
    },
    async revokeToken(i) { calls.push('RevokeToken'); refreshTokens.delete(i.Token); },
  };
}

// GitHub, stubbed: each code stands for one GitHub user.
export function fakeGitHub(people) {
  return async (url, init = {}) => {
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url === 'https://github.com/login/oauth/access_token') {
      const { code } = JSON.parse(init.body);
      return people[code] ? reply(200, { access_token: `gho_${code}` }) : reply(200, { error: 'bad_verification_code' });
    }
    const code = String(init.headers?.authorization ?? '').replace('Bearer gho_', '');
    const p = people[code];
    if (!p) return reply(401, {});
    if (url === 'https://api.github.com/user') return reply(200, { id: p.id, login: p.login, name: p.name, avatar_url: `https://avatars.example/${p.id}` });
    if (url === 'https://api.github.com/user/emails') return reply(200, p.emails ?? []);
    return reply(404, {});
  };
}

export function setup({ people = {}, now = 1_800_000_000_000 } = {}) {
  const clock = { now };
  const store = memoryStore({ clock: () => clock.now });
  const cognito = fakeCognito({ bridgeSecret: 'bridge-secret' });
  const auth = createAuth({
    baseUrl: 'https://app.example', store, clock: () => clock.now, fetchImpl: fakeGitHub(people),
    cognito: { client: cognito, userPoolId: 'pool', clientId: 'client', clientSecret: async () => 'client-secret' },
    github: { clientId: 'gh-client', clientSecret: 'gh-secret' }, bridgeSecret: 'bridge-secret',
  });
  const cookieJar = (setCookies) => setCookies.map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');
  // Runs a whole GitHub sign-in in one browser and returns the session cookie it ends with.
  async function signIn(code) {
    const start = await auth.handle({ path: '/auth/github' });
    const state = new URL(start.headers.location).searchParams.get('state');
    const done = await auth.handle({ path: '/auth/github/callback', query: { code, state }, headers: { cookie: cookieJar(start.cookies) } });
    return { done, cookie: cookieJar(done.cookies) };
  }
  return { auth, store, cognito, clock, signIn };
}

export const DAY = 86_400_000;
