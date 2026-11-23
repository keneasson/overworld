// The spec's check with a model (#36 COHERE-04, COHERE-07): embed each behaviour, compare what changed since the last run
// with every other behaviour in the project, and send the close pairs to the API, where agents judge them (coherence()).
//
//   node scripts/coherence.mjs [--project <id>] [--all] [--threshold 0.85] [--url <api>]
//
// It runs here, not in the Lambda: the model's runtime (onnxruntime-node) is about 290 MB, over Lambda's 250 MB unzipped
// limit, and the check is only worth running when the spec changes. The runtime isn't a dependency either, so `npm ci`
// stays small: install it once with `npm install --no-save @huggingface/transformers@4`, or point TRANSFORMERS at a copy.
// Vectors are cached by text hash in .cache/coherence/, so a run embeds only behaviours whose words changed, and only
// those are compared (pass --all to compare everything). The URL and access key come from .conf/deploy.json.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { NEAR, embedBehaviours, nearPairs, textHash } from '../shared/coherence.js';
import { readDeployConfig } from './local-config.mjs';

const MODEL = 'Xenova/bge-small-en-v1.5';
const { values: opt } = parseArgs({ options: { project: { type: 'string' }, all: { type: 'boolean' }, threshold: { type: 'string' }, url: { type: 'string' } } });
const conf = readDeployConfig();
const base = (opt.url ?? process.env.PROJECTMAP_URL ?? conf.url ?? '').replace(/\/$/, '');
const key = process.env.PROJECTMAP_ACCESS_KEY ?? conf.accessKey ?? '';
if (!base) throw new Error('No API: pass --url, or deploy once so .conf/deploy.json has one');

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', 'x-projectmap-key': key }, body: body && JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data.error ?? ''}`);
  return data;
}

let pid = opt.project;
if (!pid) {
  const { projects } = await call('GET', '/api/projects');
  const fromStores = projects.filter((p) => p.githubRepo);
  if (fromStores.length !== 1) throw new Error(`Pass --project: ${projects.map((p) => `${p.id} (${p.title})`).join(', ')}`);
  pid = fromStores[0].id;
}

const { pipeline, env } = await import(process.env.TRANSFORMERS ?? '@huggingface/transformers').catch(() => {
  throw new Error('The embedding runtime is missing: npm install --no-save @huggingface/transformers@4');
});
const dir = new URL('../.cache/coherence/', import.meta.url).pathname;
env.cacheDir = process.env.TRANSFORMERS_CACHE ?? `${dir}models/`;
const extract = await pipeline('feature-extraction', MODEL, { dtype: 'fp32' });
const embedder = {
  model: MODEL,
  version: `transformers.js ${env.version ?? '?'}, fp32, mean pooling`,
  embed: async (texts) => (await extract(texts, { pooling: 'mean', normalize: true })).tolist(),
};

const file = `${dir}${MODEL.replace(/\W+/g, '-')}.json`;
const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
const cache = new Map(Object.entries(saved.vectors ?? {}));
const checked = saved.checked ?? {}; // the hashes each project's last run compared, so the next compares only what changed
const { behaviours } = await call('GET', `/api/projects/${pid}/coherence/behaviours`);
const before = new Set(checked[pid] ?? []);
const changed = opt.all ? null : new Set(behaviours.map((b) => textHash(b.text)).filter((h) => !before.has(h)));
const t0 = performance.now();
await embedBehaviours(behaviours, embedder, cache);
const pairs = nearPairs({ behaviours, vectors: cache, changed, threshold: opt.threshold ? Number(opt.threshold) : NEAR, embedder });
for (let i = 0; i < pairs.length; i += 500) await call('PUT', `/api/projects/${pid}/coherence/pairs`, { pairs: pairs.slice(i, i + 500) });
mkdirSync(dir, { recursive: true });
writeFileSync(file, JSON.stringify({ vectors: Object.fromEntries(cache), checked: { ...checked, [pid]: behaviours.map((b) => textHash(b.text)) } }));
console.log(`${behaviours.length} behaviours, ${changed ? changed.size : 'all'} compared, ${pairs.length} close pairs sent (${Math.round(performance.now() - t0)} ms, ${MODEL})`);
for (const p of pairs.slice(0, 15)) console.log(`  ${p.cosine}  ${p.a.id} (${p.a.item}) ~ ${p.b.id} (${p.b.item})`);
