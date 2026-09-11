import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, http, waitUntil } from './helpers.js';

test('peer departure broadcasts roster, persists for late reads, and frees one transactional admission slot', async () => {
  const f = await fixture();
  try {
    const room = await f.create({ max_participants: 3 });
    const join = (invite_token = room.invite_token) => f.service.join(room.session_id, { invite_token }, 'test');
    const [a, b, c] = await Promise.all([join(), join(), join()]);
    const path = `/api/v1/sessions/${room.session_id}/messages?after=0&wait=60`;
    const polls = [a, b].map(p => http(f, path, { token: p.participant_token }));
    await waitUntil(() => f.service.waiters.get(room.session_id)?.size === 2);
    const started = Date.now(); await f.service.leave(room.session_id, c.participant_token);
    const pages = await Promise.all(polls);
    assert.ok(Date.now() - started < 1500);
    for (const { body } of pages) {
      assert.equal(body.session_status, 'active'); // State alone cannot identify departure.
      assert.equal(body.cursor, 0); assert.deepEqual(body.messages, []);
      assert.ok(body.participants.find((p: { id: string }) => p.id === c.participant_id).left_at);
    }
    const late = await f.service.messages(room.session_id, a.participant_token, 0, 0);
    assert.ok(late.participants.find(p => p.id === c.participant_id)?.left_at);
    await assert.rejects(join(), { code: 'INVITE_EXHAUSTED' });
    await assert.rejects(f.service.send(room.session_id, c.participant_token, { content: 'old token' }), { code: 'UNAUTHORIZED' });
    const invite = await f.service.invite(room.session_id, room.owner_token, { max_uses: 3 });
    const results = await Promise.allSettled([join(invite.invite_token), join(invite.invite_token), join(invite.invite_token)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    for (const r of results) if (r.status === 'rejected') assert.equal(r.reason.code, 'SESSION_FULL');
    const info = await f.service.inspect(room.session_id, room.owner_token);
    assert.equal(info.participants.length, 4);
    assert.equal(info.participants.filter(p => !p.left_at && !p.revoked_at).length, 3);
  } finally { await f.stop(); }
});

test('owner messages use the durable relay without agent admission and enforce authentication and lifecycle', async () => {
  const f = await fixture();
  try {
    const room = await f.create({ max_participants: 1 });
    const p = await f.service.join(room.session_id, { invite_token: room.invite_token }, 'a');
    const path = `/api/v1/sessions/${room.session_id}/messages`;
    const reading = http(f, `${path}?after=0&wait=60`, { token: p.participant_token });
    await waitUntil(() => f.service.waiters.has(room.session_id));
    const sent = await http(f, path, { token: room.owner_token, body: { content: 'Owner task details' } });
    assert.equal(sent.status, 201); assert.equal(sent.body.sender_id, 'owner');
    assert.equal((await reading).body.messages[0].content, 'Owner task details');
    const reply = await f.service.send(room.session_id, p.participant_token, { content: 'Acknowledged' });
    assert.equal(reply.sequence, 2);
    assert.equal((await f.service.inspect(room.session_id, room.owner_token)).participants.length, 1);
    const other = await f.create();
    assert.equal((await http(f, path, { token: other.owner_token, body: { content: 'wrong room' } })).status, 403);
    assert.equal((await http(f, path, { body: { content: 'anonymous' } })).status, 403);
    await f.service.close(room.session_id, room.owner_token);
    await assert.rejects(f.service.send(room.session_id, room.owner_token, { content: 'closed' }), { code: 'SESSION_CLOSED' });
    const expired = await f.create({ ttl_seconds: 1 }); f.advance(2000);
    await assert.rejects(f.service.send(expired.session_id, expired.owner_token, { content: 'expired' }), { code: 'SESSION_EXPIRED' });
  } finally { await f.stop(); }
});
