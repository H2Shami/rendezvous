import EmbeddedPostgres from 'embedded-postgres';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const probe = createServer();
await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const dir = await mkdtemp(join(tmpdir(), 'rendezvous-native-pg-'));
const password = randomBytes(32).toString('hex');
const postgres = new EmbeddedPostgres({ databaseDir: join(dir, 'db'), user: 'rendezvous', password, port,
  authMethod: 'scram-sha-256', persistent: false, postgresFlags: ['-h', '127.0.0.1', '-k', dir],
  onLog: () => {}, onError: () => {},
});
try {
  await postgres.initialise(); await postgres.start(); await postgres.createDatabase('rendezvous_test');
  console.log('Running integration suite against native PostgreSQL with a 10-connection pool.');
  const files = (await readdir('test')).filter(x => x.endsWith('.test.ts')).map(x => `test/${x}`);
  const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', ...files], { stdio: 'inherit', env: {
    ...process.env, TEST_DATABASE_URL: `postgresql://rendezvous:${password}@127.0.0.1:${port}/rendezvous_test`,
  } });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
  process.exitCode = code ?? 1;
} finally { await postgres.stop(); await rm(dir, { recursive: true, force: true }); }
