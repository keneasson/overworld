// The embedding model a project's behaviours are kept in (#36 COHERE-08), and where a browser gets it to place a bug
// report (#9 REPORT-02). The runtime is pinned to exact versions on the CDN, so the app's Content-Security-Policy can let
// in these and nothing else (api/static.mjs).

export const EMBED_MODEL = 'Xenova/bge-small-en-v1.5';
export const EMBED_RUNTIME = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js';
/** The runtime's WebAssembly, the version that runtime is built against. */
export const EMBED_WASM = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/';
/** Where the model's weights come from: Hugging Face, which redirects to its own file hosts. */
export const EMBED_WEIGHTS = ['https://huggingface.co', 'https://*.huggingface.co', 'https://*.hf.co'];
