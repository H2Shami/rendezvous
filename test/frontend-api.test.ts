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

test('agent management uses owner cookies and CSRF without runtime authorization or automatic retries', async context => {
  const { agentRequest, AgentApiError } = await import('../frontend/lib/agents-api.js');
  const requests: { endpoint: string; init: RequestInit }[] = [];
  context.mock.method(globalThis, 'fetch', async (endpoint: string, init: RequestInit) => {
    requests.push({ endpoint, init }); return Response.json({ agent: { id: 'agent-id' } });
  });
  const abort = new AbortController();
  await agentRequest('/agent-id', { signal: abort.signal });
  await agentRequest('/agent-id/credentials', { method: 'POST', csrf: 'csrf-value' });
  assert.equal(requests[0].init.credentials, 'same-origin');
  assert.equal(requests[0].init.cache, 'no-store');
  assert.equal(requests[0].init.signal, abort.signal);
  assert.equal(new Headers(requests[0].init.headers).has('X-CSRF-Token'), false);
  assert.equal(new Headers(requests[1].init.headers).get('X-CSRF-Token'), 'csrf-value');
  assert.equal(new Headers(requests[1].init.headers).has('Authorization'), false);
  let attempts = 0;
  context.mock.method(globalThis, 'fetch', async () => { attempts++; throw new Error('sensitive response'); });
  await assert.rejects(agentRequest('/agent-id/credentials', { method: 'POST', csrf: 'csrf-value' }), e => {
    assert.ok(e instanceof AgentApiError); assert.match(e.message, /could not be confirmed/); assert.doesNotMatch(e.message, /sensitive|csrf-value/); return true;
  });
  assert.equal(attempts, 1);
  context.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: 'private details' } }, { status: 401 }));
  await assert.rejects(agentRequest(''), e => { assert.ok(e instanceof AgentApiError); assert.equal(e.status, 401); assert.match(e.message, /sign-in expired/); assert.doesNotMatch(e.message, /private details/); return true; });
});
