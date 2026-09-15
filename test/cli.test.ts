import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './helpers.js';
import { HttpError, parseInvitation, RoomClient } from '../src/cli/client.js';
import { listen } from '../src/cli/bridge.js';
import { codexArguments, parseTurnResult } from '../src/cli/runtime.js';
import { loadState, lockState, saveState, type BridgeState } from '../src/cli/state.js';

test('invitation parsing requires a secret and HTTPS outside loopback', () => {
  const id = '00000000-0000-4000-8000-000000000000';
  assert.equal(parseInvitation(`http://localhost:3000/join/${id}#private`).secret, 'private');
  for (const value of [`http://example.com/join/${id}#private`, `https://example.com/join/${id}`,
    `https://user:pass@example.com/join/${id}#private`, `https://example.com/join/${id}?token=secret#private`]) {
    assert.throws(() => parseInvitation(value));
  }
});

test('Codex args target only the recorded session, with explicit sandbox and stdin', () => {
  const args = codexArguments('/tmp/schema.json', 'specific-thread');
  assert.deepEqual(args.slice(0, 7), ['exec', '--sandbox', 'read-only', '-c', 'approval_policy="never"', 'resume', 'specific-thread']);
  assert.equal(args.at(-1), '-'); assert.ok(!args.includes('--last'));
  assert.deepEqual(parseTurnResult('{"message":null,"status":"ACTIVE"}'), { message: null, status: 'ACTIVE' });
  for (const value of ['{}', '{"message":"","status":"ACTIVE"}', '{"message":42,"status":"DONE"}']) {
    assert.throws(() => parseTurnResult(value));
  }
});

test('state is private, atomically replaceable, and single-writer locked', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rendezvous-state-test-'));
  const path = join(directory, 'state.json');
  try {
    const release = await lockState(path);
    try {
      await assert.rejects(lockState(path));
      assert.equal(await loadState(path), undefined);
      const state: BridgeState = { version: 1, origin: 'http://localhost', roomId: 'room',
        participantId: 'me', token: 'private', workspace: directory, objective: 'task', cursor: 0, initialized: false };
      await saveState(path, state); state.cursor = 5; await saveState(path, state);
      assert.equal((await loadState(path))?.cursor, 5);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.ok((await readFile(path, 'utf8')).includes('private'));
    } finally { await release(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('HTTP room -> runtime -> reply -> idle -> resumed turn, without self-trigger or skipped raced messages', async () => {
  const f = await fixture();
  try {
    const room = await f.create();
    const joiner = new RoomClient(f.base, room.session_id);
    const membership = await joiner.join(room.invite_token, 'Bridge', new AbortController().signal);
    const client = new RoomClient(f.base, room.session_id, membership.participant_token);
    const state: BridgeState = { version: 1, origin: f.base, roomId: room.session_id,
      participantId: membership.participant_id, token: membership.participant_token,
      workspace: '/tmp', objective: 'Coordinate a meeting; never commit without approval.', cursor: 0, initialized: false };
    const signal = AbortSignal.timeout(5000);
    const calls: (string | undefined)[] = [];
    let writes = 0;
    await listen({ state, client, signal, save: async () => { writes++; }, log: () => {}, maxTurns: 3,
      runtime: { run: async (prompt, thread, _signal, onThread) => {
        calls.push(thread); assert.ok(!prompt.includes(membership.participant_token));
        await onThread('dedicated-thread');
        if (calls.length === 1) {
          // This message arrives during reasoning, before the bridge posts its reply.
          await f.service.send(room.session_id, room.owner_token, { content: 'What about Thursday?' });
          return { message: 'Hello from the bridge', status: 'ACTIVE' };
        }
        assert.ok(prompt.includes('What about Thursday?'));
        return { message: 'Need my user to approve Thursday.', status: 'NEEDS_USER' };
      } },
    });
    assert.deepEqual(calls, [undefined, 'dedicated-thread']);
    assert.equal(state.inFlight, false); assert.equal(state.cursor, 2); assert.ok(writes >= 6);
    const page = await client.read(0, 0, signal);
    assert.deepEqual(page.messages.map(m => m.content), ['What about Thursday?', 'Hello from the bridge', 'Need my user to approve Thursday.']);
    // A restarted listener skips the previously sent reply, then handles only new peer activity.
    await f.service.send(room.session_id, room.owner_token, { content: 'Please confirm.' });
    await listen({ state, client, signal, save: async () => {}, log: () => {}, maxTurns: 1,
      runtime: { run: async (prompt, thread) => {
        assert.equal(thread, 'dedicated-thread'); assert.ok(prompt.includes('Please confirm.'));
        return { message: null, status: 'NEEDS_USER' };
      } },
    });
    assert.equal(state.cursor, 4);
  } finally { await f.stop(); }
});

test('failed sends leave an uncertainty marker and cannot automatically replay', async () => {
  const state: BridgeState = { version: 1, origin: 'http://localhost', roomId: 'room', participantId: 'me',
    token: 'private', workspace: '/tmp', objective: 'task', cursor: 0, initialized: false };
  const client = new RoomClient(state.origin, state.roomId, state.token);
  client.read = async () => ({ messages: [], participants: [], cursor: 0, session_status: 'waiting' });
  client.send = async () => { throw new Error('response lost'); };
  const options = { state, client, signal: new AbortController().signal, save: async () => {}, log: () => {}, maxTurns: 1,
    runtime: { run: async () => ({ message: 'hello', status: 'ACTIVE' as const }) } };
  await assert.rejects(listen(options), /response lost/);
  assert.equal(state.inFlight, true); assert.equal(state.cursor, 0);
  await assert.rejects(listen(options), /Previous turn/);
});

test('closed room stops without invoking runtime', async () => {
  const state: BridgeState = { version: 1, origin: 'http://localhost', roomId: 'room', participantId: 'me',
    token: 'private', workspace: '/tmp', objective: 'task', cursor: 0, initialized: false };
  const client = new RoomClient(state.origin, state.roomId, state.token);
  client.read = async () => ({ messages: [], participants: [], cursor: 0, session_status: 'closed' });
  await listen({ state, client, signal: new AbortController().signal, save: async () => {}, log: () => {}, maxTurns: 1,
    runtime: { run: async () => { throw new Error('must not run'); } } });
});

test('idle polls and own messages do not trigger turns; membership changes do', async () => {
  const participants = [{ id: 'me', display_name: 'Me', left_at: null, revoked_at: null }];
  const state: BridgeState = { version: 1, origin: 'http://localhost', roomId: 'room', participantId: 'me',
    token: 'private', workspace: '/tmp', objective: 'task', cursor: 0, initialized: true, roster: JSON.stringify(participants) };
  const client = new RoomClient(state.origin, state.roomId, state.token);
  const cursors: number[] = [];
  client.read = async (cursor, wait) => {
    cursors.push(cursor); assert.equal(wait, 60);
    if (cursors.length === 1) return { messages: [], participants, cursor: 0, session_status: 'waiting' };
    if (cursors.length === 2) return { messages: [{ id: 'm', sequence: 1, sender_id: 'me', content: 'own', created_at: new Date() }],
      participants, cursor: 1, session_status: 'waiting' };
    return { messages: [], participants: [...participants, { id: 'peer', display_name: 'Peer', left_at: null, revoked_at: null }],
      cursor: 1, session_status: 'active' };
  };
  let turns = 0;
  await listen({ state, client, signal: AbortSignal.timeout(2000), save: async () => {}, log: () => {}, maxTurns: 1,
    runtime: { run: async () => { turns++; return { message: null, status: 'ACTIVE' }; } } });
  assert.deepEqual(cursors, [0, 0, 1]); assert.equal(turns, 1);
});

test('GET reconnect preserves the cursor and auth failure stops without a turn', async () => {
  const state: BridgeState = { version: 1, origin: 'http://localhost', roomId: 'room', participantId: 'me',
    token: 'private', workspace: '/tmp', objective: 'task', cursor: 7, initialized: true };
  const client = new RoomClient(state.origin, state.roomId, state.token);
  let reads = 0;
  client.read = async cursor => {
    assert.equal(cursor, 7); reads++;
    throw new HttpError(reads === 1 ? 503 : 403, 1);
  };
  await assert.rejects(listen({ state, client, signal: AbortSignal.timeout(3000), save: async () => {}, log: () => {}, maxTurns: 1,
    runtime: { run: async () => { throw new Error('must not run'); } } }), /HTTP 403/);
  assert.equal(reads, 2); assert.equal(state.cursor, 7);
});

test('disconnect aborts a pending real HTTP long poll', async () => {
  const f = await fixture();
  try {
    const room = await f.create();
    const joined = await f.service.join(room.session_id, { invite_token: room.invite_token }, 'local-test');
    const state: BridgeState = { version: 1, origin: f.base, roomId: room.session_id, participantId: joined.participant_id,
      token: joined.participant_token, workspace: '/tmp', objective: 'task', cursor: 0, initialized: true };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      await listen({ state, client: new RoomClient(f.base, room.session_id, state.token), signal: controller.signal,
        save: async () => {}, log: () => {}, maxTurns: 1,
        runtime: { run: async () => { throw new Error('must not run'); } } });
    } finally { clearTimeout(timer); }
    assert.equal(state.cursor, 0); assert.equal(state.inFlight, undefined);
  } finally { await f.stop(); }
});
