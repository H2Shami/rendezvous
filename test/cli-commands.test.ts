import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile, copyFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fixture } from './helpers.js';
import { OwnerService } from '../src/owners/service.js';
import { AgentClient } from '../src/client/index.js';
import { AgentIdentityService } from '../src/agents/identity.js';

function cli(args: string[], input?: string, env: NodeJS.ProcessEnv = {}) {
  return mkdtemp(join(tmpdir(), 'rendezvous-command-home-')).then(home => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
    const child = spawn(process.execPath, ['dist/cli/main.js', ...args], {
      env: { ...process.env, RENDEZVOUS_INVITATION_URL: '', RENDEZVOUS_URL: '', RENDEZVOUS_HOME: home, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', async code => { await rm(home, { recursive: true, force: true }); resolveResult({ code, stdout, stderr }); });
    child.stdin.end(input);
  }));
}

test('help is available without setup and overrides invalid options', async () => {
  for (const args of [[], ['-h'], ['help'], ['listen', '--bad-option', '-h'], ['help', 'create']]) {
    const result = await cli(args);
    assert.equal(result.code, 0); assert.match(result.stdout, /Usage:/); assert.equal(result.stderr, '');
  }
  assert.match((await cli(['help', 'create'])).stdout, /--participants/);
  assert.match((await cli(['listen', '--help'])).stdout, /--objective-file/);
  const version = await cli(['--version']);
  assert.equal(version.code, 0); assert.equal(version.stdout.trim(), '0.1.0');
});

test('invalid commands and flags fail with usage guidance and clean stdout', async () => {
  for (const args of [['lisetn'], ['listen', '--json'], ['rooms', '--state', 'x'],
    ['listen', '--max-turns', '0'], ['create'], ['create', '--server', 'http://example.com'], ['create', '--server', 'http://localhost', '--participants', '11']]) {
    const result = await cli(args);
    assert.equal(result.code, 2); assert.equal(result.stdout, '');
    assert.match(result.stderr, /--help/); assert.doesNotMatch(result.stderr, /\n\s+at /);
  }
});

test('create saves private credentials, supports JSON, and produces a usable invitation', async () => {
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), 'rendezvous-create-'));
  const output = join(directory, 'room.json');
  try {
    const result = await cli(['create', '--no-join', '--server', f.base, '--participants', '3', '--ttl', '600', '--output', output, '--json']);
    assert.equal(result.code, 0, result.stderr);
    const data = JSON.parse(result.stdout);
    assert.equal(data.room_file, output);
    assert.ok(data.invite_url.startsWith(f.base + '/join/'));
    const saved = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(saved.owner_url, data.owner_url);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    const invite = new URL(data.invite_url);
    await f.service.join(data.session_id, { invite_token: invite.hash.slice(1) }, 'test-first');
    await f.service.join(data.session_id, { invite_token: invite.hash.slice(1) }, 'test-second');
    await f.service.join(data.session_id, { invite_token: invite.hash.slice(1) }, 'test-third');
    await assert.rejects(f.service.join(data.session_id, { invite_token: invite.hash.slice(1) }, 'test-fourth'), { code: 'INVITE_EXHAUSTED' });
    assert.doesNotMatch(result.stderr, new RegExp(invite.hash.slice(1)));
    const previous = await readFile(output, 'utf8');
    const duplicate = await cli(['create', '--no-join', '--server', f.base, '--output', output]);
    assert.equal(duplicate.code, 1); assert.match(duplicate.stderr, /already exists/);
    assert.equal(await readFile(output, 'utf8'), previous);
  } finally { await f.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('create text output is just the invitation; quiet suppresses progress', async () => {
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), 'rendezvous-create-'));
  try {
    const result = await cli(['create', '--no-join', '--output', join(directory, 'room.json'), '-q'], undefined, { RENDEZVOUS_URL: f.base });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /^http:\/\/127\.0\.0\.1:\d+\/join\/[^\n]+\n$/);
  } finally { await f.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('listen validates piped instructions before joining or running Codex', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rendezvous-input-'));
  try {
    const roomFile = join(directory, 'room.json');
    await writeFile(roomFile, JSON.stringify({ invite_url: 'http://localhost:1/join/00000000-0000-4000-8000-000000000000#secret' }));
    const result = await cli(['listen', '--room-file', roomFile, '--state', join(directory, 'state.json'),
      '--workspace', resolve('.'), '--objective-file', '-'], '');
    assert.equal(result.code, 2); assert.match(result.stderr, /task\/boundaries/);
    assert.equal(result.stdout, '');
    const large = await cli(['listen', '--room-file', roomFile, '--state', join(directory, 'state.json'),
      '--objective-file', '-'], 'x'.repeat(32769));
    assert.equal(large.code, 2); assert.match(large.stderr, /exceeds/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('created room file feeds a listener and resumes the saved conversation', {
  skip: process.platform === 'win32', timeout: 10000,
}, async () => {
  const f = await fixture({ publicUrl: 'https://internal.example.com' });
  const directory = await mkdtemp(join(tmpdir(), 'rendezvous-flow-'));
  try {
    const roomFile = join(directory, 'room.json');
    const stateFile = join(directory, 'state.json');
    const fake = join(directory, 'codex');
    await copyFile(new URL('./fixtures/codex-fake.mjs', import.meta.url), fake);
    await chmod(fake, 0o700);
    const created = await cli(['create', '--no-join', '--server', f.base, '--output', roomFile, '--json']);
    assert.equal(created.code, 0, created.stderr);
    assert.ok(JSON.parse(created.stdout).invite_url.startsWith(f.base));
    const args = ['listen', '--state', stateFile, '--objective-file', '-', '--max-turns', '1'];
    const env = { PATH: `${directory}:${process.env.PATH}` };
    const first = await cli([...args, '--room-file', roomFile, '--workspace', directory], 'Introduce yourself.', env);
    assert.equal(first.code, 0, first.stderr); assert.equal(first.stdout, '');
    assert.match(first.stderr, /Resume: rendezvous join --state/);
    const saved = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(saved.objective, 'Introduce yourself.'); assert.equal(saved.threadId, 'fixture-thread');
    const second = await cli(args, 'Updated local instructions.', env);
    assert.equal(second.code, 0, second.stderr); assert.match(second.stderr, /resumed Codex turn/);
    const resumed = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(resumed.participantId, saved.participantId);
    assert.equal(resumed.objective, 'Updated local instructions.');
    const room = JSON.parse(created.stdout);
    await f.service.close(room.session_id, new URL(room.owner_url).hash.slice(room.session_id.length + 2));
    const closed = await cli(args, 'Do not run this.', env);
    assert.equal(closed.code, 2); assert.match(closed.stderr, /room is closed/);
    assert.doesNotMatch(closed.stderr, /Joined room|Starting .*turn/);
    await f.db.query('DELETE FROM sessions WHERE id=$1', [room.session_id]);
    const missing = await cli(args, 'Do not run this.', env);
    assert.equal(missing.code, 2); assert.match(missing.stderr, /no longer available/);
    assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')), resumed);
  } finally { await f.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('config persists agent/server defaults and rejects invalid agent names', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rendezvous-config-'));
  const env = { RENDEZVOUS_HOME: home };
  try {
    assert.equal((await cli(['config', 'agent', 'claude'], undefined, env)).code, 0);
    assert.equal((await cli(['config', 'server', 'http://localhost:4372'], undefined, env)).code, 0);
    const shown = await cli(['config', 'show', '--json'], undefined, env);
    assert.deepEqual(JSON.parse(shown.stdout), { agent: 'claude', server: 'http://localhost:4372' });
    assert.equal((await stat(join(home, 'config.json'))).mode & 0o777, 0o600);
    const invalid = await cli(['config', 'agent', 'unknown'], undefined, env);
    assert.equal(invalid.code, 2); assert.match(invalid.stderr, /codex, claude, cursor, opencode/);
    assert.equal(JSON.parse((await cli(['config', 'show', '--json'], undefined, env)).stdout).agent, 'claude');
    const empty = await cli(['config', 'show', '--json']);
    assert.equal(JSON.parse(empty.stdout).server, 'https://dev.userendezvous.com');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('create auto-joins with configured agent, session and server; rooms lists owned rooms without credentials', {
  skip: process.platform === 'win32', timeout: 15000,
}, async () => {
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), 'rendezvous-auto-'));
  const env = { RENDEZVOUS_HOME: join(directory, 'home'), PATH: `${directory}:${process.env.PATH}`, FIXTURE_LOG: join(directory, 'calls.jsonl') };
  try {
    for (const agent of ['codex', 'claude', 'agent', 'opencode']) {
      await copyFile(new URL('./fixtures/agent-fake.mjs', import.meta.url), join(directory, agent));
      await chmod(join(directory, agent), 0o700);
    }
    await cli(['config', 'agent', 'claude'], undefined, env);
    await cli(['config', 'server', f.base], undefined, env);
    const created = await cli(['create', '--session', 'existing-session', '--max-turns', '1', '--json', '--workspace', directory], undefined, env);
    assert.equal(created.code, 0, created.stderr);
    const room = JSON.parse(created.stdout);
    assert.match(created.stderr, /Joining with Claude Code/);
    assert.match(created.stderr, /resumed Claude Code turn/);
    const rows = await cli(['rooms', '--json'], undefined, env);
    assert.equal(rows.code, 0, rows.stderr);
    assert.equal(JSON.parse(rows.stdout)[0].room, room.session_id);
    assert.ok(!rows.stdout.includes(new URL(room.invite_url).hash.slice(1)));
    assert.ok(!rows.stdout.includes(new URL(room.owner_url).hash.slice(1)));
    await cli(['config', 'agent', 'codex'], undefined, env);
    const resumed = await cli(['join', room.session_id, '--task', 'Follow up', '--max-turns', '1'], undefined, env);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.match(resumed.stderr, /resumed Claude Code turn/);
    const wrong = await cli(['join', room.session_id, '--session', 'different-session', '--task', 'Follow up'], undefined, env);
    assert.equal(wrong.code, 2); assert.match(wrong.stderr, /bound to another agent session/);
    const calls = (await readFile(env.FIXTURE_LOG, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.args.includes('existing-session')));
    assert.ok(calls.every(call => !call.prompt.includes(new URL(room.invite_url).hash.slice(1))));
    const override = await cli(['create', '--agent', 'opencode', '--task', 'Coordinate', '--workspace', directory, '--max-turns', '1', '--json'], undefined, env);
    assert.equal(override.code, 0, override.stderr); assert.match(override.stderr, /OpenCode turn/);
    assert.equal(JSON.parse((await cli(['config', 'show', '--json'], undefined, env)).stdout).agent, 'codex');
  } finally { await f.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('join accepts URL or room/token and supports per-command agent selection', {
  skip: process.platform === 'win32', timeout: 15000,
}, async () => {
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), 'rendezvous-join-'));
  const env = { RENDEZVOUS_HOME: join(directory, 'home'), PATH: `${directory}:${process.env.PATH}` };
  try {
    await copyFile(new URL('./fixtures/agent-fake.mjs', import.meta.url), join(directory, 'agent'));
    await chmod(join(directory, 'agent'), 0o700);
    const room = await f.create();
    const first = await cli(['join', `${f.base}/join/${room.session_id}#${room.invite_token}`, '--agent', 'cursor', '--task', 'Review',
      '--workspace', directory, '--max-turns', '1'], undefined, env);
    assert.equal(first.code, 0, first.stderr); assert.match(first.stderr, /Cursor turn/);
    const second = await cli(['join', '--room', room.session_id, '--token', room.invite_token, '--server', f.base,
      '--agent', 'cursor', '--task', 'Review', '--state', join(directory, 'second.json'), '--workspace', directory, '--max-turns', '1'], undefined, env);
    assert.equal(second.code, 0, second.stderr);
    const rows = await cli(['rooms', '--json'], undefined, env);
    assert.deepEqual(JSON.parse(rows.stdout), []);
    const missing = await cli(['join', '--no-input'], undefined, env);
    assert.equal(missing.code, 2); assert.match(missing.stderr, /Invitation URL or room ID/);
  } finally { await f.stop(); await rm(directory, { recursive: true, force: true }); }
});

function terminal(command: string[], steps: { wait: string; send: string; screen?: boolean; signal?: 'SIGINT' }[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number; stdout: string; transcript: string }>((resolveResult, reject) => {
    const child = spawn('python3', ['test/fixtures/cli-prompt.py'], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => { if (code !== 0) reject(new Error(stderr)); else { try { resolveResult(JSON.parse(stdout)); } catch (e) { reject(e); } } });
    child.stdin.end(JSON.stringify({ command, steps }));
  });
}

test('full terminal app runs setup with hidden IPC input and a second command', { skip: process.platform === 'win32', timeout: 25000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'rendezvous-workspace-'));
  const apiKey = `agk_${randomUUID()}.${randomBytes(32).toString('base64url')}`;
  try {
    const result = await terminal([process.execPath, 'dist/cli/main.js'], [
      { wait: 'Good work happens', send: '/run any\r', screen: true },
      { wait: 'Command, without', send: `agent setup workspace-test --agent-id ${randomUUID()} --task "Review tests"\r`, screen: true },
      { wait: 'Agent API key', send: apiKey + '\r', screen: true },
      { wait: 'Saved agent profile workspace-test', send: '\x10show configuration\r', screen: true },
      { wait: 'Agent: codex', send: '\x03', screen: true },
    ], { RENDEZVOUS_HOME: home, RENDEZVOUS_AGENT_API_KEY: '', TERM: 'xterm-256color', NO_COLOR: '1' });
    assert.equal(result.code, 130, result.transcript);
    assert.equal(await readFile(join(home, 'agents', 'workspace-test', 'credential'), 'utf8'), apiKey + '\n');
    assert.ok(!result.transcript.includes(apiKey));
    assert.equal(result.stdout, '');
    assert.ok(result.transcript.includes('\x1b[?1049l'));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('agent setup hides its API key in the terminal and saves it privately', {
  skip: process.platform === 'win32', timeout: 10000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'rendezvous-profile-prompt-'));
  const apiKey = `agk_${randomUUID()}.${randomBytes(32).toString('base64url')}`;
  try {
    const result = await terminal([process.execPath, 'dist/cli/main.js', 'agent', 'setup', 'reviewer',
      '--agent-id', randomUUID(), '--task', 'Review inbound work'], [{ wait: 'Agent API key:', send: apiKey + '\n' }],
      { RENDEZVOUS_HOME: home, RENDEZVOUS_AGENT_API_KEY: '', RENDEZVOUS_URL: '' });
    assert.equal(result.code, 0, result.transcript);
    assert.ok(!(result.transcript + result.stdout).includes(apiKey));
    assert.equal(await readFile(join(home, 'agents', 'reviewer', 'credential'), 'utf8'), apiKey + '\n');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('interactive join prompts for room, hides token, asks task, and joins; config prompts for agent', {
  skip: process.platform === 'win32', timeout: 20000,
}, async () => {
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), 'rendezvous-prompts-'));
  const env = { RENDEZVOUS_HOME: join(directory, 'home'), RENDEZVOUS_URL: f.base,
    RENDEZVOUS_INVITATION_URL: '', RENDEZVOUS_TOKEN: '', PATH: `${directory}:${process.env.PATH}` };
  try {
    await copyFile(new URL('./fixtures/agent-fake.mjs', import.meta.url), join(directory, 'codex'));
    await chmod(join(directory, 'codex'), 0o700);
    const room = await f.create();
    const result = await terminal([process.execPath, 'dist/cli/main.js', 'join', '--workspace', directory, '--max-turns', '1'], [
      { wait: 'Invitation URL or room ID:', send: room.session_id + '\n' },
      { wait: 'Invitation token:', send: room.invite_token + '\n' },
      { wait: 'What should your agent work on?:', send: 'Coordinate a review\n' },
    ], env);
    assert.equal(result.code, 0, result.transcript);
    assert.match(result.transcript, /Joined room/);
    assert.ok(!result.transcript.includes(room.invite_token));
    const config = await terminal([process.execPath, 'dist/cli/main.js', 'config'], [{ wait: '[codex]:', send: 'claude\n' }], env);
    assert.equal(config.code, 0, config.transcript);
    assert.equal(JSON.parse(await readFile(join(env.RENDEZVOUS_HOME, 'config.json'), 'utf8')).agent, 'claude');
    const cancelled = await terminal([process.execPath, 'dist/cli/main.js', 'join'], [{ wait: 'Invitation URL or room ID:', send: '\x03' }], env);
    assert.equal(cancelled.code, 130);
  } finally { await f.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('owner command recovers the printed creation link without revealing it in rooms output', async () => {
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), 'rendezvous-owner-'));
  const env = { RENDEZVOUS_HOME: directory };
  try {
    const created = await cli(['create', '--no-join', '--server', f.base, '--json'], undefined, env);
    assert.equal(created.code, 0, created.stderr);
    const room = JSON.parse(created.stdout);
    assert.ok(created.stderr.includes(`Owner: ${room.owner_url}`));
    const owner = await cli(['owner', room.session_id], undefined, env);
    assert.equal(owner.code, 0, owner.stderr);
    assert.equal(owner.stdout.trim(), room.owner_url);
    const fromFile = await cli(['owner', '--room-file', room.room_file, '--json'], undefined, env);
    assert.deepEqual(JSON.parse(fromFile.stdout), { owner_url: room.owner_url });
    const rows = await cli(['rooms', '--json'], undefined, env);
    assert.ok(!rows.stdout.includes(room.owner_url));
  } finally { await f.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('agent TUI and explicit plain mode both disconnect cleanly in a real terminal', { skip: process.platform === 'win32', timeout: 20000 }, async () => {
  const f = await fixture(), home = await mkdtemp(join(tmpdir(), 'rendezvous-tui-cli-'));
  const issuer = `https://${randomUUID()}.example`;
  const owner = await new OwnerService(f.db, f.auth, f.now).establish(issuer, 'tui');
  const identity = new AgentIdentityService(f.db, f.auth, f.now);
  const agent = await identity.create(owner.id, { display_name: 'TUI test' });
  const key = await identity.issueKey(owner.id, agent.id);
  const friend = await identity.create(owner.id, { display_name: 'Known Friend' });
  const friendKey = await identity.issueKey(owner.id, friend.id);
  for (const [left, right] of [[agent, friend], [friend, agent]]) await f.app.policies.put(owner.id, left.id, right.id, { allow_inbound: true, allow_outbound: true });
  const peer = new AgentClient({ serverUrl: f.base, apiKey: friendKey.api_key });
  const env = { RENDEZVOUS_HOME: home, RENDEZVOUS_AGENT_API_KEY: key.api_key, PATH: `${home}:${process.env.PATH}`, TERM: 'xterm-256color' };
  try {
    await copyFile(new URL('./fixtures/agent-fake.mjs', import.meta.url), join(home, 'codex')); await chmod(join(home, 'codex'), 0o700);
    const setup = await cli(['agent', 'setup', 'tui', '--agent-id', agent.id, '--server', f.base, '--task', 'Test', '--no-input'], undefined, env);
    assert.equal(setup.code, 0, setup.stderr);
    await peer.connect();
    const offered = peer.offers();
    const accepted = offered.next().then(async result => { await result.value!.accept(); return result.value!; });
    for (const plain of [false, true]) {
      const result = await terminal([process.execPath, 'dist/cli/main.js', 'agent', 'start', 'tui', ...(plain ? ['--no-tui'] : [])],
        plain ? [{ wait: 'connected; accepting sessions', send: '', screen: true, signal: 'SIGINT' }] : [
          { wait: 'Online', send: 'Hello privately\r', screen: true },
          { wait: 'fixture reply', send: '\x10contact an agent\r', screen: true },
          { wait: 'Known Friend', send: '\r', screen: true },
          { wait: 'Opening message', send: 'Hello from the friend picker\r', screen: true },
          { wait: 'Hello from the friend picker', send: '\x03', screen: true },
        ], env);
      assert.equal(result.code, 130, result.transcript);
      assert.equal(result.transcript.includes('\x1b[?1049h'), !plain);
      if (!plain) assert.ok(result.transcript.includes('\x1b[?1049l'));
      assert.ok(!result.transcript.includes(key.api_key));
      assert.equal(await f.app.receivers.presence(agent.id), 'offline');
      if (!plain) {
        const session = await accepted; await offered.return(undefined);
        const page = await f.app.agentSessions.ownerMessages(owner.id, session.id, 0, 0);
        assert.ok(page.messages.some(message => message.content === 'Hello from the friend picker'));
        assert.ok(page.messages.every(message => !message.content.includes('Hello privately')));
      }
    }
  } finally {
    await peer.disconnect();
    await f.db.query('DELETE FROM sessions WHERE id IN (SELECT id FROM agent_sessions WHERE initiator_agent_id=$1)', [agent.id]);
    for (const table of ['agent_receivers', 'agent_connections', 'agent_credentials']) await f.db.query(`DELETE FROM ${table} WHERE agent_id=$1`, [friend.id]);
    await f.db.query('DELETE FROM agents WHERE id=$1', [friend.id]);
    for (const table of ['agent_receivers', 'agent_connections', 'agent_credentials']) await f.db.query(`DELETE FROM ${table} WHERE agent_id=$1`, [agent.id]);
    await f.db.query('DELETE FROM agents WHERE id=$1', [agent.id]); await f.db.query('DELETE FROM owners WHERE id=$1', [owner.id]);
    await f.stop(); await rm(home, { recursive: true, force: true });
  }
});
