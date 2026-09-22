import { spawnSync } from 'node:child_process';
const result = spawnSync('tsc', ['-p', 'tsconfig.json'], { stdio: 'inherit', shell: process.platform === 'win32' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

if (result.status === 0) {
  const client = spawnSync('tsc', ['-p', 'tsconfig.client.json'], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (client.error) throw client.error;
  process.exitCode = client.status ?? 1;
}
