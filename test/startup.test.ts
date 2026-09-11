import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type AddressInfo } from 'node:net';

test('duplicate startup refuses storage before opening PostgreSQL and clean restart preserves rooms', async () => {
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port; await new Promise(resolve => probe.close(resolve));
  const dir = await mkdtemp(join(tmpdir(), 'rendezvous-startup-'));
  const base = `http://127.0.0.1:${port}`;
  function start() {
    const child = spawn(process.execPath, ['dist/main.js'], { env: { ...process.env, DATABASE_URL: '', DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1', PUBLIC_URL: base }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const done = new Promise<{ code: number | null; output: string }>((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve({ code, output })); });
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Startup timed out: ${output}`)), 10000);
      const add = (data: Buffer) => { output += data; if (output.includes('listening at')) { clearTimeout(timer); resolve(); } };
      child.stdout.on('data', add); child.stderr.on('data', add);
      child.once('exit', () => { clearTimeout(timer); reject(new Error(output)); });
    });
    ready.catch(() => {});
    return { child, ready, done };
  }
  let first, second;
  try {
    first = start(); await first.ready;
    const response = await fetch(`${base}/api/v1/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const room = await response.json(); assert.equal(response.status, 201);
    second = start(); const duplicate = await second.done;
    assert.equal(duplicate.code, 1); assert.match(duplicate.output, /SERVER_ALREADY_RUNNING/);
    assert.equal((await fetch(`${base}/join/${room.session_id}`)).status, 200);
    first.child.kill('SIGTERM'); assert.equal((await first.done).code, 0);
    first = start(); await first.ready;
    assert.equal((await fetch(`${base}/join/${room.session_id}`)).status, 200);
  } finally {
    for (const server of [first, second]) if (server && server.child.exitCode === null) { server.child.kill('SIGTERM'); await server.done; }
    await rm(dir, { recursive: true, force: true });
  }
});
