import { applyMigrations } from '../src/migrations.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentIdentityService } from '../src/agents/identity.js';
import { AgentPolicyService } from '../src/agents/policies.js';
import { DEFAULT_AGENT_LIMITS } from '../src/agents/receivers.js';
import { OwnerService } from '../src/owners/service.js';
import type { Queryable } from '../src/db.js';
import { requireThat, uuid } from '../src/validation.js';
import { fixture } from './helpers.js';

const origin = 'https://app.example';
async function setup() {
  const issuer = `https://${uuid()}.example`;
  const f = await fixture({ publicUrl: origin, ownerProvider: {
    async authorize() { throw new Error('unused'); }, async exchange() { throw new Error('unused'); },
    async authenticate(cookie) {
      requireThat(cookie === 'a' || cookie === 'b', 'OWNER_UNAUTHORIZED', 'Sign in.', 401);
      return { issuer, subject: cookie, sessionId: cookie, expiresAt: new Date(Date.now() + 300000) };
    }, async logout() { return origin; },
  } });
  const owners = new OwnerService(f.db, f.auth, f.now);
  const oa = await owners.establish(issuer, 'a'), ob = await owners.establish(issuer, 'b');
  const agents = new AgentIdentityService(f.db, f.auth, f.now);
  const make = async (owner: string) => {
    const agent = await agents.create(owner, { display_name: 'Agent' }), key = await agents.issueKey(owner, agent.id);
    const principal = await agents.authenticate(key.api_key);
    const receiver = (await f.app.receivers.acquire(principal, { connection_id: uuid(), takeover: false })).body.receiver;
    return { id: agent.id, owner, key, principal, receiver };
  };
  const a = await make(oa.id), b = await make(ob.id), c = await make(oa.id);
  const policies = f.app.policies;
  const call = async (path: string, method = 'GET', body?: unknown, user = 'a', extra: Record<string, string> = {}) => {
    const r = await fetch(`${f.base}/api/v1/${path}`, { method, headers: {
      Cookie: `__Host-rv-owner=${user}`, Origin: origin, 'X-CSRF-Token': owners.csrf(user),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json(), headers: r.headers };
  };
  const grant = (left: typeof a, right: typeof a, inbound = true, outbound = true) => policies.put(left.owner, left.id, right.id, { allow_inbound: inbound, allow_outbound: outbound });
  const allowed = (left = a, right = b) => f.db.transaction(tx => policies.requireAllowed(tx, left.id, right.id));
  const rooms: string[] = [];
  // REN-10 supplies real admission/accept routes. Seed their shared records here.
  const prepare = async (left = a, right = b, state = 'pending') => {
    const room = await f.create(); rooms.push(room.session_id);
    return { id: room.session_id, insert: async (tx: Queryable) => {
      const now = f.now();
      await tx.query(`INSERT INTO agent_sessions(id,initiator_agent_id,recipient_agent_id,state,created_at,offer_expires_at,expires_at,limits_json)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [room.session_id, left.id, right.id, state, new Date(now), new Date(now + 30000), new Date(now + 3600000), DEFAULT_AGENT_LIMITS]);
      for (const who of [left, right]) await tx.query(`INSERT INTO agent_session_bindings(session_id,agent_id,lease_id,generation,binding_id)
        VALUES($1,$2,$3,$4,$5)`, [room.session_id, who.id, who.receiver.lease_id, who.receiver.generation, who === left || state === 'active' ? uuid() : null]);
    } };
  };
  const session = async (left = a, right = b, state = 'pending') => {
    const p = await prepare(left, right, state); await f.db.transaction(p.insert); return p.id;
  };
  return { ...f, agents, policies, oa, ob, a, b, c, call, grant, allowed, prepare, session, stop: async () => {
    await f.app.close();
    for (const id of rooms) await f.db.query('DELETE FROM sessions WHERE id=$1', [id]);
    for (const who of [a, b, c]) {
      await f.db.query('DELETE FROM agent_receivers WHERE agent_id=$1', [who.id]);
      await f.db.query('DELETE FROM agent_connections WHERE agent_id=$1', [who.id]);
      await f.db.query('DELETE FROM agent_credentials WHERE agent_id=$1', [who.id]);
    }
    await f.db.query('DELETE FROM agents WHERE owner_id IN ($1,$2)', [oa.id, ob.id]);
    await f.db.query('DELETE FROM owners WHERE issuer=$1', [issuer]); await f.db.close();
  } };
}

test('directional grants default deny, require both owners, and never bypass same-owner policy', async () => {
  const f = await setup();
  try {
    await assert.rejects(f.allowed(), { code: 'ACCESS_DENIED' });
    await assert.rejects(f.allowed(f.a, f.c), { code: 'ACCESS_DENIED' });
    for (const outbound of [false, true]) for (const inbound of [false, true]) {
      await f.grant(f.a, f.b, false, outbound); await f.grant(f.b, f.a, inbound, false);
      if (inbound && outbound) await f.allowed();
      else await assert.rejects(f.allowed(), { code: 'ACCESS_DENIED' });
      await assert.rejects(f.allowed(f.b, f.a), { code: 'ACCESS_DENIED' });
    }
    await f.grant(f.a, f.c, false, true); await f.grant(f.c, f.a, true, false); await f.allowed(f.a, f.c);
    await assert.rejects(f.allowed(f.c, f.a), { code: 'ACCESS_DENIED' });
    await applyMigrations(f.db);
    await f.allowed(); // Reapplying migrations does not reset grants.
    await assert.rejects(f.db.transaction(tx => f.policies.requireAllowed(tx, f.a.id, uuid())), { code: 'ACCESS_DENIED', message: 'Agent contact is not permitted.' });
    await f.agents.disable(f.ob.id, f.b.id);
    await assert.rejects(f.allowed(), { code: 'ACCESS_DENIED', message: 'Agent contact is not permitted.' });
    await f.db.query('UPDATE owners SET disabled_at=now() WHERE id=$1', [f.oa.id]);
    await assert.rejects(f.allowed(f.a, f.c), { code: 'ACCESS_DENIED' });
  } finally { await f.stop(); }
});

test('policy HTTP CRUD is owner-scoped, CSRF-protected, paginated and rejects forged identities', async () => {
  const f = await setup();
  try {
    const root = `owner/agents/${f.a.id}/peers`, path = `${root}/${f.b.id}`, body = { allow_inbound: true, allow_outbound: false };
    assert.equal((await f.call(path)).status, 404);
    const put = await f.call(path, 'PUT', body);
    assert.equal(put.status, 200); assert.equal(put.body.protocol, 'agent-friends-http-v1');
    assert.equal(put.headers.get('cache-control'), 'no-store');
    assert.equal(put.body.policy.agent_id, f.a.id); assert.equal(put.body.policy.peer_agent_id, f.b.id);
    assert.doesNotMatch(JSON.stringify(put.body), /owner_id|secret_hash|api_key|availability|display_name/);
    assert.deepEqual((await f.call(path)).body.policy, put.body.policy);
    for (const method of ['GET', 'PUT', 'DELETE']) assert.equal((await f.call(path, method, method === 'PUT' ? body : undefined, 'b')).status, 404);
    assert.equal((await f.call(root, 'GET', undefined, 'b')).status, 404);
    for (const headers of [{ Origin: 'https://evil.example' }, { 'X-CSRF-Token': '' }, { 'X-CSRF-Token': 'wrong' }] as Record<string, string>[])
      assert.equal((await f.call(path, 'PUT', body, 'a', headers)).status, 403);
    assert.equal((await f.call(path, 'PUT', body, 'a', { Cookie: '', Authorization: `Bearer ${f.a.key.api_key}` })).status, 401);
    for (const invalid of [{ ...body, sender_agent_id: f.c.id }, { ...body, owner_id: f.ob.id }, { ...body, agent_id: f.c.id }, { allow_inbound: true }, { allow_inbound: 'true', allow_outbound: false }])
      assert.equal((await f.call(path, 'PUT', invalid)).status, 400);
    assert.equal((await f.call(`${root}/${f.a.id}`, 'PUT', body)).status, 400);
    assert.equal((await f.call(`${root}/invalid`, 'PUT', body)).status, 400);
    assert.equal((await f.call(`${root}/${uuid()}`, 'PUT', body)).body.error.code, 'ACCESS_DENIED');
    assert.equal((await f.call(`${path}?sender_agent_id=${f.c.id}`, 'PUT', body)).status, 400);
    await f.grant(f.a, f.c);
    const first = await f.call(`${root}?limit=1`), second = await f.call(`${root}?limit=1&after=${first.body.next_cursor}`);
    assert.deepEqual(new Set([first.body.policies[0].peer_agent_id, second.body.policies[0].peer_agent_id]), new Set([f.b.id, f.c.id]));
    assert.equal(second.body.next_cursor, null);
    assert.equal((await f.call(`${root}?limit=101`)).status, 400);
    assert.equal((await f.call(path, 'DELETE')).status, 200); assert.equal((await f.call(path, 'DELETE')).status, 200);
    assert.equal((await f.call(path)).status, 404);
    await assert.rejects(f.allowed(), { code: 'ACCESS_DENIED' });
  } finally { await f.stop(); }
});

test('revocation closes only affected directions, preserves history and signals bound conversations to stop', async () => {
  const f = await setup();
  try {
    await f.grant(f.a, f.b); await f.grant(f.b, f.a);
    const pending = await f.session(), active = await f.session(f.a, f.b, 'active'), reverse = await f.session(f.b, f.a, 'active');
    const terminal = await f.session(f.a, f.b, 'closed');
    const before = await f.db.query('SELECT * FROM agent_sessions WHERE id=$1', [terminal]);
    const messageId = uuid();
    await f.db.query('INSERT INTO messages(id,session_id,sequence,content) VALUES($1,$2,1,$3)', [messageId, active, 'Existing transcript']);
    await f.grant(f.a, f.b, true, false);
    for (const id of [pending, active]) {
      const row = (await f.db.query<{ state: string; close_reason: string; version: number }>('SELECT state,close_reason,version FROM agent_sessions WHERE id=$1', [id])).rows[0];
      assert.deepEqual(row, { state: 'closed', close_reason: 'ACCESS_REVOKED', version: 2 });
      assert.equal((await f.db.query<{ status: string }>('SELECT status FROM sessions WHERE id=$1', [id])).rows[0].status, 'CLOSED');
    }
    assert.equal((await f.db.query<{ state: string }>('SELECT state FROM agent_sessions WHERE id=$1', [reverse])).rows[0].state, 'active');
    assert.deepEqual(await f.db.query('SELECT * FROM agent_sessions WHERE id=$1', [terminal]), before);
    const stopA = await f.app.receivers.heartbeat(f.a.principal, { receiver: f.a.receiver, accepting_sessions: true });
    const stopB = await f.app.receivers.heartbeat(f.b.principal, { receiver: f.b.receiver, accepting_sessions: true });
    assert.ok(stopA.sessions_to_stop.includes(pending)); assert.ok(stopA.sessions_to_stop.includes(active));
    assert.ok(!stopB.sessions_to_stop.includes(pending)); assert.ok(stopB.sessions_to_stop.includes(active));
    assert.equal(await f.app.receivers.presence(f.a.id), 'busy');
    assert.deepEqual((await f.app.receivers.inbox(f.b.principal, f.b.receiver, 0)).offers, []);
    assert.equal((await f.db.query<{ content: string }>('SELECT content FROM messages WHERE id=$1', [messageId])).rows[0].content, 'Existing transcript');
    await f.policies.delete(f.oa.id, f.a.id, f.b.id);
    assert.equal((await f.db.query<{ close_reason: string }>('SELECT close_reason FROM agent_sessions WHERE id=$1', [reverse])).rows[0].close_reason, 'ACCESS_REVOKED');
    await f.grant(f.a, f.b); // Regrant does not reopen old work.
    assert.equal((await f.db.query<{ version: number }>('SELECT version FROM agent_sessions WHERE id=$1', [active])).rows[0].version, 2);
    assert.equal((await f.agents.authenticate(f.a.key.api_key)).agent_id, f.a.id);
  } finally { await f.stop(); }
});

test('policy changes and session closure roll back together on database failure', async () => {
  const f = await setup();
  try {
    await f.grant(f.a, f.b); await f.grant(f.b, f.a); const id = await f.session();
    const failing = new AgentPolicyService({ ...f.db, transaction: fn => f.db.transaction(tx => fn({
      orm: tx.orm,
      exec: sql => tx.exec(sql), query: async <T>(sql: string, args?: unknown[]) => {
        const result = await tx.query<T>(sql, args);
        if (sql.startsWith('UPDATE agent_sessions SET')) throw new Error('injected failure');
        return result;
      },
    })) }, f.now);
    await assert.rejects(failing.delete(f.oa.id, f.a.id, f.b.id), /injected failure/);
    await f.allowed();
    assert.equal((await f.db.query<{ state: string }>('SELECT state FROM agent_sessions WHERE id=$1', [id])).rows[0].state, 'pending');
  } finally { await f.stop(); }
});

test('concurrent grant updates use ordered locks, and revocation serializes with admission and acceptance', async () => {
  const f = await setup();
  try {
    await Promise.all([f.grant(f.a, f.b), f.grant(f.b, f.a)]);
    const other = new AgentPolicyService(f.db, f.now);
    // Model the REN-10 transaction boundary using the shared guard and seeded records.
    const prepared = await f.prepare();
    const results = await Promise.allSettled([
      f.db.transaction(async tx => { await other.requireAllowed(tx, f.a.id, f.b.id); await prepared.insert(tx); }),
      f.policies.delete(f.ob.id, f.b.id, f.a.id),
    ]);
    assert.equal(results[1].status, 'fulfilled');
    if (results[0].status === 'rejected') assert.equal(results[0].reason.code, 'ACCESS_DENIED');
    const rows = await f.db.query<{ state: string }>('SELECT state FROM agent_sessions WHERE id=$1', [prepared.id]);
    assert.ok(rows.rows.length === 0 || rows.rows[0].state === 'closed');
    await assert.rejects(f.allowed(), { code: 'ACCESS_DENIED' });
    await f.grant(f.b, f.a);
    const pending = await f.session();
    const accepting = await Promise.allSettled([
      f.db.transaction(async tx => {
        await other.requireAllowed(tx, f.a.id, f.b.id);
        const row = (await tx.query<{ state: string }>('SELECT state FROM agent_sessions WHERE id=$1 FOR UPDATE', [pending])).rows[0];
        requireThat(row.state === 'pending', 'SESSION_TERMINAL', 'Closed.', 409);
        await tx.query("UPDATE agent_sessions SET state='active',version=version+1 WHERE id=$1", [pending]);
        await tx.query('UPDATE agent_session_bindings SET binding_id=$2 WHERE session_id=$1 AND agent_id=$3', [pending, uuid(), f.b.id]);
      }),
      f.policies.put(f.oa.id, f.a.id, f.b.id, { allow_inbound: true, allow_outbound: false }),
    ]);
    assert.equal(accepting[1].status, 'fulfilled');
    if (accepting[0].status === 'rejected') assert.equal(accepting[0].reason.code, 'ACCESS_DENIED');
    assert.equal((await f.db.query<{ state: string }>('SELECT state FROM agent_sessions WHERE id=$1', [pending])).rows[0].state, 'closed');
  } finally { await f.stop(); }
});

test('runtime contacts disclose only mutually permitted outbound friends, with cursor paging', async () => {
  const f = await setup();
  const read = (suffix = '', key = f.a.key.api_key) => fetch(`${f.base}/api/v1/agents/me/peers${suffix}`, { headers: { Authorization: `Bearer ${key}` } });
  try {
    assert.equal((await read('', 'invalid')).status, 401);
    await f.grant(f.a, f.b);
    assert.deepEqual((await (await read()).json()).peers, [], 'one-sided permission is not discovery access');
    await f.grant(f.b, f.a);
    await f.grant(f.a, f.c); await f.grant(f.c, f.a);
    const first = await (await read('?limit=1')).json();
    assert.equal(first.agent_id, f.a.id); assert.equal(first.peers.length, 1);
    assert.equal(first.peers[0].display_name, 'Agent');
    assert.ok(['available', 'paused'].includes(first.peers[0].availability));
    const second = await (await read(`?limit=1&after=${first.next_cursor}`)).json();
    assert.notEqual(first.peers[0].id, second.peers[0].id); assert.equal(second.next_cursor, null);
    await f.grant(f.b, f.a, false, true);
    assert.deepEqual((await (await read()).json()).peers.map((p: any) => p.id), [f.c.id]);
    assert.equal((await read('?agent_id=' + f.b.id)).status, 400);
    await f.agents.revokeKey(f.a.owner, f.a.id, f.a.key.credential.id);
    assert.equal((await read()).status, 401);
  } finally { await f.stop(); }
});
