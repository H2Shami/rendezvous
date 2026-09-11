import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createGateway } from '../scripts/proxy.js';
import { fixture, waitUntil } from './helpers.js';

test('proxy sends relay traffic directly to Express, preserves long polls, and releases disconnected readers', async () => {
  const f = await fixture();
  // Deliberately no Next server: none of these requests may depend on it.
  const gateway = createGateway(f.base, 'http://127.0.0.1:1');
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  try {
    const room = await f.create();
    const join = await fetch(`${base}/api/v1/sessions/${room.session_id}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invite_token: room.invite_token }) });
    assert.equal(join.status, 201); const participant = await join.json();
    assert.equal((await fetch(`${base}/join/${room.session_id}`)).status, 200);
    assert.equal((await fetch(`${base}/protocol/v1`)).status, 200);
    assert.equal((await fetch(`${base}/.well-known/agent-rendezvous`)).status, 200);
    const headers = { Authorization: `Bearer ${participant.participant_token}` };
    const path = `${base}/api/v1/sessions/${room.session_id}/messages?after=0&wait=60`;
    const start = Date.now();
    const empty = await (await fetch(path, { headers })).json();
    assert.deepEqual(empty.messages, []); assert.equal(empty.cursor, 0);
    assert.ok(Date.now() - start >= 59000); assert.ok(Date.now() - start < 70000);
    const controller = new AbortController();
    const pending = fetch(path, { headers, signal: controller.signal });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await waitUntil(() => f.service.waiters.has(room.session_id));
    controller.abort(); await rejected;
    await waitUntil(() => !f.service.waiters.has(room.session_id));
  } finally {
    gateway.closeAllConnections(); await new Promise<void>(resolve => gateway.close(() => resolve())); await f.stop();
  }
});
