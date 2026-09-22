import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AgentIdentityService, type AgentPrincipal } from '../src/agents/identity.js';
import { CONNECTION_RETENTION_MS, DEFAULT_AGENT_LIMITS, LEASE_MS, ReceiverService } from '../src/agents/receivers.js';
import { OwnerService } from '../src/owners/service.js';
import type { ReceiverReference } from '../src/agents/protocol.js';
import { uuid } from '../src/validation.js';
import { fixture, waitUntil } from './helpers.js';

async function setup() {
  const f = await fixture();
  const owner = await new OwnerService(f.db, f.auth).establish(`https://${uuid()}.example`, 'receiver-test');
  const receivers = f.app.receivers;
  const agents = new AgentIdentityService(f.db, f.auth, f.now, { invalidate: (tx, event) => receivers.invalidate(tx, event) });
  const make = async () => {
    const agent = await agents.create(owner.id, { display_name: 'Test listener' });
    const key = await agents.issueKey(owner.id, agent.id);
    return { agent, key, principal: await agents.authenticate(key.api_key) };
  };
  const a = await make(), b = await make();
  const call = async (who: typeof a, path: string, body?: unknown, signal?: AbortSignal) => {
    const r = await fetch(`${f.base}/api/v1/agents/me${path}`, { method: body === undefined ? 'GET' : 'POST', signal,
      headers: { Authorization: `Bearer ${who.key.api_key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json() };
  };
  const acquire = (p: AgentPrincipal, connection = uuid(), takeover = false) => receivers.acquire(p, { connection_id: connection, takeover });
  const offer = async (left: ReceiverReference, right: ReceiverReference) => {
    const room = await f.create(), now = f.now();
    await f.db.query(`INSERT INTO agent_sessions(id,initiator_agent_id,recipient_agent_id,state,created_at,offer_expires_at,expires_at,limits_json)
      VALUES($1,$2,$3,'pending',$4,$5,$6,$7)`, [room.session_id, a.agent.id, b.agent.id, new Date(now), new Date(now + 30000), new Date(now + 3600000), DEFAULT_AGENT_LIMITS]);
    for (const [p, r] of [[a.principal, left], [b.principal, right]] as const)
      await f.db.query('INSERT INTO agent_session_bindings(session_id,agent_id,lease_id,generation) VALUES($1,$2,$3,$4)', [room.session_id, p.agent_id, r.lease_id, r.generation]);
    receivers.notify(); return room.session_id;
  };
  return { ...f, owner, a, b, agents, receivers, call, acquire, offer, stop: async () => {
    // Stop receiver cleanup/polls before removing their fixture rows.
    await f.app.close();
    await f.db.query('DELETE FROM sessions WHERE id IN (SELECT id FROM agent_sessions WHERE initiator_agent_id=$1 OR recipient_agent_id=$1)', [a.agent.id]);
    await f.db.query('DELETE FROM agent_receivers WHERE agent_id IN ($1,$2)', [a.agent.id, b.agent.id]);
    await f.db.query('DELETE FROM agent_connections WHERE agent_id IN ($1,$2)', [a.agent.id, b.agent.id]);
    await f.db.query('DELETE FROM agent_credentials WHERE agent_id IN ($1,$2)', [a.agent.id, b.agent.id]);
    await f.db.query('DELETE FROM agents WHERE owner_id=$1', [owner.id]);
    await f.db.query('DELETE FROM owners WHERE id=$1', [owner.id]); await f.db.close();
  } };
}

test('distinct agents connect; concurrent same-agent acquisition has one winner across service instances', async () => {
  const f = await setup();
  try {
    const other = new ReceiverService(f.db, f.now);
    const results = await Promise.allSettled([
      f.acquire(f.a.principal), other.acquire(f.a.principal, { connection_id: uuid(), takeover: false }), f.acquire(f.b.principal),
    ]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
    assert.equal(results.filter(r => r.status === 'rejected').length, 1);
    assert.equal(await f.receivers.presence(f.a.agent.id), 'available');
    assert.equal(await f.receivers.presence(f.b.agent.id), 'available');
  } finally { await f.stop(); }
});

test('acquire replay never renews or repeats takeover, and ended receipts fence delayed clients', async () => {
  const f = await setup();
  try {
    const connection = uuid(), acquired = await f.acquire(f.a.principal, connection);
    const initial = acquired.body;
    f.advance(1000);
    const replay = await f.acquire(f.a.principal, connection);
    assert.equal(replay.replay, true); assert.deepEqual(replay.body, initial);
    await assert.rejects(f.acquire(f.a.principal, connection, true), { code: 'IDEMPOTENCY_CONFLICT' });
    const sibling = await f.agents.issueKey(f.owner.id, f.a.agent.id), siblingPrincipal = await f.agents.authenticate(sibling.api_key);
    await assert.rejects(f.acquire(siblingPrincipal, connection), { code: 'IDEMPOTENCY_CONFLICT' });
    await assert.rejects(f.receivers.heartbeat(siblingPrincipal, { receiver: initial.receiver, accepting_sessions: true }), { code: 'STALE_RECEIVER' });
    const takeoverConnection = uuid(), takeover = await f.acquire(siblingPrincipal, takeoverConnection, true);
    assert.equal(takeover.body.receiver.generation, '2');
    await assert.rejects(f.acquire(f.a.principal, connection), { code: 'CONNECTION_ENDED' });
    await assert.rejects(f.receivers.heartbeat(f.a.principal, { receiver: initial.receiver, accepting_sessions: true }), { code: 'STALE_RECEIVER' });
    await assert.rejects(f.receivers.release(f.a.principal, { receiver: initial.receiver }), { code: 'STALE_RECEIVER' });
    assert.deepEqual((await f.acquire(siblingPrincipal, takeoverConnection, true)).body.receiver, takeover.body.receiver);
    await f.receivers.release(siblingPrincipal, { receiver: takeover.body.receiver });
    await f.receivers.release(siblingPrincipal, { receiver: takeover.body.receiver });
    await assert.rejects(f.acquire(siblingPrincipal, takeoverConnection, true), { code: 'CONNECTION_ENDED' });
    assert.equal(await f.receivers.presence(f.a.agent.id), 'offline');
    f.advance(CONNECTION_RETENTION_MS + 1); await f.receivers.cleanup();
    assert.equal((await f.db.query('SELECT * FROM agent_connections WHERE agent_id=$1', [f.a.agent.id])).rows.length, 0);
    assert.equal((await f.acquire(siblingPrincipal)).body.receiver.generation, '3');
  } finally { await f.stop(); }
});

test('inbox offers are nondestructive at capacity; takeover closes bound work and tells the surviving peer to stop', async () => {
  const f = await setup();
  try {
    const a = (await f.acquire(f.a.principal)).body.receiver, b = (await f.acquire(f.b.principal)).body.receiver;
    const id = await f.offer(a, b);
    assert.equal(await f.receivers.presence(f.b.agent.id), 'busy');
    const first = await f.receivers.inbox(f.b.principal, b, 0), again = await f.receivers.inbox(f.b.principal, b, 0);
    assert.deepEqual(first, again); assert.deepEqual(first.offers.map(s => s.id), [id]);
    assert.deepEqual((await f.receivers.inbox(f.a.principal, a, 0)).offers, []);
    await f.receivers.heartbeat(f.b.principal, { receiver: b, accepting_sessions: false });
    assert.equal(await f.receivers.presence(f.b.agent.id), 'paused');
    assert.equal((await f.receivers.inbox(f.b.principal, b, 0)).offers.length, 1);
    await f.acquire(f.a.principal, uuid(), true);
    const closed = (await f.db.query<{ state: string; close_reason: string }>('SELECT state,close_reason FROM agent_sessions WHERE id=$1', [id])).rows[0];
    assert.deepEqual(closed, { state: 'closed', close_reason: 'RECEIVER_LOST' });
    assert.deepEqual((await f.receivers.heartbeat(f.b.principal, { receiver: b, accepting_sessions: true })).sessions_to_stop, [id]);
    assert.equal(await f.receivers.presence(f.b.agent.id), 'busy'); // Until local stop acknowledgement.
    await f.db.query('UPDATE agent_session_bindings SET stopped_at=now() WHERE agent_id=$1 AND session_id=$2', [f.b.agent.id, id]);
    assert.equal(await f.receivers.presence(f.b.agent.id), 'available');
    assert.deepEqual((await f.receivers.inbox(f.b.principal, b, 0)).offers, []);
  } finally { await f.stop(); }
});

test('expired leases cannot renew; closure commits on stale heartbeat and restart cleanup preserves fencing', async () => {
  const f = await setup();
  try {
    const connection = uuid(), a = (await f.acquire(f.a.principal, connection)).body.receiver;
    const b = (await f.acquire(f.b.principal)).body.receiver, id = await f.offer(a, b);
    f.advance(LEASE_MS);
    await assert.rejects(f.receivers.heartbeat(f.a.principal, { receiver: a, accepting_sessions: true }), { code: 'STALE_RECEIVER' });
    assert.equal((await f.db.query<{ state: string }>('SELECT state FROM agent_sessions WHERE id=$1', [id])).rows[0].state, 'closed');
    const restarted = new ReceiverService(f.db, f.now);
    await f.db.exec(await readFile(new URL('../migrations/010_agent_receivers.sql', import.meta.url), 'utf8'));
    await restarted.cleanup();
    assert.equal(await restarted.presence(f.b.agent.id), 'offline');
    await assert.rejects(restarted.acquire(f.a.principal, { connection_id: connection, takeover: false }), { code: 'CONNECTION_ENDED' });
    const fresh = await restarted.acquire(f.a.principal, { connection_id: uuid(), takeover: false });
    assert.equal(fresh.body.receiver.generation, '2');
  } finally { await f.stop(); }
});

test('key revocation, rotation and agent disabling fence leases; unrelated key revocation does not', async () => {
  const f = await setup();
  try {
    const a = (await f.acquire(f.a.principal)).body.receiver, b = (await f.acquire(f.b.principal)).body.receiver;
    const id = await f.offer(a, b);
    const spare = await f.agents.issueKey(f.owner.id, f.a.agent.id);
    await f.agents.revokeKey(f.owner.id, f.a.agent.id, spare.credential.id);
    assert.equal(await f.receivers.presence(f.a.agent.id), 'busy');
    const replacement = await f.agents.rotateKey(f.owner.id, f.a.agent.id, f.a.key.credential.id);
    assert.equal(await f.receivers.presence(f.a.agent.id), 'offline');
    assert.deepEqual((await f.receivers.heartbeat(f.b.principal, { receiver: b, accepting_sessions: true })).sessions_to_stop, [id]);
    const p = await f.agents.authenticate(replacement.api_key);
    await f.acquire(p);
    await f.agents.disable(f.owner.id, f.a.agent.id);
    assert.equal(await f.receivers.presence(f.a.agent.id), 'offline');
    await f.db.query('UPDATE owners SET disabled_at=now() WHERE id=$1', [f.owner.id]);
    await f.receivers.cleanup();
    assert.equal(await f.receivers.presence(f.b.agent.id), 'offline');
  } finally { await f.stop(); }
});

test('polls wake for offers, abort, shutdown and revocation without relying on shared notifications', async () => {
  const f = await setup();
  try {
    const a = (await f.acquire(f.a.principal)).body.receiver, b = (await f.acquire(f.b.principal)).body.receiver;
    const other = new ReceiverService(f.db, f.now);
    const inbox = other.inbox(f.b.principal, b, 20);
    await waitUntil(() => other.waiters.size === 1);
    const id = await f.offer(a, b); // Notifies only f.receivers, not other.
    assert.deepEqual((await inbox).offers.map(s => s.id), [id]);
    const controller = new AbortController();
    const aborted = other.inbox(f.a.principal, a, 20, controller.signal);
    const rejected = assert.rejects(aborted, { name: 'AbortError' });
    await waitUntil(() => other.waiters.size === 1); controller.abort(); await rejected;
    assert.equal(other.waiters.size, 0);
    const revoked = other.inbox(f.a.principal, a, 20);
    const revokedResult = assert.rejects(revoked, { code: 'UNAUTHORIZED' });
    await waitUntil(() => other.waiters.size === 1);
    await f.agents.revokeKey(f.owner.id, f.a.agent.id, f.a.key.credential.id);
    await revokedResult; assert.equal(other.waiters.size, 0);
    const closing = other.inbox(f.b.principal, b, 20);
    const shutdown = assert.rejects(closing, { code: 'SERVICE_UNAVAILABLE' });
    await waitUntil(() => other.waiters.size === 1); other.shutdown(); await shutdown;
  } finally { await f.stop(); }
});

test('poll admission is bounded, wall-clock expiry frees waiters, and delayed takeover replay cannot displace a newer lease', async () => {
  const f = await setup();
  try {
    const first = (await f.acquire(f.a.principal)).body.receiver;
    const takeoverId = uuid();
    await f.acquire(f.a.principal, takeoverId, true);
    const current = (await f.acquire(f.a.principal, uuid(), true)).body.receiver;
    await assert.rejects(f.acquire(f.a.principal, takeoverId, true), { code: 'CONNECTION_ENDED' });
    assert.deepEqual((await f.receivers.heartbeat(f.a.principal, { receiver: current, accepting_sessions: true })).receiver, current);
    await assert.rejects(f.db.transaction(async tx => {
      await tx.query('SELECT id FROM agents WHERE id=$1 FOR UPDATE', [f.a.agent.id]);
      await f.receivers.requireCurrent(tx, f.a.principal, first);
    }), { code: 'STALE_RECEIVER' });
    const controller = new AbortController();
    const polls = Array.from({ length: 3 }, () => f.receivers.inbox(f.a.principal, current, 20, controller.signal));
    const completions = polls.map(p => assert.rejects(p, { name: 'AbortError' }));
    await waitUntil(() => f.receivers.waiters.get(f.a.agent.id)?.size === 3);
    await assert.rejects(f.receivers.inbox(f.a.principal, current, 20), { code: 'RATE_LIMITED' });
    controller.abort(); await Promise.all(completions);
    // Bring expiry close without a fake-clock wake; the poll must wake itself.
    await f.db.query('UPDATE agent_receivers SET expires_at=$2 WHERE agent_id=$1', [f.a.agent.id, new Date(f.now() + 100)]);
    await assert.rejects(f.receivers.inbox(f.a.principal, current, 20), { code: 'STALE_RECEIVER' });
    assert.equal(f.receivers.waiters.size, 0);
  } finally { await f.stop(); }
});

test('receiver HTTP endpoints enforce references, retries, key scope, pause and disconnect cleanup', async () => {
  const f = await setup();
  try {
    const connection_id = uuid();
    assert.equal((await f.call(f.a, '')).body.availability, 'offline');
    const acquired = await f.call(f.a, '/receiver', { connection_id, takeover: false });
    assert.equal(acquired.status, 201); const receiver = acquired.body.receiver;
    assert.equal((await f.call(f.a, '/receiver', { connection_id, takeover: false })).status, 200);
    assert.equal((await f.call(f.a, '')).body.availability, 'available');
    assert.equal((await f.call(f.b, '/receiver/heartbeat', { receiver, accepting_sessions: true })).status, 409);
    assert.equal((await f.call(f.a, '/receiver/heartbeat', { receiver: { ...receiver, generation: 1 }, accepting_sessions: true })).status, 400);
    assert.equal((await f.call(f.a, '/receiver', { connection_id, takeover: false, agent_id: f.b.agent.id })).status, 400);
    assert.equal((await f.call(f.a, '/receiver/heartbeat', { receiver, accepting_sessions: false })).status, 200);
    assert.equal((await f.call(f.a, '')).body.availability, 'paused');
    const query = `/receiver/inbox?lease_id=${receiver.lease_id}&generation=${receiver.generation}`;
    assert.equal((await f.call(f.a, `${query}&wait=21`)).status, 400);
    assert.equal((await f.call(f.a, `${query}&wait=0`)).status, 200);
    const controller = new AbortController();
    const pending = f.call(f.a, `${query}&wait=20`, undefined, controller.signal);
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await waitUntil(() => f.receivers.waiters.size === 1);
    controller.abort(); await rejected;
    await waitUntil(() => f.receivers.waiters.size === 0);
    assert.equal((await f.call(f.a, '/receiver/release', { receiver })).status, 200);
    assert.equal((await f.call(f.a, '/receiver', { connection_id, takeover: false })).body.error.code, 'CONNECTION_ENDED');
  } finally { await f.stop(); }
});
