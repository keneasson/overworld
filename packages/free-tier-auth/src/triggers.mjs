import { random, sameText } from './util.mjs';
import { bridgeAnswer } from './bridge.mjs';

// Cognito's Lambda triggers, in one function: the GitHub bridge's custom-auth challenge (AUTH-09) and the pre-sign-up rule.
export function createTriggers({ bridgeSecret }) {
  const triggers = {
    // Only one challenge, answered once. Anything else (a password, a second try) fails.
    DefineAuthChallenge_Authentication(event) {
      const s = event.request.session ?? [];
      const r = event.response;
      if (s.length === 0) Object.assign(r, { challengeName: 'CUSTOM_CHALLENGE', issueTokens: false, failAuthentication: false });
      else if (s.length === 1 && s[0].challengeName === 'CUSTOM_CHALLENGE' && s[0].challengeResult === true) Object.assign(r, { issueTokens: true, failAuthentication: false });
      else Object.assign(r, { issueTokens: false, failAuthentication: true });
      return event;
    },
    CreateAuthChallenge_Authentication(event) {
      const nonce = random(24);
      event.response.publicChallengeParameters = { nonce };
      event.response.privateChallengeParameters = { nonce };
      return event;
    },
    async VerifyAuthChallengeResponse_Authentication(event) {
      const expected = bridgeAnswer(await bridgeSecret(), event.userName, event.request.privateChallengeParameters?.nonce ?? '');
      event.response.answerCorrect = sameText(event.request.challengeAnswer, expected);
      return event;
    },
    // Nobody signs up by themselves: users are created by the server, after their provider has said who they are.
    PreSignUp_SignUp() { throw new Error('Sign in with GitHub'); },
    PreSignUp_AdminCreateUser(event) { return event; },
  };
  return async function handler(event) {
    const fn = triggers[event.triggerSource];
    if (!fn) throw new Error(`Unhandled trigger ${event.triggerSource}`);
    return fn(event);
  };
}

// The deployed function: the bridge secret comes from SSM, named by BRIDGE_SECRET_PARAMETER, and is cached for the container's life.
let cached;
export const handler = createTriggers({
  bridgeSecret: async () => (cached ??= (async () => (await import('./aws.mjs')).ssmSecret(process.env.BRIDGE_SECRET_PARAMETER))()),
});
