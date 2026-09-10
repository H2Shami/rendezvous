import { generateKeyPairSync } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { security } from '../src/security.js';
import { Service } from '../src/service.js';
import { createApplication } from '../src/server.js';
import { messageBytes, proofBytes, secret, signBytes, uuid } from '../src/protocol.js';
import WebSocket from 'ws';

export async function fixture(options = {}) {
  let now = Date.now();
  const keys = generateKeyPairSync('ed25519');
  const db = await openDatabase({ databaseUrl: process.env.TEST_DATABASE_URL, dataDir: options.dataDir ?? 'memory://' });
  const auth = security({ pepper: secret(), signingKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) }, () => now, 900);
  const service = new Service(db, auth, { clock: () => now, logger: () => {}, sessionsPerHour: 10000, joinsPerHour: 10000, messagesPerMinute: 10000, ...options });
  const app = createApplication(service, { publicUrl: 'http://localhost:3000', wsPollMs: 30, wsAuthTimeoutMs: 80, wsOpensPerMinute: 10000, ...options });
  let address;
  try { address = await app.listen(options.port ?? 0); }
  catch (e) { await db.close(); throw e; }
  const base = `http://127.0.0.1:${address.port}`;
  const ids = [];
  const create = async body => { const s = await service.create(body || {}, uuid()); ids.push(s.session_id); return s; };
  return { db, service, auth, app, base, create,
    now: () => now, advance: ms => { now += ms; },
    stop: async () => { await app.close(); for (const id of ids) await db.query('DELETE FROM sessions WHERE id=$1', [id]); await db.close(); },
  };
}
export function identity() {
  const pair = generateKeyPairSync('ed25519');
  return { ...pair, encoded: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') };
}
export async function joinBody(f, session, who = identity(), overrides = {}) {
  const challenge = await f.service.challenge(session.session_id, uuid());
  const body = { session_id: session.session_id, invite_token: session.invite_token, public_key: who.encoded,
    client_nonce: secret(), server_nonce: challenge.server_nonce, metadata: { name: 'test' }, ...overrides };
  body.signature = signBytes(proofBytes('join', body), who.privateKey);
  return { body, who };
}
export async function join(f, session, who = identity()) {
  const { body } = await joinBody(f, session, who);
  return { ...who, ...await f.service.join(session.session_id, body, uuid()) };
}
export function message(f, p, overrides = {}) {
  const m = { id: uuid(), session_id: p.session_id, sender_id: p.participant_id,
    sequence: 1, created_at: new Date(f.now()).toISOString(), type: 'message', content_type: 'application/json', payload: { text: 'hello' }, ...overrides };
  m.signature = signBytes(messageBytes(m), p.privateKey); return m;
}
export async function http(f, path, { token, body, method = body === undefined ? 'GET' : 'POST', headers = {} } = {}) {
  const response = await fetch(`${f.base}${path}`, { method, headers: { ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json(), headers: response.headers };
}
export async function socket(f, participant, options = {}) {
  const ws = new WebSocket(`${f.base.replace(/^http/, 'ws')}/ws`, options);
  const frames = [], waiting = new Set();
  ws.on('message', data => { const frame = JSON.parse(data); frames.push(frame); for (const notify of waiting) notify(); });
  const next = (predicate = () => true, timeout = 2000) => new Promise((resolve, reject) => {
    const check = () => { const index = frames.findIndex(predicate); if (index >= 0) { clearTimeout(timer); waiting.delete(check); resolve(frames.splice(index, 1)[0]); } };
    const timer = setTimeout(() => { waiting.delete(check); reject(new Error(`Frame timeout; received ${JSON.stringify(frames)}`)); }, timeout);
    waiting.add(check); check();
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const send = value => ws.send(JSON.stringify(value));
  if (participant) { send({ type: 'authenticate', token: participant.credential }); await next(x => x.type === 'authenticated'); }
  return { ws, next, send, frames };
}
