// Lets Node resolve the "@shared/…" alias that Vite provides, and read JSX as Vite does, so tests can import web modules.
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const shared = new URL('../../shared/', import.meta.url);

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@shared/')) return next(new URL(specifier.slice('@shared/'.length), shared).href, context);
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (!url.startsWith('file:') || !url.endsWith('.jsx')) return next(url, context);
  const { code } = await transform(await readFile(new URL(url), 'utf8'), { loader: 'jsx', jsx: 'automatic', format: 'esm', sourcefile: url });
  return { format: 'module', source: code, shortCircuit: true };
}
