import { AuthError, hmac, random, secretHash } from './util.mjs';

// The GitHub bridge (AUTH-09). GitHub doesn't speak OpenID Connect, and an OIDC go-between would make every GitHub user a federated
// user, of whom Cognito's free tier covers only 50 a month. Instead the server, having checked the person with GitHub itself, keeps a
// native pool user for them and signs them in through Cognito's custom-auth challenge, so they count as direct users.
//
// The challenge: Cognito's CreateAuthChallenge trigger hands out a nonce; the server answers with an HMAC of the username and nonce
// under the bridge secret, which only the server and the triggers hold; VerifyAuthChallengeResponse checks it (src/triggers.mjs).
export const bridgeAnswer = (bridgeSecret, username, nonce) => hmac(bridgeSecret, `${username}.${nonce}`);

const exists = (e) => e?.name === 'UsernameExistsException' || e?.__type === 'UsernameExistsException';

export async function signInNative({ cognito, userPoolId, clientId, clientSecret, bridgeSecret, username, profile }) {
  const hash = secretHash(clientSecret, username, clientId);
  try {
    const attributes = [['name', profile.name], ['picture', profile.picture]].filter(([, v]) => v).map(([Name, Value]) => ({ Name, Value: String(Value) }));
    await cognito.adminCreateUser({ UserPoolId: userPoolId, Username: username, MessageAction: 'SUPPRESS', UserAttributes: attributes });
    // A random password nobody keeps moves the user out of FORCE_CHANGE_PASSWORD; they only ever sign in through the bridge.
    await cognito.adminSetUserPassword({ UserPoolId: userPoolId, Username: username, Password: `${random(24)}aA1!`, Permanent: true });
  } catch (e) { if (!exists(e)) throw e; }
  const start = await cognito.adminInitiateAuth({ UserPoolId: userPoolId, ClientId: clientId, AuthFlow: 'CUSTOM_AUTH', AuthParameters: { USERNAME: username, SECRET_HASH: hash } });
  const nonce = start.ChallengeParameters?.nonce;
  if (start.ChallengeName !== 'CUSTOM_CHALLENGE' || !nonce) throw new AuthError(502, 'Cognito did not offer the sign-in challenge');
  const done = await cognito.adminRespondToAuthChallenge({
    UserPoolId: userPoolId, ClientId: clientId, ChallengeName: 'CUSTOM_CHALLENGE', Session: start.Session,
    ChallengeResponses: { USERNAME: username, ANSWER: bridgeAnswer(bridgeSecret, username, nonce), SECRET_HASH: hash },
  });
  const tokens = done.AuthenticationResult;
  if (!tokens?.RefreshToken) throw new AuthError(401, 'Cognito refused the sign-in');
  return { refreshToken: tokens.RefreshToken, cognitoUsername: username };
}

// Refreshing proves the person is still allowed in (not disabled or removed in the pool) and keeps Cognito's view of them current.
export async function refresh({ cognito, userPoolId, clientId, clientSecret, cognitoUsername, refreshToken }) {
  try {
    const r = await cognito.adminInitiateAuth({ UserPoolId: userPoolId, ClientId: clientId, AuthFlow: 'REFRESH_TOKEN_AUTH', AuthParameters: { REFRESH_TOKEN: refreshToken, SECRET_HASH: secretHash(clientSecret, cognitoUsername, clientId) } });
    return Boolean(r.AuthenticationResult?.AccessToken);
  } catch { return false; }
}

export async function revoke({ cognito, clientId, clientSecret, refreshToken }) {
  try { await cognito.revokeToken({ ClientId: clientId, ClientSecret: clientSecret, Token: refreshToken }); } catch { /* already gone */ }
}
