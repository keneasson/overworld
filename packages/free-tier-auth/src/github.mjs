import { AuthError } from './util.mjs';

// GitHub's OAuth code flow, for identity only (AUTH-02): 'user:email' reads who they are and their verified emails, never repositories.
// The GitHub token is used for these two calls and then dropped; nothing keeps it.
export const GITHUB_SCOPE = 'user:email';

export function githubAuthorizeUrl({ clientId, redirectUri, state }) {
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, scope: GITHUB_SCOPE, state, allow_signup: 'true' });
  return `https://github.com/login/oauth/authorize?${q}`;
}

export async function githubIdentity({ clientId, clientSecret, redirectUri, code, fetchImpl = fetch }) {
  const res = await fetchImpl('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
  });
  const grant = await res.json().catch(() => ({}));
  if (!res.ok || !grant.access_token) throw new AuthError(401, 'GitHub refused the sign-in');
  const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${grant.access_token}`, 'user-agent': 'free-tier-auth' };
  const [userRes, emailsRes] = await Promise.all([fetchImpl('https://api.github.com/user', { headers }), fetchImpl('https://api.github.com/user/emails', { headers })]);
  if (!userRes.ok) throw new AuthError(401, 'GitHub did not say who this is');
  const user = await userRes.json();
  const emails = emailsRes.ok ? await emailsRes.json() : [];
  const verified = emails.filter((e) => e.verified).map((e) => e.email);
  const primary = emails.find((e) => e.primary && e.verified)?.email ?? verified[0] ?? null;
  return {
    provider: 'github',
    subject: String(user.id),
    profile: { name: user.name || user.login, email: primary, picture: user.avatar_url ?? null, login: user.login },
    verifiedEmails: verified,
  };
}

// The GitHub provider, in the shape every provider takes: authorizeUrl and identify. identify's signIn() gets the Cognito session.
export function githubProvider({ clientId, clientSecret, bridge, fetchImpl = fetch }) {
  return {
    name: 'github',
    authorizeUrl: ({ redirectUri, state }) => githubAuthorizeUrl({ clientId, redirectUri, state }),
    async identify({ redirectUri, code }) {
      const who = await githubIdentity({ clientId, clientSecret: typeof clientSecret === 'function' ? await clientSecret() : clientSecret, redirectUri, code, fetchImpl });
      return { ...who, signIn: () => bridge(`github_${who.subject}`, who.profile) };
    },
  };
}
