import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export class AuthError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const random = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (s) => createHash('sha256').update(s).digest('base64url');
export const hmac = (key, s) => createHmac('sha256', key).update(s).digest('base64url');
export const sameText = (a = '', b = '') => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

// Cognito's SECRET_HASH for a client that has a secret.
export const secretHash = (clientSecret, username, clientId) => createHmac('sha256', clientSecret).update(username + clientId).digest('base64');


export const normalEmail = (e) => String(e ?? '').trim().toLowerCase();
