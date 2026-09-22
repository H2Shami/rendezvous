import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentClient, AgentClientError, MemoryJournal, AGENT_FRIENDS_PROTOCOL as protocol } from '../src/client/index.js';
import { Transport } from '../src/client/transport.js';
import * as wire from '../src/client/validation.js';
import { uuid, secret } from '../src/validation.js';
const agent = uuid(), peer = uuid(), receiver = { lease_id: uuid(), generation: '1' };
const limits = { max_message_bytes: 32768, idle_timeout_seconds: 600, max_session_seconds: 3600, message_budget: 1000 };
const snapshot = () => ({ id: uuid(), initiator_agent_id: peer, recipient_agent_id: agent, state: 'pending', version: 1,
  created_at: new Date().toISOString(), offer_expires_at: new Date(Date.now()+30000).toISOString(), expires_at: new Date(Date.now()+3600000).toISOString(), idle_expires_at: null, closed_at: null, close_reason: null, limits });
const key = `agk_${uuid()}.${secret()}`;
const profile = { protocol, agent: { id: agent, display_name: 'Agent' }, availability: 'offline' };
const acquired = () => ({ protocol, agent_id: agent, receiver, expires_at: new Date(Date.now()+30000).toISOString(), heartbeat_seconds: 10,
  limits: { ...limits, inbound_sessions_per_hour: 10, max_concurrent_sessions: 1, messages_per_minute: 60 } });
const failure = { protocol, error: { code: 'RATE_LIMITED', message: 'not copied to exceptions' }, request_id: uuid() };

test('definitive acceptance rejection leaves the journal unaccepted and prevents handlers from running', async () => {
  const journal = new MemoryJournal(), offer = snapshot();
  const client = new AgentClient({ serverUrl: 'https://relay.example', apiKey: key, journal, fetch: async url => {
    const path = String(url);
    if (path.endsWith('/me')) return Response.json(profile);
    if (path.endsWith('/receiver')) return Response.json(acquired());
    if (path.includes('/inbox')) return Response.json({ protocol, offers: [offer] });
    if (path.endsWith('/accept')) return Response.json({ ...failure, error: { code: 'ACCESS_DENIED', message: 'Admission denied' } }, { status: 403 });
    if (path.endsWith('/release')) return Response.json({ protocol, released: true });
    throw new Error(`Unexpected request: ${path}`);
  } });
  try {
    await client.connect();
    const offers = client.offers(), session = (await offers.next()).value!;
    await offers.return(undefined);
    await assert.rejects(session.accept(), { code: 'ACCESS_DENIED' });
    assert.equal((await journal.load())!.sessions[session.id].accepted, false);
    let calls = 0;
    assert.throws(() => session.run({ async onMessages() { calls++; }, async stop() { calls++; } }), { code: 'SESSION_NOT_ACTIVE' });
    assert.equal(calls, 0);
    assert.equal((await journal.load())!.sessions[session.id].accepted, false);
  } finally { await client.disconnect(); }
});

test('uncertain acceptance preserves the journal intent for retry and stop acknowledgement', async () => {
  const journal = new MemoryJournal(), offer = snapshot();
  let attempts = 0;
  const client = new AgentClient({ serverUrl: 'https://relay.example', apiKey: key, journal, maxAttempts: 1, fetch: async url => {
    const path = String(url);
    if (path.endsWith('/me')) return Response.json(profile);
    if (path.endsWith('/receiver')) return Response.json(acquired());
    if (path.includes('/inbox')) return Response.json({ protocol, offers: [offer] });
    if (path.endsWith('/accept')) {
      if (++attempts === 1) throw new Error('Response lost after server acceptance');
      return Response.json({ protocol, session: offer });
    }
    if (path.endsWith('/release')) return Response.json({ protocol, released: true });
    throw new Error(`Unexpected request: ${path}`);
  } });
  try {
    await client.connect();
    const offers = client.offers(), session = (await offers.next()).value!;
    await offers.return(undefined);
    await assert.rejects(session.accept(), { code: 'NETWORK_ERROR' });
    assert.equal((await journal.load())!.sessions[session.id].accepted, true);
    await session.accept();
    assert.equal(attempts, 2);
    assert.equal((await journal.load())!.sessions[session.id].accepted, true);
  } finally { await client.disconnect(); }
});

test('identity mismatch fails before recovering a pending open from another agent journal', async () => {
  const journal = new MemoryJournal();
  await journal.save({ version: 1, origin: 'https://relay.example', agentId: peer, sessions: {},
    pendingOpen: { id: uuid(), peer: agent, bindingId: uuid(), receiver, firstAttemptAt: Date.now() } });
  const before = await journal.load(), requests: string[] = [];
  const client = new AgentClient({ serverUrl: 'https://relay.example', apiKey: key, journal, fetch: async (url, init) => {
    requests.push(`${init?.method} ${new URL(String(url)).pathname}`);
    return Response.json(profile);
  } });
  await assert.rejects(client.connect(), { code: 'IDENTITY_MISMATCH' });
  assert.deepEqual(requests, ['GET /api/v1/agents/me']);
  assert.deepEqual(await journal.load(), before);
});

test('wire validators accept additive fields and reject incompatible protocols, missing fields and invalid sender shapes', () => {
  assert.equal(wire.profile({ ...profile, future: { enabled: true } }).agent.id, agent);
  assert.throws(() => wire.profile({ ...profile, protocol: 'agent-friends-http-v2' }), { code: 'UNSUPPORTED_PROTOCOL' });
  for (const value of [{ protocol }, { ...profile, agent: { id: 42, display_name: 'A' } }, { ...profile, availability: 'unknown' }]) assert.throws(() => wire.profile(value), { code: 'INVALID_RESPONSE' });
  for (const patch of [{ heartbeat_seconds: 0 }, { expires_at: 'yesterday' }, { receiver: { ...receiver, generation: '0' } }, { receiver: { ...receiver, generation: 1 } }, { limits: {} }]) assert.throws(() => wire.acquired({ ...acquired(), ...patch }), { code: 'INVALID_RESPONSE' });
  const human = { id: uuid(), sequence: 1, sender_type: 'human', sender_agent_id: null, client_message_id: null, content: 'Hello', created_at: new Date().toISOString() };
  assert.equal(wire.messages({ protocol, session: snapshot(), cursor: 1, messages: [{ ...human, extra: true }] }).messages[0].sender_type, 'human');
  for (const patch of [{ sender_agent_id: agent }, { client_message_id: uuid() }, { sender_type: 'tool' }, { content: undefined }, { sequence: -1 }]) assert.throws(() => wire.messages({ protocol, session: snapshot(), cursor: 1, messages: [{ ...human, ...patch }] }), { code: 'INVALID_RESPONSE' });
  const receipt = { ...human, sender_type: 'agent', sender_agent_id: agent, client_message_id: uuid(), content: undefined, payload_expired: true };
  assert.ok('payload_expired' in wire.sent({ protocol, message: receipt }).message);
  assert.throws(() => wire.sent({ protocol, message: { ...receipt, content: 'purged text' } }), { code: 'INVALID_RESPONSE' });
});

test('unsupported protocol fails before acquisition and malformed offers cannot reach harness code', async () => {
  let acquisitions = 0;
  const incompatible = new AgentClient({ serverUrl: 'https://relay.example', apiKey: key, fetch: async url => {
    if (String(url).endsWith('/receiver')) acquisitions++;
    return Response.json({ ...profile, protocol: 'future' });
  } });
  await assert.rejects(incompatible.connect(), { code: 'UNSUPPORTED_PROTOCOL' }); assert.equal(acquisitions, 0);
  const bodies: unknown[] = [];
  const client = new AgentClient({ serverUrl: 'https://relay.example', apiKey: key, fetch: async (url, init) => {
    assert.equal(init?.redirect, 'error');
    if (String(url).endsWith('/me')) return Response.json({ ...profile, future_field: true });
    if (String(url).endsWith('/receiver')) { bodies.push(JSON.parse(String(init?.body))); return Response.json(acquired()); }
    if (String(url).includes('/inbox')) return Response.json({ protocol, offers: [{ ...snapshot(), limits: {} }] });
    return Response.json({ protocol, released: true });
  } });
  await client.connect();
  assert.deepEqual(Object.keys(bodies[0] as object).sort(), ['connection_id','takeover']); // No unsupported optional request fields.
  let callbacks = 0;
  try { for await (const _offer of client.offers()) callbacks++; } catch (e) { assert.ok(e instanceof AgentClientError); assert.equal(e.code, 'INVALID_RESPONSE'); }
  assert.equal(callbacks, 0); assert.equal(client.sessions.length, 0); await client.disconnect();
});

test('transport honors Retry-After, aborts backoff, sanitizes errors and bounds safe replay age', async () => {
  let calls = 0; const bodies: unknown[] = [];
  const transport = new Transport('https://relay.example', { maxAttempts: 2, retryBaseMs: 1, fetch: async (_url, init) => {
    calls++; bodies.push(init?.body);
    return calls === 1 ? Response.json(failure, { status: 429, headers: { 'Retry-After': '1' } }) : Response.json({ protocol, released: true });
  } });
  const start = Date.now(); await transport.request(key, '/release', wire.success('released'), { body: { receiver } });
  assert.ok(Date.now() - start >= 950); assert.equal(calls, 2); assert.equal(bodies[0], bodies[1]);
  const waiting = new Transport('https://relay.example', { fetch: async () => Response.json(failure, { status: 503, headers: { 'Retry-After': '60' } }) });
  await assert.rejects(waiting.request(key, '/release', wire.success('released'), { signal: AbortSignal.timeout(20) }), { name: 'TimeoutError' });
  await assert.rejects(waiting.request(key, '/release', wire.success('released'), { firstAttemptAt: Date.now()-86400001 }), { code: 'RETRY_EXPIRED' });
  const denied = new Transport('https://relay.example', { fetch: async () => Response.json({ ...failure, error: { code: 'UNAUTHORIZED', message: key } }, { status: 401 }) });
  await assert.rejects(denied.request(key, '/me', wire.profile), e => {
    assert.ok(e instanceof AgentClientError); assert.equal(e.status, 401); assert.equal(e.requestId, failure.request_id); assert.ok(!e.message.includes(key)); return true;
  });
});

test('absolute session deadline cancels local work even when a status request cannot reach the server', async () => {
  const s = { ...snapshot(), initiator_agent_id: agent, recipient_agent_id: peer, state: 'active', idle_expires_at: new Date(Date.now()+10000).toISOString(), expires_at: new Date(Date.now()+150).toISOString() };
  let stopped = false;
  const client = new AgentClient({ serverUrl: 'https://relay.example', apiKey: key, maxAttempts: 1, fetch: async (url, init) => {
    const path = String(url);
    if (path.endsWith('/me')) return Response.json(profile);
    if (path.endsWith('/receiver')) return Response.json(acquired());
    if (path.endsWith('/agent-sessions')) return Response.json({ protocol, session: s });
    if (path.endsWith('/close')) return Response.json({ protocol, session: { ...s, state: 'closed', version: 2, closed_at: new Date().toISOString(), close_reason: 'COMPLETED' } });
    if (path.endsWith('/stopped')) return Response.json({ protocol, acknowledged: true });
    if (path.endsWith('/release')) return Response.json({ protocol, released: true });
    return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }));
  } });
  try {
    await client.connect(); const session = await client.open(peer);
    await session.run({ async onMessages() { throw new Error('should not run'); }, async stop() { stopped = true; } });
    assert.equal(stopped, true); assert.equal(client.signal.aborted, false);
  } finally { await client.disconnect(); }
});
