import { spawnSync } from 'node:child_process';
// The demo itself starts two independent hosts and cleans them up on completion.
const result = spawnSync('tmux', ['split-window', '-v', '-c', process.cwd(), 'npm run demo; read -r'], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
