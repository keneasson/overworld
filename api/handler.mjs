// AWS Lambda entry point. One function serves three kinds of event:
//   a Function URL request   /api/* goes to the JSON API; everything else is the built web app
//   the table's stream       a newly saved item (the outbox) wakes the worker for its project
//   a schedule               { overworld: 'drain', projectId } for a retry, { overworld: 'reconcile' } nightly

import { createApi } from './app.mjs';
import { createModel } from './model/index.mjs';
import { serveStatic, SECURITY_HEADERS } from './static.mjs';
import { awsSync } from './aws.mjs';
import { githubApp } from './stores/github/app.mjs';
import { createStores } from './stores/index.mjs';
import { createSync } from './sync.mjs';

let ready;

async function getApp() {
  ready ??= (async () => {
    const model = await createModel();
    const aws = awsSync();
    const stores = createStores({ githubApp: aws.enabled ? githubApp(aws.app) : null });
    const sync = aws.enabled ? createSync({ model, stores, schedule: aws.schedule }) : null;
    const api = createApi({ model, accessKey: process.env.ACCESS_KEY ?? '', sync, stores, webhookSecret: sync && aws.webhookSecret });
    return { api, sync, aws };
  })();
  return ready;
}

export async function handler(event, context) {
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
  const res = await api({ method, path, headers, body, rawBody });
  return json(res.status, res.body);
}

function json(statusCode, data) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS },
    body: data == null ? '' : JSON.stringify(data),
  };
}
