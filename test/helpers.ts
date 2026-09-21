import { openDatabase } from '../src/db.js';
import { security } from '../src/security.js';
import { Service, type ServiceConfig } from '../src/service.js';
import { createApplication } from '../src/server.js';
import type { IdentityProvider } from '../src/owners/provider.js';
import { secret, uuid } from '../src/validation.js';

export async function fixture(options: ServiceConfig & { dataDir?: string; port?: number; publicUrl?: string; pepper?: string; ownerProvider?: IdentityProvider } = {}) {
  let offset = 0;
  const clock = options.clock || (() => Date.now() + offset);
  const db = await openDatabase({ databaseUrl: process.env.TEST_DATABASE_URL, dataDir: options.dataDir ?? 'memory://' });
  const auth = security({ pepper: options.pepper || secret() });
  const service = new Service(db, auth, { clock, logger: () => {}, sessionsPerHour: 10000, joinsPerHour: 10000, messagesPerMinute: 10000, ...options });
  const app = createApplication(service, { publicUrl: options.publicUrl, ownerProvider: options.ownerProvider });
  const address = await app.listen(options.port ?? 0);
  const base = `http://127.0.0.1:${address.port}`;
  const ids: string[] = [];
  const create = async (body = {}) => { const s = await service.create(body, uuid()); ids.push(s.session_id); return s; };
  return { db, service, auth, app, base, create, now: clock,
    advance: (ms: number) => { offset += ms; for (const id of service.waiters.keys()) service.notify(id); },
    stop: async () => { await app.close(); for (const id of ids) await db.query('DELETE FROM sessions WHERE id=$1', [id]); await db.close(); },
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
export async function http(f: Fixture, path: string, { token, body, method = body === undefined ? 'GET' : 'POST', headers = {}, signal }: {
  token?: string; body?: unknown; method?: string; headers?: Record<string, string>; signal?: AbortSignal;
} = {}) {
  const response = await fetch(`${f.base}${path}`, { method, signal,
    headers: { ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json(), headers: response.headers };
}
export async function waitUntil(check: () => boolean, timeout = 2000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw new Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
