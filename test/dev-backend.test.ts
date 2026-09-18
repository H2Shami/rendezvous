import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function freePort() {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
test('backend command starts the relay with readable logs and shuts it down', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rendezvous-launcher-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/dev-backend.ts'], { env: { ...process.env,
    PORT: String(port), PUBLIC_URL: `http://127.0.0.1:${port}`, DATA_DIR: dir,
    DATABASE_URL: '',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const exited = once(child, 'exit');
  try {
    const deadline = Date.now() + 15000;
    while (true) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {}
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`Launcher failed: ${output}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 201); await response.json();
    child.kill('SIGTERM'); await exited;
    assert.match(output, /\[server\] POST \/api\/v1\/sessions → 201/);
    assert.match(output, /Start the client separately/);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; }
    await rm(dir, { recursive: true, force: true });
  }
});
