import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { security } from '../src/security.js';
import { ReceiverService } from '../src/agents/receivers.js';
import { AgentPolicyService } from '../src/agents/policies.js';
import { AgentIdentityService } from '../src/agents/identity.js';
import { AgentSessionService, TRANSCRIPT_MS, SESSION_RETENTION_MS } from '../src/agents/sessions.js';
import { OwnerService } from '../src/owners/service.js';
import { uuid } from '../src/validation.js';
import { fixture, waitUntil } from './helpers.js';

async function setup() {
  const f = await fixture(), owners = new OwnerService(f.db, f.auth, f.now);
  const owner = await owners.establish(`https://${uuid()}.example`, 'sessions');
  const identities = new AgentIdentityService(f.db, f.auth, f.now, { invalidate: (tx, e) => f.app.receivers.invalidate(tx, e) });
  const make = async () => {
    const agent = await identities.create(owner.id, { display_name: 'Agent' }), key = await identities.issueKey(owner.id, agent.id);
    const p = await identities.authenticate(key.api_key);
    const receiver = (await f.app.receivers.acquire(p, { connection_id: uuid(), takeover: false })).body.receiver;
    return { id: agent.id, key, p, receiver, binding: uuid() };
  };
  const a = await make(), b = await make(), c = await make();
  const policies = f.app.policies, sessions = f.app.agentSessions;
  const grant = async (left = a, right = b) => {
    await policies.put(owner.id, left.id, right.id, { allow_inbound: true, allow_outbound: true });
    await policies.put(owner.id, right.id, left.id, { allow_inbound: true, allow_outbound: true });
  };
  const call = async (who: typeof a, suffix: string, body?: unknown, signal?: AbortSignal) => {
    const r = await fetch(`${f.base}/api/v1/agent-sessions${suffix}`, { method: body === undefined ? 'GET' : 'POST', signal,
      headers: { Authorization: `Bearer ${who.key.api_key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json(), headers: r.headers };
  };
  const input = (left = a, right = b) => ({ receiver: left.receiver, recipient_agent_id: right.id, idempotency_key: uuid(), binding_id: left.binding });
  const open = async (active = true) => {
    await grant(); const body = input(), response = await call(a, '', body);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const id = response.body.session.id;
    if (active) assert.equal((await call(b, `/${id}/accept`, { receiver: b.receiver, binding_id: b.binding })).status, 200);
    return { id, body };
  };
  const message = (who = a, content = 'Hello') => ({ receiver: who.receiver, client_message_id: uuid(), content });
  const finish = async (id: string) => {
    assert.equal((await call(a, `/${id}/close`, { receiver: a.receiver })).status, 200);
    for (const who of [a, b]) assert.equal((await call(who, `/${id}/stopped`, { receiver: who.receiver, binding_id: who.binding })).status, 200);
  };
  return { ...f, owner, identities, a, b, c, sessions, policies, grant, call, input, open, message, finish, stop: async () => {
    await f.app.close();
    await f.db.query('DELETE FROM sessions WHERE id IN (SELECT id FROM agent_sessions WHERE initiator_agent_id IN ($1,$2,$3))', [a.id, b.id, c.id]);
    for (const who of [a, b, c]) {
      await f.db.query('DELETE FROM agent_receivers WHERE agent_id=$1', [who.id]);
      await f.db.query('DELETE FROM agent_connections WHERE agent_id=$1', [who.id]);
      await f.db.query('DELETE FROM agent_credentials WHERE agent_id=$1', [who.id]);
    }
    await f.db.query('DELETE FROM agents WHERE owner_id=$1', [owner.id]);
    await f.db.query('DELETE FROM owners WHERE id=$1', [owner.id]); await f.db.close();
  } };
}

test('HTTP agents open, accept, exchange ordered messages, close and reuse listeners without room credentials', async () => {
  const f = await setup();
  try {
    const { id } = await f.open(false);
    const room = (await f.db.query<{ owner_hash: string | null }>('SELECT owner_hash FROM sessions WHERE id=$1', [id])).rows[0];
    assert.equal(room.owner_hash, null);
    assert.equal((await f.db.query('SELECT * FROM invites WHERE session_id=$1', [id])).rows.length, 0);
    assert.equal((await f.db.query('SELECT * FROM participants WHERE session_id=$1 AND credential_hash IS NOT NULL', [id])).rows.length, 0);
    assert.equal((await f.call(f.a, `/${id}/messages`, f.message())).body.error.code, 'SESSION_NOT_ACTIVE');
    assert.equal((await f.app.receivers.inbox(f.b.p, f.b.receiver, 0)).offers[0].id, id);
    assert.equal((await f.call(f.a, `/${id}/accept`, { receiver: f.a.receiver, binding_id: uuid() })).status, 403);
    const accept = { receiver: f.b.receiver, binding_id: f.b.binding };
    assert.equal((await f.call(f.b, `/${id}/accept`, accept)).body.session.state, 'active');
    assert.equal((await f.call(f.b, `/${id}/accept`, accept)).body.session.version, 2);
    assert.equal((await f.call(f.b, `/${id}/accept`, { ...accept, binding_id: uuid() })).body.error.code, 'BINDING_CONFLICT');
    for (const who of [f.a, f.b, f.a]) assert.equal((await f.call(who, `/${id}/messages`, f.message(who))).status, 201);
    const page = await f.call(f.b, `/${id}/messages?after=0&wait=0`);
    assert.deepEqual(page.body.messages.map((m: any) => m.sequence), [1, 2, 3]);
    assert.deepEqual(page.body.messages.map((m: any) => m.sender_agent_id), [f.a.id, f.b.id, f.a.id]);
    assert.equal(page.body.cursor, 3); assert.equal(page.body.session.state, 'active');
    assert.equal(page.body.protocol, 'agent-friends-http-v1'); assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.equal((await f.call(f.a, `/${id}/messages?after=4&wait=0`)).status, 400);
    assert.equal((await f.call(f.a, `/${id}?after_version=999&wait=0`)).status, 400);
    const old = await fetch(`${f.base}/api/v1/sessions/${id}/messages?after=0&wait=0`, { headers: { Authorization: `Bearer ${f.a.key.api_key}` } });
    assert.equal(old.status, 404);
    await f.finish(id);
    assert.equal((await f.call(f.a, `/${id}/messages`, f.message())).body.error.code, 'SESSION_TERMINAL');
    assert.equal((await f.call(f.b, `/${id}/messages?after=3&wait=20`)).body.session.state, 'closed');
    assert.equal(await f.app.receivers.presence(f.a.id), 'available');
    await f.open(); // The same listeners can establish a second session.
  } finally { await f.stop(); }
});

test('open and send receipts deduplicate concurrent retries and survive closure, policy loss and listener replacement', async () => {
  const f = await setup();
  try {
    await f.grant(); const body = f.input();
    const opened = await Promise.all([f.call(f.a, '', body), f.call(f.a, '', body)]);
    assert.deepEqual(opened.map(x => x.status).sort(), [200, 201]);
    const id = opened[0].body.session.id; assert.equal(opened[1].body.session.id, id);
    assert.equal((await f.call(f.a, '', { ...body, binding_id: uuid() })).body.error.code, 'IDEMPOTENCY_CONFLICT');
    await f.call(f.b, `/${id}/accept`, { receiver: f.b.receiver, binding_id: f.b.binding });
    const message = f.message(f.a, 'Untrimmed  ');
    const sent = await Promise.all([f.call(f.a, `/${id}/messages`, message), f.call(f.a, `/${id}/messages`, message)]);
    assert.deepEqual(sent.map(x => x.status).sort(), [200, 201]); assert.equal(sent[0].body.message.id, sent[1].body.message.id);
    const version = (await f.call(f.a, `/${id}?wait=0`)).body.session.version;
    assert.equal((await f.call(f.a, `/${id}/messages`, { ...message, content: 'Untrimmed' })).body.error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal((await f.call(f.a, `/${id}?wait=0`)).body.session.version, version);
    await f.policies.delete(f.owner.id, f.a.id, f.b.id);
    assert.equal((await f.call(f.a, '', body)).body.session.close_reason, 'ACCESS_REVOKED');
    f.a.receiver = (await f.app.receivers.acquire(f.a.p, { connection_id: uuid(), takeover: true })).body.receiver;
    assert.equal((await f.call(f.a, `/${id}/messages`, message)).status, 200);
    assert.equal((await f.call(f.a, `/${id}/messages`, f.message())).body.error.code, 'STALE_RECEIVER');
    assert.equal((await f.call(f.a, '', body)).status, 200);
    const otherKey = await f.identities.issueKey(f.owner.id, f.a.id);
    const rotatedClient = { ...f.a, key: otherKey };
    assert.equal((await f.call(rotatedClient, '', body)).status, 200); // Dedup scope is identity, not key.
    await f.identities.revokeKey(f.owner.id, f.a.id, f.a.key.credential.id);
    assert.equal((await f.call(f.a, `/${id}/messages`, message)).status, 401);
  } finally { await f.stop(); }
});

test('session authorization hides unrelated sessions and checks policy before presence or capacity', async () => {
  const f = await setup();
  try {
    assert.equal((await f.call(f.a, '', f.input())).body.error.code, 'ACCESS_DENIED');
    assert.equal((await f.call(f.a, '', { ...f.input(), recipient_agent_id: uuid() })).body.error.code, 'ACCESS_DENIED');
    assert.equal((await f.call(f.a, '', { ...f.input(), sender_agent_id: f.c.id })).status, 400);
    assert.equal((await f.call(f.a, '', f.input(f.a, f.a))).status, 400);
    await f.grant();
    await f.app.receivers.heartbeat(f.b.p, { receiver: f.b.receiver, accepting_sessions: false });
    assert.equal((await f.call(f.a, '', f.input())).body.error.code, 'AGENT_PAUSED');
    await f.app.receivers.heartbeat(f.b.p, { receiver: f.b.receiver, accepting_sessions: true });
    const { id } = await f.open();
    for (const [path, body] of [
      [`/${id}?wait=0`, undefined], [`/${id}/messages?wait=0`, undefined],
      [`/${id}/messages`, f.message(f.c)], [`/${id}/accept`, { receiver: f.c.receiver, binding_id: f.c.binding }],
      [`/${id}/close`, { receiver: f.c.receiver }], [`/${id}/stopped`, { receiver: f.c.receiver, binding_id: f.c.binding }],
    ] as const) assert.equal((await f.call(f.c, path, body)).status, 404);
    assert.equal((await f.call(f.a, '', f.input())).body.error.code, 'AGENT_BUSY');
    await f.call(f.a, `/${id}/close`, { receiver: f.a.receiver });
    assert.equal((await f.call(f.a, '', f.input())).body.error.code, 'AGENT_BUSY');
    assert.equal((await f.call(f.a, `/${id}/stopped`, { receiver: f.a.receiver, binding_id: uuid() })).body.error.code, 'BINDING_CONFLICT');
    await f.finish(id);
    await f.app.receivers.release(f.b.p, { receiver: f.b.receiver });
    assert.equal((await f.call(f.a, '', f.input())).body.error.code, 'AGENT_OFFLINE');
  } finally { await f.stop(); }
});

test('send-close, admission-revocation and acceptance-revocation races leave no unauthorized active session', async () => {
  const f = await setup();
  try {
    const { id } = await f.open();
    const race = await Promise.all([f.call(f.a, `/${id}/messages`, f.message()), f.call(f.b, `/${id}/close`, { receiver: f.b.receiver })]);
    assert.ok([201, 409].includes(race[0].status)); assert.equal(race[1].status, 200);
    const history = await f.call(f.a, `/${id}/messages?wait=0`);
    assert.equal(history.body.messages.length, race[0].status === 201 ? 1 : 0);
    await f.finish(id);
    const opening = await Promise.all([f.call(f.a, '', f.input()), f.policies.delete(f.owner.id, f.b.id, f.a.id)]);
    assert.ok([201, 403].includes(opening[0].status));
    if (opening[0].status === 201) {
      const sid = opening[0].body.session.id;
      assert.equal((await f.call(f.a, `/${sid}?wait=0`)).body.session.state, 'closed');
      await f.call(f.a, `/${sid}/stopped`, { receiver: f.a.receiver, binding_id: f.a.binding });
    }
    const pending = await f.open(false);
    const accepting = await Promise.all([f.call(f.b, `/${pending.id}/accept`, { receiver: f.b.receiver, binding_id: f.b.binding }), f.policies.delete(f.owner.id, f.a.id, f.b.id)]);
    assert.ok([200, 409].includes(accepting[0].status));
    assert.equal((await f.call(f.a, `/${pending.id}?wait=0`)).body.session.state, 'closed');
  } finally { await f.stop(); }
});

test('concurrent messages are contiguous, paginated and isolated by session', async () => {
  const f = await setup();
  try {
    const { id } = await f.open();
    const sent = await Promise.all(Array.from({ length: 105 }, (_, i) => f.call(i % 2 ? f.a : f.b, `/${id}/messages`, f.message(i % 2 ? f.a : f.b, `Message ${i}`))));
    assert.ok(sent.every(x => x.status === 201));
    const first = (await f.call(f.a, `/${id}/messages?wait=0`)).body;
    const second = (await f.call(f.b, `/${id}/messages?after=${first.cursor}&wait=0`)).body;
    assert.deepEqual([...first.messages, ...second.messages].map(m => m.sequence), Array.from({ length: 105 }, (_, i) => i + 1));
    assert.equal(first.messages.length, 100); assert.equal(second.cursor, 105);
    await f.finish(id); const next = await f.open();
    assert.deepEqual((await f.call(f.a, `/${next.id}/messages?wait=0`)).body.messages, []);
    assert.equal((await f.call(f.a, `/${next.id}/messages`, f.message())).body.message.sequence, 1);
  } finally { await f.stop(); }
});

test('offer, idle and absolute deadlines commit closure even when a mutation is rejected', async () => {
  const f = await setup();
  try {
    const pending = await f.open(false);
    await f.db.query('UPDATE agent_sessions SET offer_expires_at=$2 WHERE id=$1', [pending.id, new Date(f.now() - 1)]);
    assert.equal((await f.call(f.b, `/${pending.id}/accept`, { receiver: f.b.receiver, binding_id: f.b.binding })).body.error.code, 'SESSION_TERMINAL');
    assert.equal((await f.call(f.a, `/${pending.id}?wait=0`)).body.session.close_reason, 'OFFER_TIMEOUT');
    assert.equal(await f.app.receivers.presence(f.b.id), 'available');
    await f.call(f.a, `/${pending.id}/stopped`, { receiver: f.a.receiver, binding_id: f.a.binding });
    for (const [field, reason] of [['idle_expires_at', 'IDLE_TIMEOUT'], ['expires_at', 'LIFETIME_EXCEEDED']] as const) {
      const { id } = await f.open();
      await f.db.query(`UPDATE agent_sessions SET ${field}=$2 WHERE id=$1`, [id, new Date(f.now() - 1)]);
      assert.equal((await f.call(f.a, `/${id}/messages`, f.message())).body.error.code, 'SESSION_TERMINAL');
      assert.equal((await f.call(f.a, `/${id}?wait=0`)).body.session.close_reason, reason);
      await f.finish(id);
    }
    const { id } = await f.open();
    await f.db.query("UPDATE agent_sessions SET limits_json=jsonb_set(limits_json,'{message_budget}','1') WHERE id=$1", [id]);
    assert.equal((await f.call(f.a, `/${id}/messages`, f.message())).status, 201);
    assert.equal((await f.call(f.a, `/${id}?wait=0`)).body.session.close_reason, 'MESSAGE_BUDGET');
  } finally { await f.stop(); }
});

test('long polls wake across notification scopes and release on abort, key revocation, closure and shutdown', async () => {
  const f = await setup();
  try {
    const { id } = await f.open();
    const other = new AgentSessionService(f.db, f.app.receivers, f.policies, f.now);
    const pending = other.poll(f.b.p, id, 0, 20, true);
    await waitUntil(() => other.waiters.size === 1);
    await f.call(f.a, `/${id}/messages`, f.message());
    assert.equal((await pending).session.state, 'active');
    assert.equal(other.waiters.size, 0);
    const controller = new AbortController(), abort = f.call(f.a, `/${id}/messages?after=1&wait=20`, undefined, controller.signal);
    const aborted = assert.rejects(abort, { name: 'AbortError' });
    await waitUntil(() => f.sessions.waiters.size === 1); controller.abort(); await aborted;
    await waitUntil(() => f.sessions.waiters.size === 0);
    const keyWait = other.poll(f.a.p, id, 1, 20, true), denied = assert.rejects(keyWait, { code: 'UNAUTHORIZED' });
    await waitUntil(() => other.waiters.size === 1); await f.identities.revokeKey(f.owner.id, f.a.id, f.a.key.credential.id); await denied;
    const terminal = await f.call(f.b, `/${id}/messages?after=1&wait=20`);
    assert.equal(terminal.body.session.close_reason, 'RECEIVER_LOST');
    assert.equal(other.waiters.size, 0);
  } finally { await f.stop(); }
});

test('session polls enforce waiter bounds and shutdown releases every registered waiter', async () => {
  const f = await setup();
  try {
    const { id } = await f.open(), controller = new AbortController();
    const polls = Array.from({ length: 3 }, () => f.sessions.poll(f.a.p, id, 0, 20, true, controller.signal));
    const results = polls.map(p => assert.rejects(p, { code: 'SERVICE_UNAVAILABLE' }));
    await waitUntil(() => f.sessions.waiters.get(id)?.size === 3);
    await assert.rejects(f.sessions.poll(f.a.p, id, 0, 20, true), { code: 'RATE_LIMITED' });
    f.sessions.shutdown(); await Promise.all(results); assert.equal(f.sessions.waiters.size, 0);
  } finally { await f.stop(); }
});

test('restart reconciliation and retention preserve receipts without retaining purged message text', async () => {
  const f = await setup();
  try {
    const { id, body } = await f.open(), message = f.message(f.a, 'Payload to purge');
    const sent = await f.call(f.a, `/${id}/messages`, message); assert.equal(sent.status, 201);
    const restarted = new AgentSessionService(f.db, f.app.receivers, f.policies, f.now);
    await f.db.exec(await readFile(new URL('../migrations/012_agent_sessions.sql', import.meta.url), 'utf8'));
    assert.equal((await f.db.query('SELECT id FROM participants WHERE session_id=$1 AND revoked_at IS NOT NULL', [id])).rows.length, 0);
    assert.equal((await f.db.query<{ status: string }>('SELECT status FROM sessions WHERE id=$1', [id])).rows[0].status, 'ACTIVE');
    await restarted.cleanup();
    assert.equal((await restarted.open(f.a.p, body)).body.session.id, id);
    await f.finish(id);
    f.advance(TRANSCRIPT_MS + 1);
    // Reads enforce retention without waiting for the cleanup sweep.
    assert.equal((await f.call(f.a, `/${id}/messages?wait=0`)).body.error.code, 'HISTORY_EXPIRED');
    const replay = await f.call(f.a, `/${id}/messages`, message);
    assert.equal(replay.status, 200); assert.equal(replay.body.message.payload_expired, true);
    assert.equal('content' in replay.body.message, false); assert.equal(replay.body.message.id, sent.body.message.id);
    await restarted.cleanup();
    assert.equal((await f.db.query('SELECT * FROM messages WHERE session_id=$1', [id])).rows.length, 0);
    assert.equal((await f.db.query('SELECT * FROM agent_message_receipts WHERE session_id=$1', [id])).rows.length, 1);
    assert.equal((await f.call(f.a, '', body)).status, 200);
    f.advance(SESSION_RETENTION_MS - TRANSCRIPT_MS);
    await restarted.cleanup();
    assert.equal((await f.call(f.a, `/${id}?wait=0`)).status, 404);
    assert.equal((await f.db.query('SELECT * FROM agent_operations WHERE session_id=$1', [id])).rows.length, 0);
  } finally { await f.stop(); }
});


test('reject releases unaccepted capacity; lease loss fences acceptance and byte limits count UTF-8', async () => {
  const f = await setup();
  try {
    const pending = await f.open(false);
    assert.equal((await f.call(f.a, `/${pending.id}/reject`, { receiver: f.a.receiver })).status, 403);
    const rejected = await f.call(f.b, `/${pending.id}/reject`, { receiver: f.b.receiver });
    assert.equal(rejected.body.session.close_reason, 'REJECTED');
    assert.equal((await f.call(f.b, `/${pending.id}/reject`, { receiver: f.b.receiver })).body.session.version, rejected.body.session.version);
    assert.equal(await f.app.receivers.presence(f.b.id), 'available');
    assert.equal(await f.app.receivers.presence(f.a.id), 'busy');
    await f.call(f.a, `/${pending.id}/stopped`, { receiver: f.a.receiver, binding_id: f.a.binding });
    const active = await f.open();
    assert.equal((await f.call(f.a, `/${active.id}/messages`, f.message(f.a, 'é'.repeat(16385)))).status, 413);
    assert.equal((await f.call(f.a, `/${active.id}/messages?wait=0`)).body.cursor, 0);
    assert.equal((await f.call(f.a, `/${active.id}/messages`, { ...f.message(), sender_agent_id: f.b.id })).status, 400);
    await f.finish(active.id);
    const offered = await f.open(false), old = f.b.receiver;
    f.b.receiver = (await f.app.receivers.acquire(f.b.p, { connection_id: uuid(), takeover: true })).body.receiver;
    assert.equal((await f.call(f.b, `/${offered.id}/accept`, { receiver: old, binding_id: f.b.binding })).body.error.code, 'STALE_RECEIVER');
    assert.equal((await f.call(f.b, `/${offered.id}/accept`, { receiver: f.b.receiver, binding_id: f.b.binding })).body.error.code, 'STALE_RECEIVER');
    assert.equal((await f.call(f.a, `/${offered.id}?wait=0`)).body.session.close_reason, 'RECEIVER_LOST');
  } finally { await f.stop(); }
});


test('agent session messages and receipts survive closing and reopening durable storage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rendezvous-agent-durable-'));
  const auth = security({ pepper: uuid() }); let now = Date.now(); const clock = () => now;
  let db = await openDatabase({ dataDir: dir });
  const services = () => {
    const receivers = new ReceiverService(db, clock), policies = new AgentPolicyService(db, clock);
    return { identities: new AgentIdentityService(db, auth, clock), receivers, policies,
      sessions: new AgentSessionService(db, receivers, policies, clock) };
  };
  try {
    let s = services();
    const owner = await new OwnerService(db, auth, clock).establish('https://durability.example', 'owner');
    const make = async () => {
      const agent = await s.identities.create(owner.id, { display_name: 'Agent' });
      const key = await s.identities.issueKey(owner.id, agent.id), p = await s.identities.authenticate(key.api_key);
      const receiver = (await s.receivers.acquire(p, { connection_id: uuid(), takeover: false })).body.receiver;
      return { p, receiver, key };
    };
    const a = await make(), b = await make();
    for (const [left, right] of [[a, b], [b, a]]) await s.policies.put(owner.id, left.p.agent_id, right.p.agent_id, { allow_inbound: true, allow_outbound: true });
    const open = { receiver: a.receiver, idempotency_key: uuid(), recipient_agent_id: b.p.agent_id, binding_id: uuid() };
    const id = (await s.sessions.open(a.p, open)).body.session.id;
    await s.sessions.accept(b.p, id, { receiver: b.receiver, binding_id: uuid() });
    const message = { receiver: a.receiver, client_message_id: uuid(), content: 'Durable message' };
    const original = await s.sessions.send(a.p, id, message);
    // Adopt a database created by REN-10 before the migration ledger was added.
    await db.exec('DROP TABLE schema_migrations');
    await db.close(); db = await openDatabase({ dataDir: dir }); s = services();
    await s.receivers.cleanup(); await s.sessions.cleanup();
    const authenticated = await s.identities.authenticate(a.key.api_key);
    assert.equal((await s.sessions.open(authenticated, open)).replay, true);
    const replay = await s.sessions.send(authenticated, id, message);
    assert.equal(replay.replay, true); assert.equal(replay.body.message.id, original.body.message.id);
    const next = await s.sessions.send(authenticated, id, { ...message, client_message_id: uuid() });
    assert.equal(next.body.message.sequence, 2);
    now += 31000;
    await db.close(); db = await openDatabase({ dataDir: dir }); s = services();
    await s.receivers.cleanup(); await s.sessions.cleanup();
    assert.equal((await s.sessions.poll(a.p, id, 0, 0, false)).session.close_reason, 'RECEIVER_LOST');
    assert.equal((await s.sessions.send(a.p, id, message)).replay, true);
  } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
});
