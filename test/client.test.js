import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as pathJoin, resolve } from 'node:path';
import { fixture } from './helpers.js';
import { Agent, readState } from '../client/agent.js';
import { contextId, defaultState } from '../client/context.js';

const exec = promisify(execFile), cli = resolve('client/cli.js');
let f, dir;
before(async () => { f = await fixture(); dir = await mkdtemp(pathJoin(tmpdir(), 'rendezvous-client-')); });
after(async () => { await f.stop(); await rm(dir, { recursive: true, force: true }); });
const run = async (context, args) => (await exec(process.execPath, [cli, ...args], { cwd: dir,
  env: { ...process.env, CODEX_THREAD_ID: context }, timeout: 15000 })).stdout;
const location = s => `${f.base}/join/${s.session_id}#${s.invite_token}`;

test('two agent processes in one workspace get independent default identities and cursors', async () => {
  const s = await f.create();
  const a = await run('test-luna-a', ['connect', location(s)]);
  const b = await run('test-luna-b', ['connect', location(s)]);
  const aPath = a.match(/Private state: (.+)/)[1], bPath = b.match(/Private state: (.+)/)[1];
  assert.notEqual(aPath, bPath); assert.match(a, /JOINED, NOT LISTENING/);
  const [sa, sb] = await Promise.all([readState(aPath), readState(bPath)]);
  assert.notEqual(sa.participant_id, sb.participant_id); assert.notEqual(sa.public_key, sb.public_key);
  await assert.rejects(run('test-luna-b', ['read', '--state', aPath]), /STATE_CONTEXT_MISMATCH/);
  await assert.rejects(run('test-luna-b', ['connect', '--state', aPath, location(s)]), /STATE_CONTEXT_MISMATCH/);
  await run('test-luna-a', ['send', 'hello from a']);
  const received = await run('test-luna-b', ['wait', '--timeout', '2']);
  assert.match(received, /hello from a/); assert.match(received, /"status":"messages"/);
  assert.equal((await readState(aPath)).cursor, 0); assert.equal((await readState(bPath)).cursor, 1);
  const waiting = run('test-luna-a', ['wait', '--timeout', '3']);
  await new Promise(resolve => setTimeout(resolve, 150));
  await run('test-luna-b', ['send', 'reply from b']);
  const reply = await waiting;
  assert.match(reply, /reply from b/); assert.doesNotMatch(reply, /hello from a/);
  assert.equal((await f.service.inspect(s.session_id, sa.credential)).participants.length, 2);
});

test('wait distinguishes idle timeout and room close from arriving peer messages', async () => {
  const s = await f.create();
  const agent = await Agent.connect(location(s), pathJoin(dir, 'wait.json'));
  await agent.send({ text: 'own echo' });
  const seen = [];
  assert.equal((await agent.wait({ timeoutSeconds: 1, pollMs: 30, onMessage: row => seen.push(row) })).status, 'timeout');
  assert.equal(seen.length, 0);
  await f.service.close(s.session_id, s.owner_token);
  assert.equal((await agent.wait({ timeoutSeconds: 1 })).status, 'closed');
  const controller = new AbortController(); controller.abort();
  assert.equal((await agent.wait({ signal: controller.signal })).status, 'cancelled');
});

test('context-free join paths are fresh and ambiguous state reuse requires deliberate adoption', async () => {
  assert.notEqual(defaultState('connect', {}), defaultState('connect', {}));
  assert.throws(() => defaultState('read', {}), /Provide --state/);
  assert.notEqual(contextId({ TMUX: 'server', TMUX_PANE: '%1' }), contextId({ TMUX: 'server', TMUX_PANE: '%2' }));
  const s = await f.create(), path = pathJoin(dir, 'legacy.json');
  const a = await Agent.connect(location(s), path, 'one', { context: null });
  await assert.rejects(Agent.connect(location(s), path, 'two', { context: 'different' }), /STATE_ALREADY_JOINED/);
  await assert.rejects(Agent.load(path, { context: 'different' }), /STATE_ALREADY_JOINED/);
  const adopted = await Agent.load(path, { context: 'different', adopt: true });
  assert.equal(adopted.state.participant_id, a.state.participant_id);
  await assert.rejects(Agent.load(path, { context: 'third' }), /STATE_CONTEXT_MISMATCH/);
});
