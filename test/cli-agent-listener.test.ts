import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentClient, AGENT_FRIENDS_PROTOCOL as protocol } from '../src/client/index.js';
import { AgentIdentityService } from '../src/agents/identity.js';
import { OwnerService } from '../src/owners/service.js';
import { AgentJournal } from '../src/cli/agent-journal.js';
import { converse } from '../src/cli/agent-conversations.js';
import { fixture, waitUntil } from './helpers.js';
import { uuid, secret } from '../src/validation.js';

const entry = process.env.RENDEZVOUS_TEST_CLI_ENTRY || 'dist/cli/main.js';
function command(home: string, args: string[], key = '') {
  const child = spawn(process.execPath, [entry, 'agent', ...args], {
    env: { ...process.env, PATH: `${join(home, 'bin')}:${process.env.PATH}`, FIXTURE_LOG: join(home, 'turns.jsonl'),
      RENDEZVOUS_HOME: home, RENDEZVOUS_URL: '', RENDEZVOUS_AGENT_API_KEY: key },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
  return { child, done, output: () => stderr, async stop() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); return done; } };
}
async function setup(home: string, name: string, id: string, origin: string, key: string) {
  await mkdir(join(home, 'bin'), { recursive: true });
  await copyFile(new URL('./fixtures/conversation-fake.mjs', import.meta.url), join(home, 'bin', 'codex'));
  await chmod(join(home, 'bin', 'codex'), 0o700);
  const result = await command(home, ['setup', name, '--agent-id', id, '--server', origin, '--task', 'Test listener', '--no-input'], key).done;
  assert.equal(result.code, 0, result.stderr);
}
async function running(process: ReturnType<typeof command>) {
  await waitUntil(() => process.output().includes('connected; accepting sessions') || process.child.exitCode !== null, 5000);
  assert.match(process.output(), /connected; accepting sessions/);
}

test('two CLI profiles stay online, status is read-only, local lock holds, and shutdown releases leases', { timeout: 25000 }, async () => {
  const f = await fixture(), home = await mkdtemp(join(tmpdir(), 'rendezvous-listeners-'));
  const owner = await new OwnerService(f.db, f.auth, f.now).establish(`https://${uuid()}.example`, 'cli');
  const identities = new AgentIdentityService(f.db, f.auth, f.now);
  const ids: string[] = [], processes: ReturnType<typeof command>[] = [];
  try {
    for (const name of ['reviewer', 'writer']) {
      const agent = await identities.create(owner.id, { display_name: name }); ids.push(agent.id);
      const key = await identities.issueKey(owner.id, agent.id);
      await setup(home, name, agent.id, f.base, key.api_key);
      const process = command(home, ['start', name]); processes.push(process); await running(process);
      assert.ok(!process.output().includes(key.api_key));
    }
    const path = join(home, 'agents', 'reviewer', 'journal.json');
    const before = JSON.parse(await readFile(path, 'utf8'));
    const duplicate = await command(home, ['start', 'reviewer', '--takeover']).done;
    assert.equal(duplicate.code, 1); assert.match(duplicate.stderr, /already running locally/);
    const status = await command(home, ['status', 'reviewer', '--json']).done;
    assert.equal(status.code, 0, status.stderr); assert.equal(JSON.parse(status.stdout).availability, 'available');
    assert.equal(await readFile(path, 'utf8'), JSON.stringify(before) + '\n');
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
    await new Promise(resolve => setTimeout(resolve, 11000)); // The server advertises a ten-second heartbeat interval.
    assert.ok(processes.every(p => p.child.exitCode === null));
    const after = JSON.parse(await readFile(path, 'utf8'));
    assert.ok(Date.parse(after.connection.expiresAt) > Date.parse(before.connection.expiresAt));
    assert.equal(await f.app.receivers.presence(ids[1]), 'available');
    assert.equal((await processes[0].stop()).code, 130);
    assert.equal(await f.app.receivers.presence(ids[0]), 'offline');
    assert.equal(JSON.parse(await readFile(path, 'utf8')).connection, undefined);
    const restarted = command(home, ['start', 'reviewer']); processes.push(restarted); await running(restarted);
    assert.notEqual(JSON.parse(await readFile(path, 'utf8')).connection.id, before.connection.id);
  } finally {
    await Promise.all(processes.map(p => p.stop()));
    for (const table of ['agent_receivers', 'agent_connections', 'agent_credentials'])
      for (const id of ids) await f.db.query(`DELETE FROM ${table} WHERE agent_id=$1`, [id]);
    await f.db.query('DELETE FROM agents WHERE owner_id=$1', [owner.id]);
    await f.db.query('DELETE FROM owners WHERE id=$1', [owner.id]);
    await f.stop(); await rm(home, { recursive: true, force: true });
  }
});

test('CLI recovers a persisted live lease; a separate profile conflicts until explicit takeover', { timeout: 15000 }, async () => {
  const f = await fixture(), home = await mkdtemp(join(tmpdir(), 'rendezvous-recovery-'));
  const owner = await new OwnerService(f.db, f.auth, f.now).establish(`https://${uuid()}.example`, 'cli');
  const identities = new AgentIdentityService(f.db, f.auth, f.now);
  const agent = await identities.create(owner.id, { display_name: 'A' }), key = await identities.issueKey(owner.id, agent.id);
  const processes: ReturnType<typeof command>[] = [];
  const crash = new AbortController();
  try {
    await setup(home, 'original', agent.id, f.base, key.api_key);
    await setup(home, 'replacement', agent.id, f.base, key.api_key);
    const journal = new AgentJournal(join(home, 'agents', 'original', 'journal.json'));
    const previous = new AgentClient({ serverUrl: f.base, apiKey: key.api_key, journal });
    await previous.connect({ signal: crash.signal });
    const receiver = previous.receiver;
    crash.abort(); // Simulate stopped local work with an unreleased server lease.
    const resumed = command(home, ['start', 'original']); processes.push(resumed); await running(resumed);
    assert.deepEqual((await journal.load())!.connection!.receiver, receiver);
    const conflict = await command(home, ['start', 'replacement']).done;
    assert.equal(conflict.code, 1); assert.match(conflict.stderr, /already connected elsewhere/);
    const replacement = command(home, ['start', 'replacement', '--takeover']); processes.push(replacement); await running(replacement);
    await waitUntil(() => resumed.child.exitCode !== null, 12000);
    assert.match(resumed.output(), /listener was replaced/);
    assert.equal(await f.app.receivers.presence(agent.id), 'available'); // Old cleanup cannot release the replacement.
  } finally {
    crash.abort(); await Promise.all(processes.map(p => p.stop()));
    for (const table of ['agent_receivers', 'agent_connections', 'agent_credentials']) await f.db.query(`DELETE FROM ${table} WHERE agent_id=$1`, [agent.id]);
    await f.db.query('DELETE FROM agents WHERE owner_id=$1', [owner.id]); await f.db.query('DELETE FROM owners WHERE id=$1', [owner.id]);
    await f.stop(); await rm(home, { recursive: true, force: true });
  }
});

test('CLI compatibility, auth, identity and recovery failures never acquire a receiver or expose secrets', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rendezvous-compatibility-')), id = uuid(), key = `agk_${uuid()}.${secret()}`;
  let mode = 'version'; const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`); res.setHeader('Content-Type', 'application/json');
    res.statusCode = mode === 'auth' ? 401 : 200;
    res.end(JSON.stringify(mode === 'auth' ? { protocol, error: { code: 'UNAUTHORIZED', message: key }, request_id: uuid() } :
      { protocol: mode === 'version' ? 'agent-friends-http-v99' : protocol, agent: { id: mode === 'identity' ? uuid() : id, display_name: 'A' }, availability: 'offline', future_field: true }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await setup(home, 'reviewer', id, origin, key);
    const path = join(home, 'agents', 'reviewer', 'journal.json');
    const pinned = JSON.stringify({ version: 1, agentId: id, origin, sessions: {}, connection: {
      id: uuid(), credentialId: key.slice(4, 40), takeover: false, firstAttemptAt: Date.now(),
      receiver: { lease_id: uuid(), generation: '1' }, expiresAt: new Date(Date.now() + 30000).toISOString(), heartbeatSeconds: 10,
    } });
    await writeFile(path, pinned, { mode: 0o600 });
    for (const [value, message] of [['version', /protocols are incompatible/], ['auth', /authentication failed/], ['identity', /another agent/]] as const) {
      mode = value; requests.length = 0;
      const result = await command(home, ['start', 'reviewer']).done;
      assert.equal(result.code, 1); assert.match(result.stderr, message); assert.ok(!result.stderr.includes(key));
      assert.deepEqual(requests, ['GET /api/v1/agents/me']);
      assert.equal(await readFile(path, 'utf8'), pinned); // Even failure cleanup must not release a saved receiver.
    }
    mode = 'compatible';
    const status = await command(home, ['status', 'reviewer', '--json']).done;
    assert.equal(status.code, 0, status.stderr); assert.equal(JSON.parse(status.stdout).availability, 'offline');
    const saved = JSON.stringify({ version: 1, agentId: id, origin, sessions: { interrupted: { turn: { through: 1 } } } });
    await writeFile(path, saved, { mode: 0o600 }); requests.length = 0;
    const recovery = await command(home, ['start', 'reviewer']).done;
    assert.equal(recovery.code, 1); assert.match(recovery.stderr, /work was interrupted/);
    assert.equal(await readFile(path, 'utf8'), saved); assert.deepEqual(requests, []);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(home, { recursive: true, force: true }); }
});

async function conversationFixture() {
  const f = await fixture(), home = await mkdtemp(join(tmpdir(), 'rendezvous-conversations-'));
  const owner = await new OwnerService(f.db, f.auth, f.now).establish(`https://${uuid()}.example`, 'cli');
  const identities = new AgentIdentityService(f.db, f.auth, f.now);
  const a = await identities.create(owner.id, { display_name: 'A' }), b = await identities.create(owner.id, { display_name: 'B' });
  const ka = await identities.issueKey(owner.id, a.id), kb = await identities.issueKey(owner.id, b.id);
  for (const [left, right] of [[a, b], [b, a]]) await f.app.policies.put(owner.id, left.id, right.id, { allow_inbound: true, allow_outbound: true });
  await setup(home, 'sender', a.id, f.base, ka.api_key); await setup(home, 'receiver', b.id, f.base, kb.api_key);
  const processes: ReturnType<typeof command>[] = [];
  const client = new AgentClient({ serverUrl: f.base, apiKey: ka.api_key });
  const start = (name = 'receiver', flags: string[] = []) => { const p = command(home, ['start', name, ...flags]); processes.push(p); return p; };
  const turns = async (): Promise<{ thread?: string; prompt?: string; args?: string[]; stopped?: string }[]> => {
    try { return (await readFile(join(home, 'turns.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  };
  const openSession = async () => {
    const session = await client.open(b.id);
    await eventually(async () => (await session.status()).state === 'active').catch(error => {
      throw new Error(`${error.message}\n${processes.map(p => p.output()).join('\n')}`);
    });
    return session;
  };
  return { ...f, home, a, b, kb, owner, client, start, turns, openSession, async cleanup() {
    await Promise.all(processes.map(p => p.stop())); await client.disconnect();
    await f.db.query('DELETE FROM sessions WHERE id IN (SELECT id FROM agent_sessions WHERE initiator_agent_id IN ($1,$2))', [a.id, b.id]);
    for (const table of ['agent_receivers', 'agent_connections', 'agent_credentials']) await f.db.query(`DELETE FROM ${table} WHERE agent_id IN ($1,$2)`, [a.id, b.id]);
    await f.db.query('DELETE FROM agents WHERE owner_id=$1', [owner.id]); await f.db.query('DELETE FROM owners WHERE id=$1', [owner.id]);
    await f.stop(); await rm(home, { recursive: true, force: true });
  } };
}
async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 6000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('Expected conversation progress did not occur.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test('SDK messages and human messages resume one CLI conversation; DONE and remote close free the listener', { timeout: 20000 }, async () => {
  const f = await conversationFixture();
  try {
    const receiver = f.start(); await running(receiver); await f.client.connect();
    const session = await f.openSession();
    for (const text of ['one', 'two']) {
      await session.send(text);
      await eventually(async () => (await session.read({ wait: 0 })).messages.some(m => m.content === `reply:${text}`));
    }
    await f.app.agentSessions.ownerSend(f.owner.id, session.id, { content: 'human note' });
    await eventually(async () => (await session.read({ wait: 0 })).messages.some(m => m.content === 'reply:human note'));
    await session.send('finish');
    await eventually(async () => (await session.status()).state === 'closed'); await session.stopped();
    await waitUntil(() => receiver.output().includes(`Session ${session.id}: ended`), 5000);
    await eventually(async () => await f.app.receivers.presence(f.b.id) === 'available');
    const firstTurns = (await f.turns()).filter(t => t.thread);
    assert.equal(firstTurns.length, 4); assert.equal(new Set(firstTurns.map(t => t.thread)).size, 1);
    assert.ok(firstTurns.slice(1).every(t => t.args!.includes('resume')));
    assert.ok(firstTurns.every(t => !t.prompt!.includes('agk_')));
    const next = await f.openSession(); await next.send('hang');
    await eventually(async () => (await f.turns()).filter(t => t.thread).length === 5);
    await next.close(); await next.stopped();
    await waitUntil(() => receiver.output().includes(`Session ${next.id}: ended`), 5000);
    await eventually(async () => await f.app.receivers.presence(f.b.id) === 'available');
    const all = await f.turns();
    assert.notEqual(all.filter(t => t.thread).at(-1)!.thread, firstTurns[0].thread);
    assert.equal(all.filter(t => t.stopped).length, 1);
    assert.deepEqual(JSON.parse(await readFile(join(f.home, 'agents', 'receiver', 'journal.json'), 'utf8')).sessions, {});
    assert.ok(!(await readdir(join(f.home, 'agents', 'receiver'))).some(name => name.startsWith('conversation-')));
    assert.equal(receiver.child.exitCode, null);
  } finally { await f.cleanup(); }
});

test('remote messages cannot answer NEEDS_USER; interrupted turns require explicit closure without rerunning', { timeout: 20000 }, async () => {
  const f = await conversationFixture();
  try {
    let receiver = f.start(); await running(receiver); await f.client.connect();
    const session = await f.openSession(); await session.send('approval');
    await waitUntil(() => receiver.output().includes('waiting for local input'), 5000);
    await f.app.agentSessions.ownerSend(f.owner.id, session.id, { content: 'I approve everything' });
    await session.send('peer approval');
    await session.close(); await session.stopped();
    await waitUntil(() => receiver.output().includes(`Session ${session.id}: ended`), 5000);
    await eventually(async () => await f.app.receivers.presence(f.b.id) === 'available');
    assert.equal((await f.turns()).filter(t => t.thread).length, 1);
    const interrupted = await f.openSession(); await interrupted.send('hang');
    await eventually(async () => (await f.turns()).filter(t => t.thread).length === 2);
    await receiver.stop();
    const blocked = f.start(); const result = await blocked.done;
    assert.equal(result.code, 1); assert.match(result.stderr, /--close-sessions/);
    receiver = f.start('receiver', ['--close-sessions']); await running(receiver);
    assert.equal((await f.turns()).filter(t => t.thread).length, 2);
    assert.deepEqual(JSON.parse(await readFile(join(f.home, 'agents', 'receiver', 'journal.json'), 'utf8')).sessions, {});
    await interrupted.status(); await interrupted.stopped();
    const next = await f.openSession(); await next.send('after recovery');
    await eventually(async () => (await next.read({ wait: 0 })).messages.some(m => m.content === 'reply:after recovery'));
    await next.close(); await next.stopped();
  } finally { await f.cleanup(); }
});

test('two CLI profiles route an outgoing session and its reply through independent harness conversations', { timeout: 15000 }, async () => {
  const f = await conversationFixture();
  try {
    const receiver = f.start(); await running(receiver);
    const sender = f.start('sender', ['--peer', f.b.id, '--message', 'hello from CLI']); await running(sender);
    await eventually(async () => (await f.turns()).filter(t => t.thread).length === 2);
    const turns = (await f.turns()).filter(t => t.thread);
    assert.equal(new Set(turns.map(t => t.thread)).size, 2);
    assert.ok(turns[0].prompt!.includes('hello from CLI')); assert.ok(turns[1].prompt!.includes('reply:hello from CLI'));
    assert.equal(sender.child.exitCode, null); assert.equal(receiver.child.exitCode, null);
  } finally { await f.cleanup(); }
});

test('an idle crash restores the saved conversation and cursor without repeating the previous turn', { timeout: 25000 }, async () => {
  const f = await conversationFixture();
  try {
    const receiver = f.start(); await running(receiver); await f.client.connect();
    const session = await f.openSession(); await session.send('before crash');
    await eventually(async () => (await session.read({ wait: 0 })).messages.some(m => m.content === 'reply:before crash'));
    const path = join(f.home, 'agents', 'receiver', 'journal.json');
    await eventually(async () => !JSON.parse(await readFile(path, 'utf8')).sessions[session.id].turn);
    receiver.child.kill('SIGKILL'); await receiver.done;
    await new Promise(resolve => setTimeout(resolve, 11000)); // Let the dead process's lock expire.
    const resumed = f.start(); await running(resumed);
    await session.send('after crash');
    await eventually(async () => (await session.read({ wait: 0 })).messages.some(m => m.content === 'reply:after crash'));
    const turns = (await f.turns()).filter(t => t.thread);
    assert.equal(turns.length, 2); assert.equal(turns[0].thread, turns[1].thread);
    assert.ok(turns[1].args!.includes('resume'));
    assert.ok(!turns[1].prompt!.includes('before crash'));
    await session.close(); await session.stopped();
  } finally { await f.cleanup(); }
});

test('local NEEDS_USER input resumes the same conversation and sends the approved reply', { timeout: 10000 }, async () => {
  const f = await conversationFixture();
  const receiver = new AgentClient({ serverUrl: f.base, apiKey: f.kb.api_key });
  let task: Promise<void> | undefined;
  try {
    await receiver.connect(); await f.client.connect();
    const outgoing = await f.client.open(f.b.id), offers = receiver.offers();
    const incoming = (await offers.next()).value!; await offers.return(undefined);
    let turns = 0, questions = 0;
    task = converse({ client: receiver, directory: join(f.home, 'agents', 'receiver'),
      profile: { version: 1, name: 'receiver', agentId: f.b.id, origin: f.base, agent: 'codex', workspace: f.home, instructions: 'Local boundaries', credentialFile: 'credential' },
      log() {}, async askUser(id, question) { assert.equal(id, incoming.id); assert.equal(question, 'Which scope?'); questions++; return 'Only the API'; },
      runtime: { async run(prompt, thread, _signal, onThread) {
        turns++;
        if (turns === 1) { assert.equal(thread, undefined); await onThread('local-thread'); return { message: 'Which scope?', status: 'NEEDS_USER' }; }
        assert.equal(thread, 'local-thread'); assert.ok(prompt.includes('"Only the API"')); assert.ok(prompt.endsWith('[]'));
        return { message: 'Approved reply', status: 'DONE' };
      } },
    }, incoming);
    await eventually(async () => (await outgoing.status()).state === 'active'); await outgoing.send('Please review');
    await task; assert.equal(turns, 2); assert.equal(questions, 1);
    const page = await outgoing.read({ wait: 0 });
    assert.deepEqual(page.messages.map(m => m.content), ['Please review', 'Which scope?', 'Approved reply']);
    await outgoing.stopped();
  } finally { await receiver.disconnect(); await task?.catch(() => {}); await f.cleanup(); }
});
