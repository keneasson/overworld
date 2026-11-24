// The embedding model, in the browser, for placing a bug report (#9 REPORT-02). It is loaded only when Report opens: the
// runtime from the CDN, the weights (about 34 MB, quantised to 8 bits) from Hugging Face, kept by the browser's cache after
// the first time. The same model the project's behaviour vectors come from, so a report's vector compares with theirs.

import { EMBED_MODEL, EMBED_RUNTIME } from '@shared/embedding.js';
import { unpackVector } from '@shared/coherence.js';
import { api } from '../api.js';

let loading = null;

/** The model, ready to embed: `embed(text)` gives a vector of length 1. Rejects if it can't load here. */
export function loadEmbedder() {
  loading ??= (async () => {
    const t = await import(/* @vite-ignore */ EMBED_RUNTIME);
    t.env.allowLocalModels = false;
    const extract = await t.pipeline('feature-extraction', EMBED_MODEL, { dtype: 'q8' });
    return { embed: async (text) => (await extract([text], { pooling: 'mean', normalize: true })).tolist()[0] };
  })();
  loading.catch(() => (loading = null));
  return loading;
}

/** Every behaviour's kept vector, by `${itemKey}:${id}`, for this model only. */
export async function behaviourVectors(projectId) {
  const out = new Map();
  let after = '';
  do {
    const page = await api.vectors(projectId, after);
    for (const v of page.vectors) if (v.model === EMBED_MODEL) out.set(`${v.item}:${v.behaviourId}`, unpackVector(v.vector));
    after = page.next;
  } while (after);
  return out;
}
