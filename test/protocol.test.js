import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { jsonBytes, proofBytes, secret, signBytes, uuid } from '../src/protocol.js';
import { fixture, http, identity, join, joinBody, message, socket } from './helpers.js';

let f;
before(async () => { f = await fixture(); });
after(async () => { await f.stop(); });
const rejects = (promise, code) => assert.rejects(promise, e => e.code === code);
const path = (s, suffix = '') => `/api/v1/sessions/${s.session_id}${suffix}`;

test('discovery needs no credential, never exposes fragment; content negotiation and headers', async () => {
  const s = await f.create();
  const d = await http(f, `/join/${s.session_id}`);
  assert.equal(d.status, 200); assert.equal(d.body.protocol, 'agent-rendezvous');
  assert.equal(JSON.stringify(d.body).includes(s.invite_token), false);
  assert.equal(d.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(d.headers.get('cache-control'), 'no-store');
  const html = await fetch(`${f.base}/join/${s.session_id}`, { headers: { Accept: 'text/html' } });
  assert.match(html.headers.get('content-type'), /text\/html/); assert.match(await html.text(), /For agents/);
  const q = await http(f, `/join/${s.session_id}?token=${s.invite_token}`);
  assert.equal(q.body.error.code, 'QUERY_CREDENTIAL_FORBIDDEN');
  const origin = await http(f, path(s), { token: s.owner_token, headers: { Origin: 'https://evil.example' } });
  assert.equal(origin.status, 403);
});

test('complete HTTP workflow and owner/participant authorization boundaries', async () => {
  const created = await http(f, '/api/v1/sessions', { body: {} });
  assert.equal(created.status, 201); const s = created.body;
  const a = await join(f, s), b = await join(f, s);
  assert.equal((await http(f, path(s))).status, 401);
  assert.equal((await http(f, path(s, '/close'), { token: a.credential, body: {} })).status, 401);
  const m = message(f, a);
  const ack = await http(f, path(s, '/messages'), { token: a.credential, body: m });
  assert.equal(ack.body.offset, 1);
  const history = await http(f, path(s, '/messages'), { token: b.credential });
  assert.deepEqual(history.body.messages[0].message, m);
  assert.equal((await http(f, path(s, '/messages'), { token: s.owner_token })).body.messages.length, 1);
  const inspect = await http(f, path(s), { token: a.credential });
  assert.equal(inspect.body.participants.length, 2); assert.equal(inspect.body.invites, undefined);
  await f.db.query('DELETE FROM sessions WHERE id=$1', [s.session_id]);
});

test('unknown, revoked, expired and exhausted invitations are rejected', async () => {
  const s = await f.create({ max_participants: 4, invite_max_uses: 1 });
  const random = await joinBody(f, s, identity(), { invite_token: secret() });
  await rejects(f.service.join(s.session_id, random.body, uuid()), 'INVALID_INVITE');
  await join(f, s);
  await rejects(join(f, s), 'INVITE_EXHAUSTED');
  const revoked = await f.service.invite(s.session_id, s.owner_token, {});
  await f.service.revoke(s.session_id, s.owner_token, revoked.invite_id, 'invite');
  await rejects(join(f, { ...s, ...revoked }), 'INVALID_INVITE');
  const expired = await f.service.invite(s.session_id, s.owner_token, {});
  await f.db.query('UPDATE invites SET expires_at=$2 WHERE id=$1', [expired.invite_id, new Date(f.now() - 1)]);
  await rejects(join(f, { ...s, ...expired }), 'INVALID_INVITE');
});

test('joining proves possession; malformed/non-Ed25519 keys and replayed challenges fail', async () => {
  const s = await f.create();
  const pair = await joinBody(f, s);
  pair.body.signature = signBytes(proofBytes('join', pair.body), identity().privateKey);
  await rejects(f.service.join(s.session_id, pair.body, uuid()), 'INVALID_SIGNATURE');
  pair.body.public_key = 'not-a-key';
  await rejects(f.service.join(s.session_id, pair.body, uuid()), 'INVALID_PUBLIC_KEY');
  const valid = await joinBody(f, s);
  await f.service.join(s.session_id, valid.body, uuid());
  await rejects(f.service.join(s.session_id, valid.body, uuid()), 'INVALID_CHALLENGE');
  const badCurve = generateKeyPairSync('x25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  const wrong = await joinBody(f, s, identity(), { public_key: badCurve });
  await rejects(f.service.join(s.session_id, wrong.body, uuid()), 'INVALID_PUBLIC_KEY');
});

test('same-key join retry preserves identity without consuming a second use', async () => {
  const s = await f.create({ invite_max_uses: 1 }); const who = identity();
  const a = await join(f, s, who), b = await join(f, s, who);
  assert.equal(a.participant_id, b.participant_id);
  const info = await f.service.inspect(s.session_id, s.owner_token);
  assert.equal(info.invites[0].use_count, 1); assert.equal(info.participants.length, 1);
});

test('concurrent final invite use and concurrent room capacity are serialized', async () => {
  for (const mode of ['invite', 'capacity']) {
    const s = await f.create({ max_participants: mode === 'invite' ? 2 : 1, invite_max_uses: 1 });
    const s2 = mode === 'capacity' ? { ...s, ...await f.service.invite(s.session_id, s.owner_token, {}) } : s;
    const result = await Promise.allSettled([join(f, s), join(f, s2)]);
    assert.equal(result.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(result.find(x => x.status === 'rejected').reason.code, mode === 'invite' ? 'INVITE_EXHAUSTED' : 'SESSION_FULL');
  }
});

test('tampered payload, signature, sender, session, stale date, and sequence attacks', async () => {
  const s = await f.create(), a = await join(f, s), b = await join(f, s);
  const original = message(f, a);
  for (const [m, code] of [
    [{ ...original, payload: { text: 'modified' } }, 'INVALID_SIGNATURE'],
    [{ ...original, signature: 'A'.repeat(86) }, 'INVALID_SIGNATURE'],
    [message(f, a, { sender_id: b.participant_id }), 'WRONG_SENDER'],
    [message(f, a, { session_id: uuid() }), 'WRONG_SENDER'],
    [message(f, a, { created_at: new Date(f.now() - 301000).toISOString() }), 'STALE_TIMESTAMP'],
    [message(f, a, { sequence: 2 }), 'SEQUENCE_CONFLICT'],
  ]) await rejects(f.service.send(s.session_id, a.credential, m), code);
  assert.equal((await f.service.history(s.session_id, b.credential)).messages.length, 0);
});

test('idempotent exact retry, conflicting IDs, and duplicate sequence never add rows', async () => {
  const s = await f.create(), a = await join(f, s); const m = message(f, a);
  assert.equal((await f.service.send(s.session_id, a.credential, m)).offset, 1);
  assert.deepEqual(await f.service.send(s.session_id, a.credential, m), { message_id: m.id, offset: 1, duplicate: true });
  await rejects(f.service.send(s.session_id, a.credential, message(f, a, { id: m.id, payload: 'different' })), 'MESSAGE_ID_CONFLICT');
  await rejects(f.service.send(s.session_id, a.credential, message(f, a)), 'SEQUENCE_CONFLICT');
  await f.service.close(s.session_id, s.owner_token);
  f.advance(301000);
  assert.equal((await f.service.send(s.session_id, a.credential, m)).duplicate, true);
  assert.equal((await f.service.history(s.session_id, a.credential)).messages.length, 1);
});

test('simultaneous writes allocate unique contiguous offsets and reject duplicate sender sequence', async () => {
  const s = await f.create(), a = await join(f, s), b = await join(f, s);
  const acks = await Promise.all([f.service.send(s.session_id, a.credential, message(f, a)), f.service.send(s.session_id, b.credential, message(f, b))]);
  assert.deepEqual(acks.map(x => x.offset).sort(), [1, 2]);
  const race = await Promise.allSettled([f.service.send(s.session_id, a.credential, message(f, a, { sequence: 2 })), f.service.send(s.session_id, a.credential, message(f, a, { sequence: 2 }))]);
  assert.equal(race.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(race.find(x => x.status === 'rejected').reason.code, 'SEQUENCE_CONFLICT');
  const h = await f.service.history(s.session_id, b.credential);
  assert.deepEqual(h.messages.map(x => x.offset), [1, 2, 3]);
});

test('global message ID collisions across concurrent sessions return a stable conflict', async () => {
  const s1 = await f.create(), s2 = await f.create(), a = await join(f, s1), b = await join(f, s2);
  const id = uuid();
  const result = await Promise.allSettled([f.service.send(s1.session_id, a.credential, message(f, a, { id })), f.service.send(s2.session_id, b.credential, message(f, b, { id }))]);
  assert.equal(result.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(result.find(x => x.status === 'rejected').reason.code, 'MESSAGE_ID_CONFLICT');
});

test('pagination, later-join visibility, and offline cursor replay', async () => {
  const s = await f.create(), a = await join(f, s);
  for (let i = 1; i <= 5; i++) await f.service.send(s.session_id, a.credential, message(f, a, { sequence: i }));
  const b = await join(f, s);
  const first = await f.service.history(s.session_id, b.credential, 0, 2);
  assert.equal(first.has_more, true); assert.equal(first.next_cursor, 2);
  const rest = await f.service.history(s.session_id, b.credential, 2);
  assert.deepEqual(rest.messages.map(x => x.offset), [3, 4, 5]);
  assert.equal(rest.has_more, false);
  await rejects(f.service.history(s.session_id, b.credential, -1), 'INVALID_REQUEST');
});

test('session-bound tokens, expiration, proof renewal and revocation', async () => {
  const s = await f.create(), other = await f.create(), a = await join(f, s);
  await rejects(f.service.history(other.session_id, a.credential), 'WRONG_SESSION');
  f.advance(901000);
  await rejects(f.service.history(s.session_id, a.credential), 'TOKEN_EXPIRED');
  const challenge = await f.service.challenge(s.session_id, uuid());
  const body = { session_id: s.session_id, participant_id: a.participant_id, client_nonce: secret(), server_nonce: challenge.server_nonce };
  body.signature = signBytes(proofBytes('renew', body), a.privateKey);
  const renewed = await f.service.renew(s.session_id, body, uuid());
  assert.equal((await f.service.history(s.session_id, renewed.credential)).messages.length, 0);
  await rejects(f.service.renew(s.session_id, body, uuid()), 'INVALID_CHALLENGE');
  await f.service.revoke(s.session_id, s.owner_token, a.participant_id, 'participant');
  await rejects(f.service.history(s.session_id, renewed.credential), 'PARTICIPANT_REVOKED');
  await rejects(f.service.renew(s.session_id, body, uuid()), 'PARTICIPANT_REVOKED');
});

test('closed is read-only, expired invalidates owner and participants, retention purges', async () => {
  const s = await f.create({ ttl_seconds: 10 }), a = await join(f, s);
  await f.service.send(s.session_id, a.credential, message(f, a));
  await f.service.close(s.session_id, s.owner_token);
  await rejects(f.service.send(s.session_id, a.credential, message(f, a, { sequence: 2 })), 'SESSION_CLOSED');
  assert.equal((await f.service.history(s.session_id, a.credential)).messages.length, 1);
  await rejects(join(f, s), 'SESSION_CLOSED');
  f.advance(11000);
  await rejects(f.service.inspect(s.session_id, s.owner_token), 'SESSION_EXPIRED');
  await rejects(f.service.challenge(s.session_id, uuid()), 'SESSION_EXPIRED');
  f.advance(86400001); await f.service.cleanup();
  assert.equal((await f.db.query('SELECT * FROM messages WHERE session_id=$1', [s.session_id])).rows.length, 0);
});

test('message size limits and malformed JSON yield stable HTTP errors', async () => {
  const s = await f.create(), a = await join(f, s);
  const huge = message(f, a, { payload: 'x'.repeat(65536) });
  const result = await http(f, path(s, '/messages'), { token: a.credential, body: huge });
  assert.equal(result.status, 413); assert.equal(result.body.error.code, 'MESSAGE_TOO_LARGE');
  const malformed = await fetch(`${f.base}${path(s, '/messages')}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
  assert.equal((await malformed.json()).error.code, 'INVALID_JSON');
  await rejects(f.service.send(s.session_id, a.credential, { ...message(f, a), ttl: 8 }), 'INVALID_REQUEST');
});

test('wire JSON rejects duplicate keys, invalid UTF-8 and non-I-JSON values before parsing', async () => {
  for (const body of ['{"max_participants":1,"max_participants":2}', '{"x":"\\ud800"}', '{"x":1e999}', '{/*comment*/}', '[1,]', Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])]) {
    const response = await fetch(`${f.base}/api/v1/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(response.status, 400); assert.equal((await response.json()).error.code, 'INVALID_JSON');
  }
  const peer = await socket(f);
  peer.ws.send('{"type":"authenticate","type":"resume"}');
  assert.equal((await peer.next(x => x.type === 'error')).code, 'INVALID_JSON'); peer.ws.terminate();
});

test('JCS handles ordering and numbers; rejects invalid Unicode and excessive nesting', () => {
  assert.equal(jsonBytes({ z: -0, a: [1e30, { b: 1, a: '\u20ac' }] }).toString(), '{"a":[1e+30,{"a":"€","b":1}],"z":0}');
  assert.throws(() => jsonBytes('\ud800'), e => e.code === 'INVALID_JSON');
  assert.throws(() => jsonBytes(Infinity), e => e.code === 'INVALID_JSON');
  let deep = 1; for (let i = 0; i < 40; i++) deep = [deep];
  assert.throws(() => jsonBytes(deep), e => e.code === 'INVALID_JSON');
});

test('arbitrary JSON includes null characters, Unicode and non-object payloads', async () => {
  const s = await f.create(), a = await join(f, s);
  const payloads = [null, true, 1e30, 'null byte: \u0000; emoji: 😀', [1, { a: '\u0000', b: -0 }]];
  for (const [index, payload] of payloads.entries()) await f.service.send(s.session_id, a.credential, message(f, a, { sequence: index + 1, payload }));
  const history = await f.service.history(s.session_id, a.credential);
  assert.deepEqual(history.messages.map(x => x.message.payload), JSON.parse(JSON.stringify(payloads)));
});

test('WebSocket authentication, bidirectional send, replay, live catch-up and revocation', async () => {
  const s = await f.create(), a = await join(f, s), b = await join(f, s);
  const wa = await socket(f, a), wb = await socket(f, b);
  try {
    wa.send({ type: 'resume', after: 0 }); wb.send({ type: 'resume', after: 0 });
    await wa.next(x => x.type === 'resumed'); await wb.next(x => x.type === 'resumed');
    const m = message(f, a); wa.send({ type: 'message', message: m });
    const ack = await wa.next(x => x.type === 'ack'); assert.equal(ack.offset, 1);
    assert.deepEqual((await wb.next(x => x.type === 'message')).message, m);
    wb.send({ type: 'message', message: message(f, b) });
    assert.equal((await wb.next(x => x.type === 'ack')).offset, 2);
    wb.ws.close();
    await new Promise(resolve => wb.ws.once('close', resolve));
    await f.service.send(s.session_id, a.credential, message(f, a, { sequence: 2 }));
    const resumed = await socket(f, b);
    try {
      resumed.send({ type: 'resume', after: 1 });
      assert.equal((await resumed.next(x => x.type === 'message')).offset, 2);
      assert.equal((await resumed.next(x => x.type === 'message')).offset, 3);
      await f.service.revoke(s.session_id, s.owner_token, b.participant_id, 'participant');
      assert.equal((await resumed.next(x => x.type === 'error')).code, 'PARTICIPANT_REVOKED');
    } finally { resumed.ws.terminate(); }
  } finally { wa.ws.terminate(); wb.ws.terminate(); }
});

test('unauthenticated, malformed and oversized sockets are closed; token expiry is enforced', async () => {
  const idle = await socket(f);
  assert.equal(await new Promise(resolve => idle.ws.once('close', code => resolve(code))), 1008);
  const invalid = await socket(f);
  invalid.send({ type: 'resume', after: 0 });
  assert.equal((await invalid.next(x => x.type === 'error')).code, 'AUTH_REQUIRED'); invalid.ws.terminate();
  const malformed = await socket(f); malformed.ws.send('{bad');
  assert.equal((await malformed.next(x => x.type === 'error')).code, 'INVALID_JSON'); malformed.ws.terminate();
  const huge = await socket(f); huge.ws.send('x'.repeat(70000));
  assert.equal(await new Promise(resolve => huge.ws.once('close', code => resolve(code))), 1009);
  const s = await f.create(), a = await join(f, s), ws = await socket(f, a);
  f.advance(901000);
  assert.equal((await ws.next(x => x.type === 'error')).code, 'TOKEN_EXPIRED'); ws.ws.terminate();
});

test('security storage contains hashes, not capabilities, and logs omit payloads', async () => {
  const s = await f.create(), a = await join(f, s);
  const stored = JSON.stringify((await f.db.query('SELECT * FROM sessions WHERE id=$1', [s.session_id])).rows)
    + JSON.stringify((await f.db.query('SELECT * FROM invites WHERE session_id=$1', [s.session_id])).rows);
  assert.equal(stored.includes(s.invite_token), false); assert.equal(stored.includes(s.owner_token), false);
  const events = []; const old = f.service.logger; f.service.logger = e => events.push(e);
  try { await f.service.send(s.session_id, a.credential, message(f, a, { payload: { text: 'TOP_SECRET_MESSAGE' } })); }
  finally { f.service.logger = old; }
  assert.equal(JSON.stringify(events).includes('TOP_SECRET_MESSAGE'), false);
  assert.equal(JSON.stringify(events).includes(a.credential), false);
});
