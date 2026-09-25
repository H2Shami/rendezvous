import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roomStatus } from '../src/cli/room-status.js';
import type { LocalRoom } from '../src/cli/config.js';

const room: LocalRoom = { session_id: '11111111-1111-4111-8111-111111111111',
  invite_url: 'https://relay.example/join/11111111-1111-4111-8111-111111111111#invite',
  owner_url: 'https://relay.example/#11111111-1111-4111-8111-111111111111.owner-secret', expires_at: '2000-01-01T00:00:00Z', room_file: '/unused' };

test('room refresh uses live status rather than stale timestamps, authenticates and never joins', async () => {
  const original = globalThis.fetch;
  try {
    for (const state of ['WAITING', 'ACTIVE', 'CLOSED', 'EXPIRED']) {
      globalThis.fetch = async (url, options) => {
        assert.equal(String(url), `https://relay.example/api/v1/sessions/${room.session_id}`);
        assert.equal(options?.method, 'GET');
        assert.equal((options?.headers as Record<string, string>).authorization, 'Bearer owner-secret');
        return Response.json({ status: state, expires_at: '2099-01-01T00:00:00Z' });
      };
      const result = await roomStatus(room);
      assert.equal(result.state, state.toLowerCase());
      assert.equal(result.usable, ['WAITING', 'ACTIVE'].includes(state));
    }
    for (const [code, expected] of [[404, 'unavailable'], [410, 'expired'], [403, 'access denied'], [503, 'unverified']] as const) {
      globalThis.fetch = async () => new Response('', { status: code });
      assert.equal((await roomStatus(room)).state, expected);
    }
    globalThis.fetch = async () => { throw new Error('network down'); };
    assert.equal((await roomStatus(room)).state, 'unverified');
    assert.equal(room.expires_at, '2000-01-01T00:00:00Z', 'history is not rewritten or deleted');
  } finally { globalThis.fetch = original; }
});

test('room selection rechecks status after the list was loaded and blocks a newly closed room', { timeout: 5000 }, async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { RendezvousTui } = await import('../src/cli/tui-app.js');
  const { tuiActions } = await import('../src/cli/tui-actions.js');
  const home = await mkdtemp(join(tmpdir(), 'room-refresh-'));
  const previousHome = process.env.RENDEZVOUS_HOME, original = globalThis.fetch;
  let state = 'ACTIVE', calls = 0;
  const until = async (ready: () => boolean) => { for (let i = 0; !ready(); i++) { if (i > 200) throw new Error('Refresh did not complete'); await new Promise(resolve => setTimeout(resolve, 5)); } };
  try {
    process.env.RENDEZVOUS_HOME = home;
    await mkdir(join(home, 'created'));
    await writeFile(join(home, 'created', 'room.json'), JSON.stringify(room));
    globalThis.fetch = async () => { calls++; return Response.json({ status: state, expires_at: '2099-01-01T00:00:00Z' }); };
    const app = new RendezvousTui('unused');
    app.activate(tuiActions.find(action => action.id === 'join')!);
    await until(() => app.picker?.title === 'Choose a room · refreshed');
    const choice = app.picker!.rows.find(row => row.id)!;
    assert.equal(choice.disabled, false);
    state = 'CLOSED'; app.picker!.choose(choice);
    await until(() => !app.picker);
    assert.equal(calls, 2); assert.equal(app.form, undefined); assert.equal(app.jobs.length, 0);
    assert.match(app.notice, /closed/);
  } finally {
    globalThis.fetch = original;
    if (previousHome === undefined) delete process.env.RENDEZVOUS_HOME; else process.env.RENDEZVOUS_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
