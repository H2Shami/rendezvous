import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentClient, AgentClientError, MemoryJournal } from '../src/client/index.js';
import { AgentIdentityService } from '../src/agents/identity.js';
import { OwnerService } from '../src/owners/service.js';
import { fixture, waitUntil } from './helpers.js';
import { uuid } from '../src/validation.js';

async function setup() {
  const f = await fixture();
  const owner = await new OwnerService(f.db, f.auth, f.now).establish(`https://${uuid()}.example`, 'sdk');
  const identities = new AgentIdentityService(f.db, f.auth, f.now, { invalidate: (tx, e) => f.app.receivers.invalidate(tx, e) });
  const a = await identities.create(owner.id, { display_name: 'A' }), b = await identities.create(owner.id, { display_name: 'B' });
  const ka = await identities.issueKey(owner.id, a.id), kb = await identities.issueKey(owner.id, b.id);
  for (const [left, right] of [[a,b],[b,a]]) await f.app.policies.put(owner.id, left.id, right.id, { allow_inbound: true, allow_outbound: true });
  const clients: AgentClient[] = [];
  const make = (apiKey = ka.api_key, options: Partial<ConstructorParameters<typeof AgentClient>[0]> = {}) => {
    const client = new AgentClient({ serverUrl: f.base, apiKey, retryBaseMs: 1, ...options }); clients.push(client); return client;
  };
  return { ...f, owner, identities, a, b, ka, kb, make, stop: async () => {
    for (const client of clients) await client.disconnect().catch(() => {});
    await f.app.close();
    await f.db.query('DELETE FROM sessions WHERE id IN (SELECT id FROM agent_sessions WHERE initiator_agent_id IN ($1,$2))', [a.id,b.id]);
    for (const table of ['agent_receivers','agent_connections','agent_credentials']) await f.db.query(`DELETE FROM ${table} WHERE agent_id IN ($1,$2)`, [a.id,b.id]);
    await f.db.query('DELETE FROM agents WHERE owner_id=$1', [owner.id]); await f.db.query('DELETE FROM owners WHERE id=$1', [owner.id]); await f.db.close();
  } };
}

test('two independent SDK clients accept multi-message sessions, include humans, stop handlers and retain listeners', async () => {
  const f = await setup();
  try {
    let beats = 0;
    const a = f.make(), b = f.make(f.kb.api_key, { fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (String(url).endsWith('/heartbeat')) beats++;
      if (String(url).endsWith('/receiver') && response.ok) return Response.json({ ...await response.json(), heartbeat_seconds: 1 });
      return response;
    } });
    await Promise.all([a.connect(), b.connect()]); assert.notEqual(a.agent!.id, b.agent!.id);
    const offers = b.offers(); const offered = offers.next(); const outgoing = await a.open(f.b.id);
    const incoming = (await offered).value!; assert.equal(incoming.id, outgoing.id); await offers.return(undefined);
    await incoming.accept();
    const seen: string[] = []; let stopped = false;
    const running = incoming.run({ async onMessages(messages, session) { seen.push(...messages.map(m => m.sender_type)); await session.send(`reply ${messages.at(-1)!.content}`); }, async stop() { stopped = true; } });
    const request = await outgoing.send('one'); assert.equal(request.sequence, 1);
    await waitUntil(() => seen.length === 1);
    let page = await outgoing.read({ wait: 0 });
    while (page.cursor < 2) page = await outgoing.read({ wait: 0 });
    assert.deepEqual(page.messages.map(m => m.content), ['one', 'reply one']); await outgoing.acknowledge(page.cursor);
    await f.app.agentSessions.ownerSend(f.owner.id, outgoing.id, { content: 'human note' });
    await waitUntil(() => seen.length === 2);
    page = await outgoing.read({ wait: 0 }); while (page.cursor < 4) page = await outgoing.read({ wait: 0 });
    assert.deepEqual(seen, ['agent','human']); assert.equal(page.messages[0].sender_agent_id, null);
    await waitUntil(() => beats > 0, 3000);
    await outgoing.close(); await running; await outgoing.stopped();
    assert.equal(stopped, true); assert.equal(a.signal.aborted, false); assert.equal(b.signal.aborted, false);
    assert.equal(await f.app.receivers.presence(f.b.id), 'available');
    await a.forgetSession(outgoing.id); await b.forgetSession(incoming.id); assert.equal(a.sessions.length + b.sessions.length, 0);
  } finally { await f.stop(); }
});

test('lost open/send responses retry exact durable IDs without duplicate sessions, messages or cursor advancement', async () => {
  const f = await setup();
  try {
    const journal = new MemoryJournal(), bodies: string[] = []; let loseOpen = true, loseSend = true;
    const a = f.make(undefined, { journal, fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (String(url).endsWith('/agent-sessions') && init?.method === 'POST') {
        bodies.push(String(init.body)); assert.ok((await journal.load())!.pendingOpen);
        if (loseOpen) { loseOpen = false; await response.text(); throw new TypeError('connection dropped'); }
      }
      if (String(url).endsWith('/messages') && init?.method === 'POST') {
        bodies.push(String(init.body)); const state = (await journal.load())!; assert.ok(Object.values(state.sessions)[0].pendingMessage);
        if (loseSend) { loseSend = false; await response.text(); throw new TypeError('connection dropped'); }
      }
      return response;
    } }), b = f.make(f.kb.api_key);
    await a.connect(); await b.connect(); const out = await a.open(f.b.id);
    const offers = b.offers(); const incoming = (await offers.next()).value!; await offers.return(undefined); await incoming.accept();
    const receipt = await out.send('exact content'); assert.equal(receipt.sequence, 1); assert.equal(out.cursor, 0);
    assert.equal(bodies[0], bodies[1]); assert.equal(bodies[2], bodies[3]);
    assert.equal((await f.db.query('SELECT id FROM messages WHERE session_id=$1', [out.id])).rows.length, 1);
    assert.equal((await f.db.query('SELECT id FROM agent_sessions WHERE initiator_agent_id=$1', [f.a.id])).rows.length, 1);
    assert.equal((await journal.load())!.sessions[out.id].pendingMessage, undefined);
    const again = b.offers({ signal: AbortSignal.timeout(100) }); await assert.rejects(again.next());
  } finally { await f.stop(); }
});

test('journal reconnect preserves a live lease and bindings; interrupted model work never reruns automatically', async () => {
  const f = await setup();
  try {
    const journal = new MemoryJournal(), crash = new AbortController();
    const a = f.make(), b = f.make(f.kb.api_key, { journal }); await a.connect(); await b.connect({ signal: crash.signal });
    const out = await a.open(f.b.id), iterator = b.offers(), incoming = (await iterator.next()).value!; await iterator.return(undefined); await incoming.accept();
    let calls = 0;
    const running = incoming.run({ async onMessages(_messages, _session, signal) { calls++; await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); throw new Error('interrupted turn'); }, async stop() {} });
    await out.send('work'); await waitUntil(() => calls === 1); const receiver = b.receiver;
    crash.abort(); await running;
    assert.ok((await journal.load())!.sessions[incoming.id].turn);
    const resumed = f.make(f.kb.api_key, { journal }); await resumed.connect(); assert.deepEqual(resumed.receiver, receiver);
    const restored = resumed.sessions[0]; assert.equal(restored.recovered, true); assert.equal(restored.bindingId, incoming.bindingId);
    assert.throws(() => restored.run({ async onMessages() { calls++; }, async stop() {} }), { code: 'RECOVERY_REQUIRED' });
    assert.equal(calls, 1);
    await restored.acknowledgeInterrupted(); assert.equal(restored.cursor, 1); await restored.close(); await restored.stopped();
  } finally { await f.stop(); }
});

test('credential providers pin identity, rotation requires reconnect, and takeover fences the old client', async () => {
  const f = await setup();
  try {
    let key = f.ka.api_key;
    const a = f.make(undefined, { apiKey: () => key }); await a.connect(); const old = a.receiver;
    await a.disconnect(); key = f.kb.api_key;
    await assert.rejects(a.connect(), { code: 'IDENTITY_MISMATCH' });
    const rotated = await f.identities.rotateKey(f.owner.id, f.a.id, f.ka.credential.id); key = rotated.api_key;
    await a.connect(); assert.notEqual(a.receiver!.lease_id, old!.lease_id);
    const replacement = f.make(rotated.api_key); await assert.rejects(replacement.connect(), { code: 'RECEIVER_CONFLICT' }); await replacement.connect({ takeover: true });
    await assert.rejects(a.heartbeat(), { code: 'STALE_RECEIVER' }); assert.equal(a.signal.aborted, true);
    await replacement.setAcceptingSessions(false); assert.equal(await f.app.receivers.presence(f.a.id), 'paused');
    await replacement.setAcceptingSessions(true); assert.equal(await f.app.receivers.presence(f.a.id), 'available');
    await f.identities.revokeKey(f.owner.id, f.a.id, rotated.credential.id);
    await assert.rejects(replacement.heartbeat(), { code: 'UNAUTHORIZED' });
  } finally { await f.stop(); }
});

test('remote closure aborts a busy model, waits for cleanup before stopped acknowledgement and leaves the connection online', async () => {
  const f = await setup();
  try {
    const a = f.make(), b = f.make(f.kb.api_key); await a.connect(); await b.connect();
    const out = await a.open(f.b.id), offers = b.offers(), incoming = (await offers.next()).value!; await offers.return(undefined); await incoming.accept();
    let started = false, aborted = false, cleanup = false;
    let finish!: () => void; const canStop = new Promise<void>(resolve => { finish = resolve; });
    const running = incoming.run({ async onMessages(_m, _s, signal) { started = true; await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true })); }, async stop() { cleanup = true; await canStop; } });
    await out.send('long work'); await waitUntil(() => started); await f.app.agentSessions.ownerClose(f.owner.id, out.id);
    await waitUntil(() => aborted && cleanup);
    assert.equal(await f.app.receivers.presence(f.b.id), 'busy'); finish(); await running;
    assert.equal(await f.app.receivers.presence(f.b.id), 'available'); assert.equal(b.signal.aborted, false);
  } finally { await f.stop(); }
});

test('journal failure prevents network mutations and keys never enter journal snapshots', async () => {
  const f = await setup();
  try {
    const memory = new MemoryJournal(); let fail = false, opens = 0;
    const a = f.make(undefined, { journal: { load: () => memory.load(), async save(state) { if (fail) throw new Error('disk'); await memory.save(state); } }, fetch: async (url, init) => { if (String(url).endsWith('/agent-sessions')) opens++; return fetch(url, init); } });
    await a.connect(); assert.doesNotMatch(JSON.stringify(await memory.load()), /agk_|api_key|apiKey/);
    fail = true; await assert.rejects(a.open(f.b.id), { code: 'JOURNAL_ERROR' }); assert.equal(opens, 0); assert.equal(a.signal.aborted, true);
    fail = false;
  } finally { await f.stop(); }
});

test('unconfirmed sends recover their original receipt after key rotation and a new lease without rerunning work', async () => {
  const f = await setup();
  try {
    const journal = new MemoryJournal(); let lost = false;
    const a = f.make(undefined, { journal, maxAttempts: 1, fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (!lost && String(url).endsWith('/messages') && init?.method === 'POST') { lost = true; await response.text(); throw new TypeError('lost response'); }
      return response;
    } }), b = f.make(f.kb.api_key);
    await a.connect(); await b.connect(); const out = await a.open(f.b.id), offers = b.offers(), incoming = (await offers.next()).value!; await offers.return(undefined); await incoming.accept();
    await assert.rejects(out.send('once'), { code: 'NETWORK_ERROR' }); assert.ok(journal);
    const pending = (await journal.load())!.sessions[out.id].pendingMessage!; assert.equal(pending.content, 'once');
    const rotated = await f.identities.rotateKey(f.owner.id, f.a.id, f.ka.credential.id);
    await assert.rejects(a.heartbeat(), { code: 'UNAUTHORIZED' });
    const recovered = f.make(rotated.api_key, { journal }); await recovered.connect();
    const receipt = await recovered.sessions[0].send('once'); assert.equal(receipt.client_message_id, pending.id); assert.equal(receipt.sequence, 1);
    assert.equal(recovered.signal.aborted, false); assert.equal((await journal.load())!.sessions[out.id].pendingMessage, undefined);
    assert.equal((await f.db.query('SELECT id FROM messages WHERE session_id=$1', [out.id])).rows.length, 1);
    const oldSession = recovered.sessions[0]; await oldSession.status(); await oldSession.stopped(); await recovered.forgetSession(oldSession.id);
    assert.equal(recovered.sessions.length, 0); await recovered.heartbeat();
  } finally { await f.stop(); }
});

test('a pending open survives loss of its response and is recovered before creating another connection', async () => {
  const f = await setup();
  try {
    const journal = new MemoryJournal(), crash = new AbortController();
    const a = f.make(undefined, { journal, maxAttempts: 1, fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (String(url).endsWith('/agent-sessions')) { await response.text(); throw new TypeError('lost open'); }
      return response;
    } }), b = f.make(f.kb.api_key);
    await a.connect({ signal: crash.signal }); await b.connect();
    await assert.rejects(a.open(f.b.id), { code: 'NETWORK_ERROR' });
    const operation = (await journal.load())!.pendingOpen!; assert.ok(operation); crash.abort();
    const recovered = f.make(undefined, { journal }); await recovered.connect();
    assert.equal(recovered.sessions.length, 1); assert.equal(recovered.sessions[0].bindingId, operation.bindingId);
    assert.equal((await journal.load())!.pendingOpen, undefined);
    assert.equal((await f.db.query('SELECT id FROM agent_sessions WHERE initiator_agent_id=$1', [f.a.id])).rows.length, 1);
  } finally { await f.stop(); }
});

test('poll cancellation releases waiters and duplicate accept responses reuse the same local binding', async () => {
  const f = await setup();
  try {
    let lose = true; const accepted: string[] = [];
    const a = f.make(), b = f.make(f.kb.api_key, { fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (String(url).endsWith('/accept')) { accepted.push(String(init?.body)); if (lose) { lose = false; await response.text(); throw new TypeError('lost accept'); } }
      return response;
    } });
    await a.connect(); await b.connect(); const out = await a.open(f.b.id), offers = b.offers(), incoming = (await offers.next()).value!; await offers.return(undefined);
    await incoming.accept(); assert.equal(accepted.length, 2); assert.equal(accepted[0], accepted[1]);
    await assert.rejects(out.read({ signal: AbortSignal.timeout(50) }), { name: 'TimeoutError' });
    await waitUntil(() => !f.service.waiters.has(out.id)); assert.equal(a.signal.aborted, false);
    assert.equal(incoming.snapshot.state, 'active');
  } finally { await f.stop(); }
});

test('overlapping disconnect and reconnect serialize lease replacement', async () => {
  const f = await setup();
  try {
    const client = f.make(); await client.connect(); const previous = client.receiver!;
    const disconnect = client.disconnect(), reconnect = client.connect();
    await Promise.all([disconnect, reconnect]);
    assert.notEqual(client.receiver!.lease_id, previous.lease_id); assert.equal(client.signal.aborted, false);
    await client.heartbeat(); assert.equal(await f.app.receivers.presence(f.a.id), 'available');
  } finally { await f.stop(); }
});

test('a lost takeover acquisition retries its journaled connection ID and intent on explicit reconnect', async () => {
  const f = await setup();
  try {
    const bodies: string[] = []; let lose = true;
    const original = f.make(); await original.connect();
    const replacement = f.make(undefined, { maxAttempts: 1, fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (String(url).endsWith('/receiver')) { bodies.push(String(init?.body)); if (lose) { lose = false; await response.text(); throw new TypeError('lost acquisition'); } }
      return response;
    } });
    await assert.rejects(replacement.connect({ takeover: true }), { code: 'NETWORK_ERROR' });
    await replacement.connect(); assert.equal(bodies[0], bodies[1]); assert.equal(replacement.receiver!.generation, '2');
    assert.equal(replacement.isConnected, true);
  } finally { await f.stop(); }
});
