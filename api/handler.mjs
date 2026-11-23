// AWS Lambda entry point. One function serves three kinds of event:
//   a Function URL request   /api/* goes to the JSON API; everything else is the built web app
//   the table's stream       a newly saved item (the outbox) wakes the worker for its project
//   a schedule               { overworld: 'drain', projectId } for a retry, { overworld: 'reconcile' } nightly

import { createApi } from './app.mjs';
import { createModel } from './model/index.mjs';
import { serveStatic, SECURITY_HEADERS } from './static.mjs';
import { awsSignIn, awsSync } from './aws.mjs';
import { createAuth } from 'free-tier-auth';
import { cognitoClient } from 'free-tier-auth/aws';
import { githubApp } from './stores/github/app.mjs';
import { createStores } from './stores/index.mjs';
import { createSync } from './sync.mjs';

let ready;

let domain = null; // the function URL a request came to (AWS sets it, not the caller): where sign-in redirects back to, unless one is set

// Sign-in is made on the first request that needs it, since a stream or a schedule may wake the function before any request does.
function lazyAuth(model) {
  const people = awsSignIn();
  if (!people.enabled) return { auth: null, mayEnter: people.allowed };
  let made = null;
  const get = () =>
    (made ??= (async () => {
      const baseUrl = people.baseUrl ?? (domain ? `https://${domain}` : null);
      if (!baseUrl) throw new Error('Sign-in needs SIGN_IN_BASE_URL or a function URL request');
      return createAuth({ baseUrl, basePath: '/api/auth', cookieName: 'projectmap_session', store: model.signIn, cognito: { client: await cognitoClient(), ...people.pool }, github: people.github, bridgeSecret: people.bridgeSecret });
    })().catch((err) => ((made = null), Promise.reject(err))));
  const auth = { providers: ['github'], handle: async (req) => (await get()).handle(req), person: async (headers) => (await get()).person(headers) };
  return { auth, mayEnter: people.allowed };
}

async function getApp() {
  ready ??= (async () => {
    const model = await createModel();
    const aws = awsSync();
    const stores = createStores({ githubApp: aws.enabled ? githubApp(aws.app) : null });
    const sync = aws.enabled ? createSync({ model, stores, schedule: aws.schedule }) : null;
    const api = createApi({ model, accessKey: process.env.ACCESS_KEY ?? '', sync, stores, webhookSecret: sync && aws.webhookSecret, ...lazyAuth(model) });
    return { api, sync, aws };
  })();
  return ready;
}

export async function handler(event, context) {
  domain ??= event.requestContext?.domainName ?? null;
  const { api, sync, aws } = await getApp();
  aws.seenFunction(context?.invokedFunctionArn);

  if (Array.isArray(event.Records)) {
    // Stream records arrive in order per project. Drain each project once; a failure here is retried by the stream, then dead-lettered.
    const projects = new Set(event.Records.map((r) => r.dynamodb?.NewImage?.projectId?.S).filter(Boolean));
    for (const projectId of projects) await sync?.drain(projectId);
    return { drained: projects.size };
  }
  if (event.overworld === 'drain') return sync?.drain(event.projectId);
  if (event.overworld === 'reconcile') return sync?.reconcile();

  const method = event.requestContext?.http?.method ?? 'GET';
  const path = event.rawPath ?? '/';
  const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));

  if (!path.startsWith('/api/')) return serveStatic({ method, path, headers });

  // A screenshot sent to a one-time upload link (#16 SHOT-04) is its own bytes, not JSON.
  if (/^\/api\/uploads\//.test(path)) {
    const rawBytes = event.body ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8') : null;
    const res = await api({ method, path, headers, rawBytes });
    return json(res.status, res.body);
  }

  let body = null;
  let rawBody = null;
  if (event.body) {
    rawBody = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return json(400, { error: 'Body must be JSON' });
    }
  }
  const query = Object.fromEntries(new URLSearchParams(event.rawQueryString ?? ''));
  const res = await api({ method, path, headers, query, body, rawBody });
  // Sign-in's routes answer with their own headers and cookies (a function URL sets each of `cookies` as its own Set-Cookie).
  if (res.raw !== undefined) return { statusCode: res.status, headers: { ...SECURITY_HEADERS, ...res.headers }, cookies: res.cookies ?? [], body: res.raw };
  return json(res.status, res.body);
}

function json(statusCode, data) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS },
    body: data == null ? '' : JSON.stringify(data),
  };
}
