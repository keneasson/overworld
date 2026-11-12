export function readCookies(headers = {}) {
  const raw = headers.cookie ?? headers.Cookie ?? '';
  const out = {};
  for (const part of String(raw).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// HttpOnly so scripts on the page can't read it (AUTH-03); Secure and SameSite=Lax so it rides only on top-level navigations from other sites.
export function cookie(name, value, { maxAge, path = '/' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly', 'Secure', 'SameSite=Lax'];
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  return parts.join('; ');
}

export const clearCookie = (name, opts) => cookie(name, '', { ...opts, maxAge: 0 });
