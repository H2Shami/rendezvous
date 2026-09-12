import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, http } from './helpers.js';
import { formatLine } from '../scripts/dev-output.js';
import { uuid } from '../src/validation.js';

test('request middleware correlates proxy, relay and business logs without credentials or content', async () => {
  const logs: Record<string, unknown>[] = [];
  const f = await fixture({ logger: entry => logs.push(entry) });
  try {
    const room = await f.create(); const request_id = uuid();
    const r = await fetch(`${f.base}/api/v1/sessions/${room.session_id}/messages`, { method: 'POST', headers: {
      Authorization: `Bearer ${room.owner_token}`, 'X-Request-ID': request_id, 'Content-Type': 'application/json',
    }, body: JSON.stringify({ content: 'PRIVATE_MESSAGE' }) });
    assert.equal(r.status, 201); await r.json();
    assert.equal(r.headers.get('x-request-id'), request_id);
    assert.ok(logs.some(e => e.event === 'message.sent' && e.request_id === request_id));
    assert.ok(logs.some(e => e.component === 'relay' && e.event === 'http.completed' && e.status === 201 && e.request_id === request_id));
    const bad = await http(f, '/api/v1/sessions?token=QUERY_SECRET'); assert.equal(bad.status, 400);
    assert.equal(bad.body.request_id, bad.headers.get('x-request-id'));
    await http(f, '/PATH_SECRET');
    const origin = await http(f, '/health', { headers: { Origin: 'https://wrong.example' } }); assert.equal(origin.status, 403);
    assert.ok(logs.some(e => e.event === 'origin.rejected' && e.received_origin === 'https://wrong.example'));
    const printed = JSON.stringify(logs);
    for (const secret of [room.owner_token, room.invite_token, 'PRIVATE_MESSAGE', 'QUERY_SECRET', 'PATH_SECRET']) assert.ok(!printed.includes(secret), secret);
  } finally { await f.stop(); }
});

test('development output labels services and turns access logs into readable lines', () => {
  assert.equal(formatLine('server', ''), null);
  assert.equal(formatLine('proxy', JSON.stringify({ event: 'http.started' })), null);
  assert.equal(formatLine('server', 'Reloading…'), '[server] Reloading…');
  const line = formatLine('server', JSON.stringify({ event: 'http.completed', method: 'POST', path: '/api/v1/sessions', status: 201, duration_ms: 12, request_id: 'request-1' }));
  assert.equal(line, '[server] POST /api/v1/sessions → 201  12ms  req=request-1');
});
