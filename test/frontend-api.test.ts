import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, createSession, getRoom, sendMessage } from '../frontend/lib/api.js';

test('API helpers send credentials only for authenticated requests and preserve cancellation', async context => {
  const requests: { endpoint: string; init: RequestInit }[] = [];
  context.mock.method(globalThis, 'fetch', async (endpoint: string, init: RequestInit) => {
    requests.push({ endpoint, init });
    return Response.json({ status: 'ACTIVE' });
  });
  const owner = { session: 'room-id', token: 'private-token' };
  const controller = new AbortController();
  await createSession(2);
  await getRoom(owner, controller.signal);
  await sendMessage(owner, 'Hello');
  assert.equal(new Headers(requests[0].init.headers).has('Authorization'), false);
  assert.equal(requests[1].endpoint, '/api/v1/sessions/room-id');
  assert.equal(requests[1].init.signal, controller.signal);
  assert.equal(new Headers(requests[1].init.headers).get('Authorization'), 'Bearer private-token');
  assert.equal(requests[2].init.method, 'POST');
  assert.deepEqual(JSON.parse(requests[2].init.body as string), { content: 'Hello' });
});

test('API errors preserve retry timing and request correlation without leaking credentials', async context => {
  context.mock.method(globalThis, 'fetch', async () => Response.json(
    { error: { code: 'RATE_LIMITED', message: 'Slow down' } },
    { status: 429, headers: { 'Retry-After': '60', 'X-Request-ID': 'correlation-id' } },
  ));
  await assert.rejects(getRoom({ session: 'room-id', token: 'private-token' }), error => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 429);
    assert.equal(error.retryAfter, 60);
    assert.match(error.message, /correlation-id/);
    assert.ok(!error.message.includes('private-token'));
    return true;
  });
});
