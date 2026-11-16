# free-tier-auth

Sign-in on Amazon Cognito's free tier, with the parts Cognito leaves out: GitHub sign-in, sessions in a cookie, and accounts with members and invites. Use it until there is money for a paid sign-in service.

## Why a bridge for GitHub

GitHub doesn't speak OpenID Connect, so Cognito can't use it as a provider directly. The usual fix, an OIDC go-between, makes every GitHub user a *federated* user. Cognito's free tier covers only 50 federated users a month, against 10,000 direct ones ([pricing](https://aws.amazon.com/cognito/pricing/)).

This package runs GitHub's OAuth flow itself and keeps a native pool user for each GitHub user (`github_<id>`). It then signs them in through Cognito's custom-auth challenge, so they count as direct users:

1. The server checks the person with GitHub.
2. It calls `AdminInitiateAuth` with `CUSTOM_AUTH`, and the `CreateAuthChallenge` trigger hands back a nonce.
3. The server answers with an HMAC of the username and the nonce. Only the server and the triggers hold the bridge secret.
4. `VerifyAuthChallengeResponse` checks the answer, and Cognito issues the tokens.

GitHub's token is used to read who the person is and their verified emails (scope `user:email`), and then it is dropped.

## What it does

- **Routes**, framework-neutral. `auth.handle({ method, path, query, headers })` returns `{ status, headers, cookies, body }`, or `null` for routes that aren't its own.
  - `GET /auth/github` and `GET /auth/github/callback`: sign-in.
  - `POST /auth/signout`.
  - `GET /auth/me`: the person and their accounts, or a 401 that lists the providers.
- **Sessions.** An opaque id travels in an `HttpOnly; Secure; SameSite=Lax` cookie, for 30 days.
  - The store keeps only a hash of the id.
  - Every hour the session is refreshed with Cognito, so a user disabled in the pool is signed out.
  - Signing out revokes the refresh token.
- **The signed-in person.** `auth.person(headers)` returns them or `null`; `auth.requirePerson(headers)` throws a 401 instead.
- **Accounts** (owner and member), through `auth.accounts`:
  - `create`, `of`, `require`, `members`, `invite`, `invites`, `cancelInvite` and `remove`.
  - An invite is taken up when someone first signs in with an email the provider has verified.
  - Removing someone ends their sessions.
- **Store adapter.** `get`, `put(key, value, { expiresAt })`, `delete` and `list(prefix)`. `memoryStore()` is included; a DynamoDB adapter comes next.
- **Providers** share one shape, `{ name, authorizeUrl, identify }`, so others (Google, GitLab) can be added beside GitHub.

## Setting it up

```js
import { createAuth } from 'free-tier-auth';
import { cognitoClient } from 'free-tier-auth/aws';

const auth = createAuth({
  baseUrl: 'https://example.com',
  store,                                   // your adapter
  cognito: { client: await cognitoClient(), userPoolId, clientId, clientSecret: () => fromSsm('...') },
  github: { clientId, clientSecret: () => fromSsm('...') },
  bridgeSecret: () => fromSsm('...'),      // the same secret the triggers read
});
auth.callbackUrls();                       // { github: 'https://example.com/auth/github/callback' }: register it with the GitHub OAuth App
```

`template.yaml` holds the pool (Lite tier, no self sign-up), the app client (with a secret, custom auth and refresh only) and the triggers' function. It deliberately has no federated provider. Pass it `BridgeSecretParameter`, the SSM SecureString holding the bridge secret.

The server's role needs `cognito-idp:AdminCreateUser`, `AdminSetUserPassword`, `AdminInitiateAuth`, `AdminRespondToAuthChallenge` and `RevokeToken` on the pool.

## Licence

MIT.
