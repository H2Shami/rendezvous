import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AgentIdentityService, type IdentityInvalidation } from '../src/agents/identity.js';
import { OwnerService } from '../src/owners/service.js';
import { requireThat, secret, uuid } from '../src/validation.js';
import { fixture } from './helpers.js';

const origin = 'https://app.example';
async function setup() {
  const issuer = `https://${uuid()}.example`;
  const cookies = new Map([['test-cookie-a', 'user_a'], ['test-cookie-b', 'user_b']]);
  const logs: unknown[] = [];
  const f = await fixture({ publicUrl: origin, logger: event => logs.push(event), ownerProvider: {
    async authorize() { throw new Error('Unused'); }, async exchange() { throw new Error('Unused'); },
    async authenticate(cookie) {
      const subject = cookies.get(cookie);
      requireThat(subject, 'OWNER_UNAUTHORIZED', 'Sign in to continue.', 401);
      return { issuer, subject, sessionId: `session_${subject}`, expiresAt: new Date(Date.now() + 300000) };
    },
    async logout() { return `${origin}/account`; },
  } });
  const owners = new OwnerService(f.db, f.auth, f.now);
  const a = await owners.establish(issuer, 'user_a'), b = await owners.establish(issuer, 'user_b');
  const agents = new AgentIdentityService(f.db, f.auth, f.now);
  const call = async (path: string, method = 'GET', body?: unknown, user = 'a', extra: Record<string, string> = {}) => {
    const response = await fetch(`${f.base}/api/v1/${path}`, { method, headers: {
      Cookie: `__Host-rv-owner=test-cookie-${user}`, Origin: origin,
      'X-CSRF-Token': owners.csrf(`session_user_${user}`),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  return { ...f, a, b, agents, owners, logs, call, stop: async () => {
    await f.db.query('DELETE FROM agent_credentials WHERE agent_id IN (SELECT id FROM agents WHERE owner_id IN ($1,$2))', [a.id, b.id]);
    await f.db.query('DELETE FROM agents WHERE owner_id IN ($1,$2)', [a.id, b.id]);
    await f.db.query('DELETE FROM owners WHERE issuer=$1', [issuer]); await f.stop();
  } };
}

test('multiple agents have stable identities, independent keys and no plaintext credential storage', async () => {
  const f = await setup();
  try {
    const a = await f.agents.create(f.a.id, { display_name: ' Reviewer ' });
    const b = await f.agents.create(f.a.id, { display_name: 'Writer' });
    assert.notEqual(a.id, b.id); assert.equal(a.display_name, 'Reviewer');
    const key = await f.agents.issueKey(f.a.id, a.id), sibling = await f.agents.issueKey(f.a.id, a.id);
    const other = await f.agents.issueKey(f.a.id, b.id);
    assert.match(key.api_key, /^agk_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    assert.equal((await f.agents.authenticate(key.api_key)).agent_id, a.id);
    assert.equal((await f.agents.authenticate(other.api_key)).agent_id, b.id);
    const stored = await f.db.query<{ secret_hash: string; last_used_at: Date }>('SELECT secret_hash,last_used_at FROM agent_credentials WHERE id=$1', [key.credential.id]);
    assert.match(stored.rows[0].secret_hash, /^[0-9a-f]{64}$/); assert.ok(stored.rows[0].last_used_at);
    assert.ok(!JSON.stringify(stored.rows).includes(key.api_key.split('.')[1]));
    const forged = `agk_${other.credential.id}.${key.api_key.split('.')[1]}`;
    for (const invalid of [forged, secret(), `agk_${uuid()}.${secret()}`, key.api_key + 'x'])
      await assert.rejects(f.agents.authenticate(invalid), { code: 'UNAUTHORIZED' });
    await assert.rejects(f.agents.revokeKey(f.a.id, b.id, key.credential.id), { code: 'NOT_FOUND' });
    await assert.rejects(f.agents.rotateKey(f.a.id, b.id, key.credential.id), { code: 'NOT_FOUND' });
    const rotated = await f.agents.rotateKey(f.a.id, a.id, key.credential.id);
    await assert.rejects(f.agents.authenticate(key.api_key), { code: 'UNAUTHORIZED' });
    assert.equal((await f.agents.authenticate(rotated.api_key)).agent_id, a.id);
    assert.equal((await f.agents.authenticate(sibling.api_key)).agent_id, a.id);
    await f.agents.revokeKey(f.a.id, a.id, sibling.credential.id);
    await f.agents.revokeKey(f.a.id, a.id, sibling.credential.id); // Idempotent.
    await assert.rejects(f.agents.authenticate(sibling.api_key), { code: 'UNAUTHORIZED' });
    assert.equal((await f.agents.update(f.a.id, a.id, { display_name: 'Renamed' })).id, a.id);
    const metadata = await f.agents.credentials(f.a.id, a.id, { limit: 100 });
    assert.doesNotMatch(JSON.stringify(metadata), /secret_hash|api_key|agk_/);
    await f.db.exec(await readFile(new URL('../migrations/009_agent_identities.sql', import.meta.url), 'utf8'));
    await f.db.exec(await readFile(new URL('../migrations/009_agent_identities.sql', import.meta.url), 'utf8'));
    assert.equal((await f.agents.authenticate(rotated.api_key)).agent_id, a.id);
    await assert.rejects(f.agents.authenticate(key.api_key), { code: 'UNAUTHORIZED' });
  } finally { await f.stop(); }
});

test('owner APIs enforce scope, CSRF, validation, bounded pagination and credential separation', async () => {
  const f = await setup();
  try {
    const created = await f.call('owner/agents', 'POST', { display_name: 'Agent' });
    assert.equal(created.status, 201); assert.equal(created.body.protocol, 'agent-friends-http-v1');
    const id = created.body.agent.id, path = `owner/agents/${id}`;
    assert.doesNotMatch(JSON.stringify(created.body), /owner_id|secret_hash|api_key/);
    const issued = await f.call(`${path}/credentials`, 'POST', {});
    assert.equal(issued.status, 201);
    const { api_key: key, credential } = issued.body;
    for (const [suffix, method, body] of [
      ['', 'GET', undefined], ['', 'PATCH', { display_name: 'Stolen' }], ['/disable', 'POST', {}],
      ['/credentials', 'GET', undefined], ['/credentials', 'POST', {}], ['/presence', 'GET', undefined],
      [`/credentials/${credential.id}`, 'DELETE', undefined], [`/credentials/${credential.id}/rotate`, 'POST', {}],
    ] as const) assert.equal((await f.call(`${path}${suffix}`, method, body, 'b')).status, 404);
    assert.deepEqual((await f.call('owner/agents', 'GET', undefined, 'b')).body.agents, []);
    for (const headers of [{ Origin: 'https://evil.example' }, { 'X-CSRF-Token': 'wrong' }, { 'X-CSRF-Token': '' }] as Record<string, string>[])
      assert.equal((await f.call(path, 'PATCH', { display_name: 'Changed' }, 'a', headers)).status, 403);
    assert.equal((await f.call(`${path}/credentials`, 'POST', {}, 'a', { Cookie: '', Authorization: `Bearer ${key}` })).status, 401);
    assert.equal((await f.call(`${path}/credentials`, 'POST', {}, 'a', { Cookie: `__Host-rv-owner=${key}` })).status, 401);
    const presence = await f.call(`${path}/presence`);
    assert.equal(presence.status, 200); assert.equal(presence.body.availability, 'offline');
    assert.equal(presence.headers.get('cache-control'), 'no-store');
    assert.equal((await f.call(`${path}/presence`, 'GET', undefined, 'a', { Cookie: '', Authorization: `Bearer ${key}` })).status, 401);
    assert.equal((await f.call(`${path}/presence?secret=no`)).status, 400);
    assert.equal((await f.call('agents/me')).status, 401); // Owner cookie cannot act as an agent.
    const profile = await f.call('agents/me', 'GET', undefined, 'a', { Authorization: `Bearer ${key}` });
    assert.deepEqual(profile.body.agent, { id, display_name: 'Agent' });
    assert.equal((await f.call(`agents/me?sender_agent_id=${uuid()}`, 'GET', undefined, 'a', { Authorization: `Bearer ${key}` })).status, 400);
    const room = await f.create();
    assert.equal((await f.call('agents/me', 'GET', undefined, 'a', { Authorization: `Bearer ${room.owner_token}` })).status, 401);
    for (const body of [{ display_name: '' }, { display_name: 'a'.repeat(101) }, { display_name: 'bad\nname' }, { display_name: 'A', owner_id: f.b.id }])
      assert.equal((await f.call('owner/agents', 'POST', body)).status, 400);
    assert.equal((await f.call('owner/agents/not-a-uuid')).status, 400);
    assert.equal((await f.call(`${path}/credentials`, 'POST', { agent_id: uuid() })).status, 400);
    assert.equal((await f.call('owner/agents?limit=101')).status, 400);
    assert.equal((await f.call('owner/agents?limit=1&limit=2')).status, 400);
    const second = await f.agents.create(f.a.id, { display_name: 'Second' });
    const firstPage = await f.call('owner/agents?limit=1');
    const nextPage = await f.call(`owner/agents?limit=1&after=${firstPage.body.next_cursor}`);
    assert.deepEqual(new Set([firstPage.body.agents[0].id, nextPage.body.agents[0].id]), new Set([id, second.id]));
    assert.equal(nextPage.body.next_cursor, null);
    const rotated = await f.call(`${path}/credentials/${credential.id}/rotate`, 'POST', {});
    assert.equal(rotated.status, 201);
    assert.equal((await f.call('agents/me', 'GET', undefined, 'a', { Authorization: `Bearer ${key}` })).status, 401);
    assert.equal((await f.call(`${path}/credentials/${rotated.body.credential.id}`, 'DELETE')).status, 200);
    assert.equal((await f.call(`${path}/disable`, 'POST', {})).status, 200);
    assert.doesNotMatch(JSON.stringify(f.logs), new RegExp(`${key}|${key.split('.')[1]}|secret_hash`));
    assert.equal((await f.call('agents/me')).body.protocol, 'agent-friends-http-v1');
  } finally { await f.stop(); }
});

test('concurrent rotation has one winner, and agent/owner disable blocks runtime access', async () => {
  const f = await setup();
  try {
    const agent = await f.agents.create(f.a.id, { display_name: 'Agent' });
    const key = await f.agents.issueKey(f.a.id, agent.id);
    const results = await Promise.allSettled([f.agents.rotateKey(f.a.id, agent.id, key.credential.id), f.agents.rotateKey(f.a.id, agent.id, key.credential.id)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const winner = results.find(r => r.status === 'fulfilled'); assert.ok(winner?.status === 'fulfilled');
    await f.db.query('UPDATE owners SET disabled_at=now() WHERE id=$1', [f.a.id]);
    await assert.rejects(f.agents.authenticate(winner.value.api_key), { code: 'UNAUTHORIZED' });
    await f.db.query('UPDATE owners SET disabled_at=NULL WHERE id=$1', [f.a.id]);
    await f.agents.disable(f.a.id, agent.id);
    await f.agents.disable(f.a.id, agent.id);
    await assert.rejects(f.agents.authenticate(winner.value.api_key), { code: 'UNAUTHORIZED' });
    await assert.rejects(f.agents.issueKey(f.a.id, agent.id), { code: 'AGENT_DISABLED' });
    await assert.rejects(f.agents.rotateKey(f.a.id, agent.id, winner.value.credential.id), { code: 'AGENT_DISABLED' });
    const rows = await f.agents.credentials(f.a.id, agent.id, { limit: 100 });
    assert.equal(rows.credentials.find(c => c.id === winner.value.credential.id)?.revoked_at, null); // Failed rotation rolled back.
  } finally { await f.stop(); }
});

test('invalidation hooks run transactionally and cannot leave partially rotated keys', async () => {
  const f = await setup(); const events: IdentityInvalidation[] = [];
  try {
    const agent = await f.agents.create(f.a.id, { display_name: 'Agent' });
    const key = await f.agents.issueKey(f.a.id, agent.id);
    const failing = new AgentIdentityService(f.db, f.auth, f.now, { invalidate: async () => { throw new Error('hook failure'); } });
    await assert.rejects(failing.rotateKey(f.a.id, agent.id, key.credential.id), /hook failure/);
    await assert.rejects(failing.disable(f.a.id, agent.id), /hook failure/);
    assert.equal((await f.agents.authenticate(key.api_key)).agent_id, agent.id);
    assert.equal((await f.agents.credentials(f.a.id, agent.id, { limit: 100 })).credentials.length, 1);
    const hooked = new AgentIdentityService(f.db, f.auth, f.now, { invalidate: async (tx, event) => {
      events.push(event);
      if (event.kind === 'credential_revoked') {
        const row = await tx.query<{ revoked_at: Date }>('SELECT revoked_at FROM agent_credentials WHERE id=$1', [event.credential_id]);
        assert.ok(row.rows[0].revoked_at);
      }
    } });
    await hooked.revokeKey(f.a.id, agent.id, key.credential.id);
    await hooked.disable(f.a.id, agent.id);
    assert.deepEqual(events.map(e => e.kind), ['credential_revoked', 'agent_disabled']);
  } finally { await f.stop(); }
});
