import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, http, waitUntil } from './helpers.js';
import { testClient } from './http-client.js';

test('two plain HTTP clients coordinate, keep waiting on timeout, and retrieve late messages', async () => {
  const f = await fixture();
  try {
    const room = await f.create(); const invitation = `${f.base}/join/${room.session_id}#${room.invite_token}`;
    const a = await testClient(invitation, 'Alice');
    const empty = await a.poll(1); assert.equal(empty.session_status, 'waiting'); assert.deepEqual(empty.messages, []);
    const waiting = a.poll(60);
    await waitUntil(() => (f.service.waiters.get(room.session_id)?.size || 0) === 1);
    const b = await testClient(invitation, 'Bob');
    await b.send('Could Alice meet Thursday?');
    let first = await waiting; assert.equal(first.session_status, 'active');
    if (!first.messages.length) first = await a.poll(60); // Joining itself can wake a poll.
    assert.match(first.messages[0].content, /Thursday/);
    await a.send('Thursday at 7 works, subject to approval.');
    const reply = await b.poll(60); assert.equal(reply.messages.at(-1).content, 'Thursday at 7 works, subject to approval.');
    assert.equal(reply.messages[0].sender_id, b.membership.participant_id); // Own sends are included.
    await a.poll(0); // Drain own message without skipping any peer messages.
    const finalWait = a.poll(60);
    await b.send('Thursday at 7 works for Bob too, also subject to approval.');
    assert.match((await finalWait).messages[0].content, /Bob too/);
    await a.send('Tentative time agreed. Asking my user for approval.');
    const late = await b.poll(0); assert.match(late.messages.at(-1).content, /Asking my user/);
    const again = await http(f, `/api/v1/sessions/${room.session_id}/messages?after=0&wait=0`, { token: b.membership.participant_token });
    assert.equal(again.body.messages.length, 4); assert.equal(again.body.cursor, 4);
    await a.leave(); await b.leave();
    assert.equal((await f.service.inspect(room.session_id, room.owner_token)).status, 'WAITING');
  } finally { await f.stop(); }
});

test('concurrent sends have contiguous session ordering and paginated reads do not skip messages', async () => {
  const f = await fixture();
  try {
    const room = await f.create();
    const a = await f.service.join(room.session_id, { invite_token: room.invite_token }, 'a');
    const b = await f.service.join(room.session_id, { invite_token: room.invite_token }, 'b');
    const sent = await Promise.all(Array.from({ length: 120 }, (_, i) => f.service.send(room.session_id, i % 2 ? a.participant_token : b.participant_token, { content: `message ${i}` })));
    assert.deepEqual(sent.map(m => m.sequence).sort((a, b) => a - b), Array.from({ length: 120 }, (_, i) => i + 1));
    const first = await f.service.messages(room.session_id, a.participant_token, 0, 0);
    const second = await f.service.messages(room.session_id, a.participant_token, first.cursor, 0);
    assert.equal(first.messages.length, 100); assert.equal(second.messages.length, 20); assert.equal(second.cursor, 120);
    assert.deepEqual((await f.service.messages(room.session_id, b.participant_token, 0, 0)).messages, first.messages);
    await assert.rejects(f.service.messages(room.session_id, a.participant_token, 121, 0), { code: 'INVALID_CURSOR' });
    const other = await f.create(); const c = await f.service.join(other.session_id, { invite_token: other.invite_token }, 'c');
    assert.equal((await f.service.send(other.session_id, c.participant_token, { content: 'separate ordering' })).sequence, 1);
  } finally { await f.stop(); }
});

test('long polls broadcast nondestructively, wake quickly, and release disconnected requests', async () => {
  const f = await fixture();
  try {
    const room = await f.create(); const p = await f.service.join(room.session_id, { invite_token: room.invite_token }, 'a');
    const path = `/api/v1/sessions/${room.session_id}/messages?after=0&wait=60`;
    const first = http(f, path, { token: p.participant_token });
    const second = http(f, path, { token: p.participant_token });
    await waitUntil(() => f.service.waiters.get(room.session_id)?.size === 2);
    const started = Date.now(); await f.service.send(room.session_id, p.participant_token, { content: 'wake both' });
    const [a, b] = await Promise.all([first, second]);
    assert.ok(Date.now() - started < 1500); assert.deepEqual(a.body, b.body); assert.equal(a.body.cursor, 1);
    const controller = new AbortController();
    const poll = http(f, path.replace('after=0', 'after=1'), { token: p.participant_token, signal: controller.signal });
    const rejected = assert.rejects(poll, { name: 'AbortError' });
    await waitUntil(() => f.service.waiters.get(room.session_id)?.size === 1); controller.abort(); await rejected;
    await waitUntil(() => f.service.waiters.size === 0);
    assert.ok(f.service.metrics['poll.disconnected'] >= 1);
  } finally { await f.stop(); }
});

test('close, expiry, revocation and leaving promptly unblock waiting reads', async () => {
  const f = await fixture();
  try {
    for (const action of ['close', 'expire', 'revoke', 'leave']) {
      const room = await f.create(); const p = await f.service.join(room.session_id, { invite_token: room.invite_token }, action);
      const waiting = http(f, `/api/v1/sessions/${room.session_id}/messages?after=0&wait=60`, { token: p.participant_token });
      await waitUntil(() => f.service.waiters.has(room.session_id));
      if (action === 'close') await f.service.close(room.session_id, room.owner_token);
      if (action === 'expire') f.advance(86401000);
      if (action === 'revoke') await f.service.revoke(room.session_id, room.owner_token, p.participant_id, 'participant');
      if (action === 'leave') await f.service.leave(room.session_id, p.participant_token);
      const result = await waiting;
      assert.equal(result.status, ['revoke', 'leave'].includes(action) ? 403 : 200);
      if (action === 'close') assert.equal(result.body.session_status, 'closed');
      if (action === 'expire') { assert.equal(result.body.session_status, 'expired'); assert.deepEqual(result.body.messages, []); }
      await waitUntil(() => !f.service.waiters.has(room.session_id));
    }
  } finally { await f.stop(); }
});

test('wall-clock expiry wakes without a notification and a bounded timeout releases its waiter', async () => {
  const f = await fixture();
  try {
    const room = await f.create({ ttl_seconds: 1 }); const p = await f.service.join(room.session_id, { invite_token: room.invite_token }, 'a');
    const started = Date.now(); const page = await f.service.messages(room.session_id, p.participant_token, 0, 60);
    assert.equal(page.session_status, 'expired'); assert.ok(Date.now() - started < 1800); assert.equal(f.service.waiters.size, 0);
    const second = await f.create(); const q = await f.service.join(second.session_id, { invite_token: second.invite_token }, 'b');
    const start = Date.now(); const empty = await f.service.messages(second.session_id, q.participant_token, 0, 1);
    assert.equal(empty.cursor, 0); assert.equal(empty.session_status, 'waiting'); assert.ok(Date.now() - start >= 900); assert.ok(Date.now() - start < 1800);
  } finally { await f.stop(); }
});

test('insert racing the initial read is not lost and waiter limits are bounded', async () => {
  const f = await fixture();
  try {
    const room = await f.create(); const p = await f.service.join(room.session_id, { invite_token: room.invite_token }, 'a');
    const reads = Array.from({ length: 3 }, () => f.service.messages(room.session_id, p.participant_token, 0, 60));
    await waitUntil(() => f.service.waiters.get(room.session_id)?.size === 3);
    await assert.rejects(f.service.messages(room.session_id, p.participant_token, 0, 60), { code: 'TOO_MANY_POLLS' });
    await f.service.send(room.session_id, p.participant_token, { content: 'one log' });
    assert.ok((await Promise.all(reads)).every(page => page.cursor === 1));
    for (let i = 1; i <= 10; i++) {
      const reading = f.service.messages(room.session_id, p.participant_token, i, 60);
      const writing = f.service.send(room.session_id, p.participant_token, { content: 'racing' });
      const [page, message] = await Promise.all([reading, writing]); assert.equal(page.cursor, message.sequence);
    }
    assert.equal(f.service.waiters.size, 0);
  } finally { await f.stop(); }
});
