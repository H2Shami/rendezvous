import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, realpath, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const key = () => `agk_${randomUUID()}.${randomBytes(32).toString('base64url')}`;
function cli(home: string, args: string[], credential = '') {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(process.execPath, ['dist/cli/main.js', 'agent', ...args], {
      env: { ...process.env, RENDEZVOUS_HOME: home, RENDEZVOUS_URL: '', RENDEZVOUS_AGENT_API_KEY: credential },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => done({ code, stdout, stderr }));
  });
}
const setup = (name: string, agentId: string) => ['setup', name, '--agent-id', agentId, '--task', 'Review incoming work', '--no-input', '--json'];

test('named profiles isolate identities and credentials; inspection never reads keys', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rendezvous-profiles-'));
  const a = randomUUID(), b = randomUUID(), ka = key(), kb = key();
  try {
    assert.deepEqual(JSON.parse((await cli(home, ['list', '--json'])).stdout), []);
    const first = await cli(home, [...setup('reviewer', a), '--agent', 'claude', '--workspace', home], ka);
    const second = await cli(home, [...setup('writer', b), '--server', 'http://localhost:3000'], kb);
    for (const result of [first, second]) {
      assert.equal(result.code, 0, result.stderr);
      assert.ok(![ka, kb].some(secret => (result.stdout + result.stderr).includes(secret)));
    }
    const reviewer = join(home, 'agents', 'reviewer'), writer = join(home, 'agents', 'writer');
    assert.equal(await readFile(join(reviewer, 'credential'), 'utf8'), ka + '\n');
    assert.equal(await readFile(join(writer, 'credential'), 'utf8'), kb + '\n');
    const profile = JSON.parse(await readFile(join(reviewer, 'profile.json'), 'utf8'));
    assert.equal(profile.workspace, await realpath(home));
    assert.equal(profile.agent, 'claude');
    assert.equal(profile.origin, 'https://dev.userendezvous.com');
    assert.equal(profile.credentialFile, 'credential');
    if (process.platform !== 'win32') {
      for (const directory of [join(home, 'agents'), reviewer, writer]) assert.equal((await stat(directory)).mode & 0o777, 0o700);
      for (const file of ['profile.json', 'credential']) assert.equal((await stat(join(reviewer, file))).mode & 0o777, 0o600);
    }
    await unlink(join(reviewer, 'credential')); // Inspection must not require or read secrets.
    const shown = await cli(home, ['show', 'reviewer', '--json']);
    assert.equal(shown.code, 0, shown.stderr);
    assert.deepEqual(JSON.parse(shown.stdout), profile);
    const listed = await cli(home, ['list', '--json']);
    assert.equal(listed.code, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout).map((p: { agentId: string }) => p.agentId), [a, b]);
    assert.ok(![ka, kb].some(secret => (shown.stdout + listed.stdout).includes(secret)));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('duplicate and concurrent setup never replace a saved profile or credential', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rendezvous-profile-lock-'));
  const candidates = [{ id: randomUUID(), key: key() }, { id: randomUUID(), key: key() }];
  try {
    const results = await Promise.all(candidates.map(c => cli(home, setup('reviewer', c.id), c.key)));
    assert.equal(results.filter(r => r.code === 0).length, 1);
    const winner = candidates[results.findIndex(r => r.code === 0)], directory = join(home, 'agents', 'reviewer');
    const before = await readFile(join(directory, 'profile.json'), 'utf8');
    assert.equal(JSON.parse(before).agentId, winner.id);
    assert.equal(await readFile(join(directory, 'credential'), 'utf8'), winner.key + '\n');
    const duplicate = await cli(home, setup('reviewer', randomUUID()), key());
    assert.equal(duplicate.code, 2); assert.match(duplicate.stderr, /already exists/);
    assert.equal(await readFile(join(directory, 'profile.json'), 'utf8'), before);
    assert.deepEqual(await readdir(join(home, 'agents')), ['reviewer']);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('bad names, inputs and credential flags fail without saving a profile or exposing a key', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rendezvous-profile-invalid-'));
  const credential = key();
  try {
    for (const args of [setup('../escape', randomUUID()), setup('reviewer', 'bad-id'),
      [...setup('reviewer', randomUUID()), '--workspace', resolve('package.json')],
      [...setup('reviewer', randomUUID()), '--api-key', credential],
      ['list', '--agent', 'claude'], ['show'], ['start', 'reviewer', '--json']]) {
      const result = await cli(home, args, credential);
      assert.equal(result.code, 2, result.stderr); assert.equal(result.stdout, '');
      assert.ok(!result.stderr.includes(credential));
    }
    const missing = await cli(home, setup('reviewer', randomUUID()));
    assert.equal(missing.code, 2); assert.match(missing.stderr, /RENDEZVOUS_AGENT_API_KEY/);
    const invalid = await cli(home, setup('reviewer', randomUUID()), 'secret-invalid-key');
    assert.equal(invalid.code, 2); assert.ok(!invalid.stderr.includes('secret-invalid-key'));
    assert.deepEqual(await readdir(home), []);
  } finally { await rm(home, { recursive: true, force: true }); }
});
