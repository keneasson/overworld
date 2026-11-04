const shared = new URL('../../shared/', import.meta.url);

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@shared/')) return next(new URL(specifier.slice('@shared/'.length), shared).href, context);
  return next(specifier, context);
}
