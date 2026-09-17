import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile, copyFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fixture } from './helpers.js';

function cli(args: string[], input?: string, env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
    const child = spawn(process.execPath, ['dist/cli/main.js', ...args], {
      env: { ...process.env, RENDEZVOUS_INVITATION_URL: '', RENDEZVOUS_URL: '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolveResult({ code, stdout, stderr }));
    child.stdin.end(input);
  });
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
  for (const args of [['lisetn'], ['listen', '--json'], ['create', '--state', 'x'],
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
    const result = await cli(['create', '--server', f.base, '--participants', '3', '--ttl', '600', '--output', output, '--json']);
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
    const duplicate = await cli(['create', '--server', f.base, '--output', output]);
    assert.equal(duplicate.code, 1); assert.match(duplicate.stderr, /already exists/);
    assert.equal(await readFile(output, 'utf8'), previous);
  } finally { await f.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('create text output is just the invitation; quiet suppresses progress', async () => {
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), 'rendezvous-create-'));
  try {
    const result = await cli(['create', '--output', join(directory, 'room.json'), '-q'], undefined, { RENDEZVOUS_URL: f.base });
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
    const created = await cli(['create', '--server', f.base, '--output', roomFile, '--json']);
    assert.equal(created.code, 0, created.stderr);
    assert.ok(JSON.parse(created.stdout).invite_url.startsWith(f.base));
    const args = ['listen', '--state', stateFile, '--objective-file', '-', '--max-turns', '1'];
    const env = { PATH: `${directory}:${process.env.PATH}` };
    const first = await cli([...args, '--room-file', roomFile, '--workspace', directory], 'Introduce yourself.', env);
    assert.equal(first.code, 0, first.stderr); assert.equal(first.stdout, '');
    assert.match(first.stderr, /Resume: rendezvous listen --state/);
    const saved = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(saved.objective, 'Introduce yourself.'); assert.equal(saved.threadId, 'fixture-thread');
    const second = await cli(args, 'Updated local instructions.', env);
    assert.equal(second.code, 0, second.stderr); assert.match(second.stderr, /resumed Codex turn/);
    const resumed = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(resumed.participantId, saved.participantId);
    assert.equal(resumed.objective, 'Updated local instructions.');
  } finally { await f.stop(); await rm(directory, { recursive: true, force: true }); }
});
