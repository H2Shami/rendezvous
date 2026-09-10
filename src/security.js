import { createHmac, timingSafeEqual, generateKeyPairSync, createPublicKey, sign, verify } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ProtocolError, requireThat, secret } from './protocol.js';

export async function loadSecrets(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
  const { privateKey } = generateKeyPairSync('ed25519');
  const data = { pepper: secret(), signingKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
  return data;
}
export function security({ pepper, signingKey }, clock = Date.now, tokenSeconds = 900) {
  const pub = createPublicKey(signingKey);
  const digest = raw => createHmac('sha256', pepper).update(raw).digest('hex');
  const matches = (raw, stored) => {
    if (typeof raw !== 'string' || typeof stored !== 'string') return false;
    const a = Buffer.from(digest(raw), 'hex'), b = Buffer.from(stored, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const issue = (p, session) => {
    const now = Math.floor(clock() / 1000);
    const exp = Math.min(now + tokenSeconds, Math.floor(new Date(session.expires_at).getTime() / 1000));
    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: 'agent-rendezvous', aud: 'agent-rendezvous/v1',
      sub: p.id, session: session.id, iat: now, exp, scope: ['session:read', 'session:write'] })).toString('base64url');
    const data = `${header}.${payload}`;
    return { credential: `${data}.${sign(null, Buffer.from(data), signingKey).toString('base64url')}`,
      credential_expires_at: new Date(exp * 1000).toISOString() };
  };
  const decode = token => {
    try {
      requireThat(typeof token === 'string' && token.length < 4096, 'UNAUTHORIZED', 'Invalid credential.', 401);
      const parts = token.split('.');
      requireThat(parts.length === 3, 'UNAUTHORIZED', 'Invalid credential.', 401);
      const [h, p, s] = parts, header = JSON.parse(Buffer.from(h, 'base64url'));
      requireThat(header.alg === 'EdDSA' && header.typ === 'JWT' && verify(null, Buffer.from(`${h}.${p}`), pub, Buffer.from(s, 'base64url')), 'UNAUTHORIZED', 'Invalid credential.', 401);
      const claims = JSON.parse(Buffer.from(p, 'base64url'));
      requireThat(claims.iss === 'agent-rendezvous' && claims.aud === 'agent-rendezvous/v1' && typeof claims.exp === 'number', 'UNAUTHORIZED', 'Invalid claims.', 401);
      requireThat(claims.exp > clock() / 1000, 'TOKEN_EXPIRED', 'Renew using a signed challenge.', 401);
      return claims;
    } catch (e) { if (e instanceof ProtocolError) throw e; throw new ProtocolError('UNAUTHORIZED', 'Invalid credential.', 401); }
  };
  return { digest, matches, issue, decode };
}

export class RateLimiter {
  constructor(clock = Date.now) { this.clock = clock; this.buckets = new Map(); }
  take(key, limit, interval) {
    const now = this.clock();
    if (this.buckets.size > 10000) this.sweep();
    const old = this.buckets.get(key);
    const b = old && old.until > now ? old : { count: 0, until: now + interval };
    requireThat(b.count < limit, 'RATE_LIMITED', 'Rate limit exceeded. Retry after the current window.', 429);
    requireThat(this.buckets.size < 50000 || this.buckets.has(key), 'RATE_LIMITED', 'Service is busy.', 429);
    b.count++; this.buckets.set(key, b);
  }
  sweep() { for (const [k, v] of this.buckets) if (v.until <= this.clock()) this.buckets.delete(k); }
}
