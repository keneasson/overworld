// The spec's check with a model (#36 COHERE-04, COHERE-07, COHERE-08): embed each behaviour whose words changed, compare
// it with every other behaviour in the project, and send the close pairs to the API, where agents judge them (coherence()).
//
//   node scripts/coherence.mjs [--project <id>] [--all] [--plan] [--threshold 0.85] [--url <api>]
//
// --plan says how many behaviours need embedding, loading no model (and writes changed=true|false to $GITHUB_OUTPUT), so CI
// installs the runtime only when there is something to embed.
//
// It runs here or in CI, not in the Lambda: the model's runtime (onnxruntime-node) is about 290 MB, over Lambda's 250 MB
// unzipped limit. The runtime isn't a dependency either, so `npm ci` stays small: install it once with
// `npm install --no-save @huggingface/transformers@4`, or point TRANSFORMERS at a copy.
// The project keeps each behaviour's vector with its text hash and model, so a run embeds only behaviours whose words (or
// the model) changed, and only those are compared (pass --all to compare everything). When nothing changed it stops before
// loading the model. .cache/coherence/ holds only the model's weights.
//
// It signs in with OVERWORLD_AGENT_TOKEN when that is set (as in CI, with OVERWORLD_URL), which also names the project;
// otherwise with the access key, and the URL, from .conf/deploy.json.

import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { NEAR } from '../shared/coherence.js';
import { readDeployConfig } from './local-config.mjs';
import { runCheck } from './coherence-check.mjs';

const MODEL = 'Xenova/bge-small-en-v1.5';
const { values: opt } = parseArgs({ options: { project: { type: 'string' }, all: { type: 'boolean' }, plan: { type: 'boolean' }, threshold: { type: 'string' }, url: { type: 'string' } } });
const token = process.env.OVERWORLD_AGENT_TOKEN ?? '';
const conf = token ? {} : readDeployConfig();
const base = (opt.url ?? process.env.OVERWORLD_URL ?? process.env.PROJECTMAP_URL ?? conf.url ?? '').replace(/\/$/, '');
const key = process.env.PROJECTMAP_ACCESS_KEY ?? conf.accessKey ?? '';
if (!base) throw new Error('No API: pass --url, set OVERWORLD_URL, or deploy once so .conf/deploy.json has one');

async function call(method, path, body) {
  const auth = token ? { authorization: `Bearer ${token}` } : { 'x-projectmap-key': key };
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...auth }, body: body && JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data.error ?? ''}`);
  return data;
}

const t0 = performance.now();
let pid = opt.project;
if (!pid && token) pid = (await call('GET', '/api/agent')).projectId;
if (!pid) {
  const { projects } = await call('GET', '/api/projects');
  const fromStores = projects.filter((p) => p.githubRepo);
  if (fromStores.length !== 1) throw new Error(`Pass --project: ${projects.map((p) => `${p.id} (${p.title})`).join(', ')}`);
  pid = fromStores[0].id;
}

async function loadEmbedder() {
  const { pipeline, env } = await import(process.env.TRANSFORMERS ?? '@huggingface/transformers').catch(() => {
    throw new Error('The embedding runtime is missing: npm install --no-save @huggingface/transformers@4');
  });
  env.cacheDir = process.env.TRANSFORMERS_CACHE ?? new URL('../.cache/coherence/models/', import.meta.url).pathname;
  const extract = await pipeline('feature-extraction', MODEL, { dtype: 'fp32' });
  return {
    model: MODEL,
    version: `transformers.js ${env.version ?? '?'}, fp32, mean pooling`,
    embed: async (texts) => (await extract(texts, { pooling: 'mean', normalize: true })).tolist(),
  };
}

const run = await runCheck({ call, pid, model: MODEL, loadEmbedder, all: opt.all, plan: opt.plan, threshold: opt.threshold ? Number(opt.threshold) : NEAR });
const ms = Math.round(performance.now() - t0);
if (opt.plan) {
  console.log(`${run.behaviours} behaviours, ${run.toEmbed} to embed${run.removed ? `, ${run.removed} vectors of removed behaviours dropped` : ''} (${ms} ms)`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${run.toEmbed > 0}\n`);
  process.exit(0);
}
if (!run.kept && !opt.all) console.log(`${run.behaviours} behaviours, none changed${run.removed ? `, ${run.removed} vectors of removed behaviours dropped` : ''}: nothing embedded (${ms} ms)`);
else console.log(`${run.behaviours} behaviours, ${run.kept} embedded and kept, ${run.removed} removed, ${run.pairs.length} close pairs sent (${ms} ms, ${MODEL})`);
for (const p of run.pairs.slice(0, 15)) console.log(`  ${p.cosine}  ${p.a.id} (${p.a.item}) ~ ${p.b.id} (${p.b.item})`);
