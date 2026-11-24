// One run of the spec's check (#36 COHERE-04, COHERE-07, COHERE-08), apart from where it runs: scripts/coherence.mjs gives
// it the API and a way to load the model, and tests give it the API in-process and a fake embedder.
//
// The project keeps each behaviour's vector with the text hash and model it came from, so everything is worked out before
// a model loads: when no behaviour's words or model changed, the run ends there, without loading one.

import { NEAR, embedBehaviours, nearPairs, packVector, planVectors } from '../shared/coherence.js';

/**
 * @param {object} o
 * @param {(method: string, path: string, body?: object) => Promise<object>} o.call the API, throwing on an error
 * @param {string} o.pid the project
 * @param {string} o.model the embedding model's name, kept with each vector
 * @param {() => Promise<{ model: string, version?: string, embed: (texts: string[]) => Promise<number[][]> }>} o.loadEmbedder only called when something needs embedding
 * @param {boolean} [o.all] compare every pair, not only those with a changed behaviour in them
 * @param {boolean} [o.plan] only say what would be embedded (and drop the vectors of removed behaviours), loading no model
 * @returns {Promise<{ behaviours: number, embedded: number, kept: number, removed: number, pairs: object[] }>} embedded counts distinct texts; kept, behaviours
 */
export async function runCheck({ call, pid, model, loadEmbedder, all = false, plan: planOnly = false, threshold = NEAR }) {
  const [{ behaviours }, stored] = await Promise.all([call('GET', `/api/projects/${pid}/coherence/behaviours`), storedVectors(call, pid)]);
  const plan = planVectors(behaviours, stored, model);
  for (let i = 0; i < plan.remove.length; i += 1000) await call('PUT', `/api/projects/${pid}/vectors`, { remove: plan.remove.slice(i, i + 1000) });
  if (planOnly || (!plan.embed.length && !all)) return { behaviours: behaviours.length, embedded: 0, kept: 0, toEmbed: plan.embed.length, removed: plan.remove.length, pairs: [] };

  const embedder = await loadEmbedder();
  const cache = plan.vectors;
  const before = cache.size;
  await embedBehaviours(plan.embed, embedder, cache);
  const changed = all ? null : new Set(plan.embed.map((b) => b.hash));
  const pairs = nearPairs({ behaviours, vectors: cache, changed, threshold, embedder });
  // Pairs before vectors: a run that fails part-way finds the same behaviours changed next time, and sends their pairs again.
  for (let i = 0; i < pairs.length; i += 500) await call('PUT', `/api/projects/${pid}/coherence/pairs`, { pairs: pairs.slice(i, i + 500) });
  const rows = plan.embed.map((b) => {
    const v = cache.get(b.hash);
    return { id: b.id, item: b.item, hash: b.hash, model, dims: v.length, vector: packVector(v) };
  });
  for (let i = 0; i < rows.length; i += 500) await call('PUT', `/api/projects/${pid}/vectors`, { vectors: rows.slice(i, i + 500) });
  return { behaviours: behaviours.length, embedded: cache.size - before, kept: rows.length, removed: plan.remove.length, pairs };
}

async function storedVectors(call, pid) {
  const out = [];
  for (let after = ''; ; ) {
    const { vectors, next } = await call('GET', `/api/projects/${pid}/vectors${after ? `?after=${encodeURIComponent(after)}` : ''}`);
    out.push(...vectors);
    if (!next) return out;
    after = next;
  }
}
