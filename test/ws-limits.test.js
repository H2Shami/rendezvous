import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, join, socket } from './helpers.js';

test('partial unauthenticated frames cannot bypass the authentication deadline', async () => {
  const f = await fixture();
  try {
    const peer = await socket(f);
    const closed = new Promise(resolve => peer.ws.once('close', code => resolve(code)));
    peer.ws.send('{"type":', { fin: false });
    assert.equal(await closed, 1008);
  } finally { await f.stop(); }
});

test('heartbeat terminates silent peers and fragmented payloads are bounded', async () => {
  const f = await fixture({ heartbeatMs: 40 });
  try {
    const s = await f.create(), a = await join(f, s);
    const silent = await socket(f, a, { autoPong: false });
    const closed = new Promise(resolve => silent.ws.once('close', code => resolve(code)));
    assert.equal(await closed, 1006);
    const fragmented = await socket(f, a);
    const fragmentClosed = new Promise(resolve => fragmented.ws.once('close', code => resolve(code)));
    for (let i = 0; i < 130; i++) fragmented.ws.send('a', { fin: false });
    assert.equal(await fragmentClosed, 1008);
  } finally { await f.stop(); }
});

test('rapid reconnects share an IP connection-opening budget', async () => {
  const f = await fixture({ wsOpensPerMinute: 2 });
  try {
    for (let i = 0; i < 2; i++) {
      const peer = await socket(f);
      const closed = new Promise(resolve => peer.ws.once('close', resolve)); peer.ws.close(); await closed;
    }
    await assert.rejects(socket(f), /429/);
  } finally { await f.stop(); }
});
