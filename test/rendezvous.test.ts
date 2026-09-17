import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, http } from './helpers.js';
import { secret } from '../src/validation.js';

test('concurrent admission enforces invite uses, participant limits, scoped tokens and revocation', async () => {
  const f = await fixture();
  try {
    const room = await f.create({ invite_max_uses: 1 }); const body = { invite_token: room.invite_token, display_name: 'A' };
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => f.service.join(room.session_id, body, `ip-${i}`)));
    const joined = results.flatMap(r => r.status === 'fulfilled' ? [r.value] : []); assert.equal(joined.length, 1);
    const invite = (await f.db.query<{ use_count: number; secret_hash: string }>('SELECT * FROM invites WHERE id=$1', [room.invite_id])).rows[0];
    assert.equal(invite.use_count, 1); assert.notEqual(invite.secret_hash, room.invite_token);
    for (const result of results) if (result.status === 'rejected') assert.equal(result.reason.code, 'INVITE_EXHAUSTED');
    const secondInvite = await f.service.invite(room.session_id, room.owner_token, {});
    joined.push(await f.service.join(room.session_id, { invite_token: secondInvite.invite_token }, 'second'));
    const rows = (await f.db.query<{ credential_hash: string }>('SELECT credential_hash FROM participants WHERE session_id=$1', [room.session_id])).rows;
    assert.ok(rows.every(p => p.credential_hash !== joined[0].participant_token));
    const other = await f.create();
    await assert.rejects(f.service.messages(other.session_id, joined[0].participant_token, 0, 0), { code: 'UNAUTHORIZED' });
    await assert.rejects(f.service.messages(room.session_id, '', 0, 60), { code: 'UNAUTHORIZED' });
    assert.equal(f.service.waiters.size, 0);
    await f.service.revoke(room.session_id, room.owner_token, joined[1].participant_id, 'participant');
    await assert.rejects(f.service.send(room.session_id, joined[1].participant_token, { content: 'revoked' }), { code: 'UNAUTHORIZED' });
    assert.equal((await f.service.inspect(room.session_id, room.owner_token)).status, 'WAITING');
    const extra = await f.service.invite(room.session_id, room.owner_token, {});
    await f.service.join(room.session_id, { ...body, invite_token: extra.invite_token }, 'new');
    assert.equal((await f.db.query<{ use_count: number }>('SELECT use_count FROM invites WHERE id=$1', [extra.invite_id])).rows[0].use_count, 1);
    await f.service.leave(room.session_id, joined[0].participant_token);
    await assert.rejects(f.service.send(room.session_id, joined[0].participant_token, { content: 'left' }), { code: 'UNAUTHORIZED' });
  } finally { await f.stop(); }
});

test('expired/revoked invites, closure, validation and rate limits retain admission protections', async () => {
  const f = await fixture();
  try {
    const room = await f.create(); const body = { invite_token: room.invite_token };
    await assert.rejects(f.service.join(room.session_id, { invite_token: secret() }, 'x'), { code: 'INVALID_INVITE' });
    await assert.rejects(f.service.join(room.session_id, { ...body, display_name: 5 }, 'x'), { code: 'INVALID_REQUEST' });
    await assert.rejects(f.service.join(room.session_id, { ...body, metadata: [] }, 'x'), { code: 'INVALID_METADATA' });
    await f.service.revoke(room.session_id, room.owner_token, room.invite_id, 'invite');
    await assert.rejects(f.service.join(room.session_id, body, 'x'), { code: 'INVALID_INVITE' });
    const short = await f.service.invite(room.session_id, room.owner_token, { ttl_seconds: 1 }); f.advance(2000);
    await assert.rejects(f.service.join(room.session_id, { invite_token: short.invite_token }, 'x'), { code: 'INVALID_INVITE' });
    const good = await f.service.invite(room.session_id, room.owner_token, {});
    const p = await f.service.join(room.session_id, { invite_token: good.invite_token }, 'x');
    await assert.rejects(f.service.close(room.session_id, p.participant_token), { code: 'UNAUTHORIZED' });
    await assert.rejects(f.service.send(room.session_id, p.participant_token, { content: '' }), { code: 'INVALID_CONTENT' });
    await assert.rejects(f.service.send(room.session_id, p.participant_token, { content: '💬'.repeat(9000) }), { code: 'INVALID_CONTENT' });
    await f.service.close(room.session_id, room.owner_token);
    await assert.rejects(f.service.join(room.session_id, body, 'x'), { code: 'SESSION_CLOSED' });
    await assert.rejects(f.service.send(room.session_id, p.participant_token, { content: 'closed' }), { code: 'SESSION_CLOSED' });
    const expired = await f.create({ ttl_seconds: 1 }); f.advance(2000);
    await assert.rejects(f.service.join(expired.session_id, { invite_token: expired.invite_token }, 'x'), { code: 'SESSION_EXPIRED' });
    f.service.config.joinsPerHour = 1;
    await assert.rejects(f.service.join(room.session_id, body, 'limited'), { code: 'SESSION_CLOSED' });
    await assert.rejects(f.service.join(room.session_id, body, 'limited'), { code: 'RATE_LIMITED' });
  } finally { await f.stop(); }
});

test('join URL is sufficient in text, HTML and JSON; old infrastructure endpoints are absent', async () => {
  const f = await fixture();
  try {
    const room = await f.create(); const base = `/api/v1/sessions/${room.session_id}`;
    const plain = await (await fetch(`${f.base}/join/${room.session_id}`)).text();
    for (const text of ['POST', '?after=0&wait=60', 'participant_token', 'WAITING IS WORK', 'empty polls do not mean completion', 'Only GET responses advance', 'curl', 'Privacy']) assert.ok(plain.includes(text), text);
    assert.ok(!plain.includes(room.invite_token));
    const d = await http(f, `/join/${room.session_id}`, { headers: { Accept: 'application/json' } });
    assert.equal(d.body.protocol, 'rendezvous-http-v1'); assert.equal(d.body.recommended_long_poll_seconds, 60);
    assert.equal(d.body.endpoints.messages, `${f.base}${base}/messages`);
    const html = await (await fetch(`${f.base}/join/${room.session_id}`, { headers: { Accept: 'text/html' } })).text();
    assert.ok(html.includes('participant_token')); assert.ok(html.includes('curl'));
    for (const path of ['/challenge', '/renew', '/peers']) assert.equal((await http(f, base + path)).status, 404);
    for (const path of ['/ws', '/client.mjs', '/.well-known/agent-card.json']) assert.equal((await http(f, path)).status, 404);
    assert.equal((await http(f, base, { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await http(f, `${base}?participant_token=secret`)).status, 400);
    const invalid = await fetch(`${f.base}/api/v1/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"max_participants":2,"max_participants":3}' });
    assert.equal(invalid.status, 400);
    assert.equal((await http(f, base + '/messages?after=0&after=1')).status, 400);
    assert.equal((await http(f, base + '/messages?wait=61')).status, 400);
  } finally { await f.stop(); }
});


test('creation APIs enforce invite limits and reusable invites count each admission', async () => {
  const f = await fixture();
  try {
    const invalid = await http(f, '/api/v1/sessions', { body: { invite_max_uses: 3 } });
    assert.equal(invalid.status, 400);
    const room = await f.create({ invite_max_uses: 1 });
    const path = `/api/v1/sessions/${room.session_id}`;
    assert.equal((await http(f, `${path}/invites`, { token: room.owner_token, body: { max_uses: 3 } })).status, 400);
    const invite = await f.service.invite(room.session_id, room.owner_token, {});
    const body = { invite_token: invite.invite_token };
    const joined = await http(f, `${path}/join`, { body });
    assert.equal(joined.status, 201);
    await f.service.leave(room.session_id, joined.body.participant_token);
    const second = await http(f, `${path}/join`, { body });
    assert.equal(second.status, 201);
    const retry = await http(f, `${path}/join`, { body });
    assert.equal(retry.status, 403);
    assert.equal(retry.body.error.code, 'INVITE_EXHAUSTED');
  } finally { await f.stop(); }
});
