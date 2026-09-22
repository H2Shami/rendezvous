import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentClient, AGENT_FRIENDS_PROTOCOL as protocol } from '../src/client/index.js';
import { AgentIdentityService } from '../src/agents/identity.js';
import { OwnerService } from '../src/owners/service.js';
import { AgentJournal } from '../src/cli/agent-journal.js';
import { fixture, waitUntil } from './helpers.js';
import { uuid, secret } from '../src/validation.js';

const entry = process.env.RENDEZVOUS_TEST_CLI_ENTRY || 'dist/cli/main.js';
function command(home: string, args: string[], key = '') {
  const child = spawn(process.execPath, [entry, 'agent', ...args], {
    env: { ...process.env, RENDEZVOUS_HOME: home, RENDEZVOUS_URL: '', RENDEZVOUS_AGENT_API_KEY: key },
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
  const result = await command(home, ['setup', name, '--agent-id', id, '--server', origin, '--task', 'Test listener', '--no-input'], key).done;
  assert.equal(result.code, 0, result.stderr);
}
async function running(process: ReturnType<typeof command>) {
  await waitUntil(() => process.output().includes('connected; sessions paused') || process.child.exitCode !== null, 5000);
  assert.match(process.output(), /connected; sessions paused/);
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
    assert.equal(status.code, 0, status.stderr); assert.equal(JSON.parse(status.stdout).availability, 'paused');
    assert.equal(await readFile(path, 'utf8'), JSON.stringify(before) + '\n');
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
    await new Promise(resolve => setTimeout(resolve, 11000)); // The server advertises a ten-second heartbeat interval.
    assert.ok(processes.every(p => p.child.exitCode === null));
    const after = JSON.parse(await readFile(path, 'utf8'));
    assert.ok(Date.parse(after.connection.expiresAt) > Date.parse(before.connection.expiresAt));
    assert.equal(await f.app.receivers.presence(ids[1]), 'paused');
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
    assert.equal(await f.app.receivers.presence(agent.id), 'paused'); // Old cleanup cannot release the replacement.
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
    assert.equal(recovery.code, 1); assert.match(recovery.stderr, /cannot resume saved session work/);
    assert.equal(await readFile(path, 'utf8'), saved); assert.deepEqual(requests, []);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(home, { recursive: true, force: true }); }
});
