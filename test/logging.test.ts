import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { fixture, http } from './helpers.js';
import { createGateway } from '../scripts/proxy.js';
import { formatLine } from '../scripts/dev-output.js';
import { uuid } from '../src/validation.js';

test('request middleware correlates proxy, relay and business logs without credentials or content', async () => {
  const logs: Record<string, unknown>[] = [];
  const f = await fixture({ logger: entry => logs.push(entry) });
  const gateway = createGateway(f.base, 'http://127.0.0.1:1', entry => logs.push(entry));
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
  try {
    const room = await f.create(); const request_id = uuid();
    const base = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
    const r = await fetch(`${base}/api/v1/sessions/${room.session_id}/messages`, { method: 'POST', headers: {
      Authorization: `Bearer ${room.owner_token}`, 'X-Request-ID': request_id, 'Content-Type': 'application/json',
    }, body: JSON.stringify({ content: 'PRIVATE_MESSAGE' }) });
    assert.equal(r.status, 201); await r.json();
    assert.equal(r.headers.get('x-request-id'), request_id);
    assert.ok(logs.some(e => e.event === 'message.sent' && e.request_id === request_id));
    for (const component of ['relay', 'proxy']) assert.ok(logs.some(e => e.component === component && e.event === 'http.completed' && e.status === 201 && e.request_id === request_id));
    const bad = await http(f, '/api/v1/sessions?token=QUERY_SECRET'); assert.equal(bad.status, 400);
    assert.equal(bad.body.request_id, bad.headers.get('x-request-id'));
    await http(f, '/PATH_SECRET');
    const origin = await http(f, '/health', { headers: { Origin: 'https://wrong.example' } }); assert.equal(origin.status, 403);
    assert.ok(logs.some(e => e.event === 'origin.rejected' && e.received_origin === 'https://wrong.example'));
    const printed = JSON.stringify(logs);
    for (const secret of [room.owner_token, room.invite_token, 'PRIVATE_MESSAGE', 'QUERY_SECRET', 'PATH_SECRET']) assert.ok(!printed.includes(secret), secret);
    const unavailable = await fetch(base); assert.equal(unavailable.status, 502);
    assert.equal((await unavailable.json()).error.code, 'UPSTREAM_UNAVAILABLE');
    assert.ok(logs.some(e => e.event === 'proxy.error' && e.upstream === 'web' && e.error_code === 'ECONNREFUSED'));
  } finally { gateway.closeAllConnections(); await new Promise<void>(resolve => gateway.close(() => resolve())); await f.stop(); }
});

test('development output labels services and turns access logs into readable lines', () => {
  assert.equal(formatLine('server', ''), null);
  assert.equal(formatLine('proxy', JSON.stringify({ event: 'http.started' })), null);
  assert.equal(formatLine('server', 'Reloading…'), '[server] Reloading…');
  const line = formatLine('server', JSON.stringify({ event: 'http.completed', method: 'POST', path: '/api/v1/sessions', status: 201, duration_ms: 12, request_id: 'request-1' }));
  assert.equal(line, '[server] POST /api/v1/sessions → 201  12ms  req=request-1');
});
