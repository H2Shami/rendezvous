import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { formatLine } from './dev-output.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.PORT || 3000), proxyPort = Number(process.env.PROXY_PORT || 8080);
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Use Node 22+ to run the backend.');
if (![port, proxyPort].every(p => Number.isInteger(p) && p > 0 && p < 65536) || port === proxyPort) throw new Error('PORT and PROXY_PORT must be distinct valid ports.');
const publicUrl = process.env.PUBLIC_URL || `http://127.0.0.1:${proxyPort}`;
const host = process.env.HOST || '127.0.0.1';
const apiTarget = `http://${host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '[::1]' : host}:${port}`;
const frontendTarget = process.env.FRONTEND_TARGET || 'http://127.0.0.1:3001';
const env = { ...process.env, HOST: host, PORT: String(port), PROXY_PORT: String(proxyPort), PUBLIC_URL: publicUrl, API_TARGET: apiTarget, FRONTEND_TARGET: frontendTarget };
const children: ChildProcess[] = [];
let stopping = false;
function signal(child: ChildProcess, value: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    // Each watcher and its server are in a process group created by this launcher.
    if (process.platform === 'win32') child.kill(value);
    else process.kill(-child.pid, value);
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
}
function stop(code: number) {
  if (stopping) return; stopping = true; process.exitCode = code;
  console.log('[backend] Stopping server and proxy…');
  for (const child of children) signal(child, 'SIGTERM');
  const timeout = setTimeout(() => { for (const child of children) signal(child, 'SIGKILL'); }, 8000);
  timeout.unref();
}
function launch(name: string, entry: string) {
  const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'watch', '--clear-screen=false', entry], {
    cwd: root, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  for (const stream of [child.stdout!, child.stderr!]) {
    createInterface({ input: stream }).on('line', line => { const formatted = formatLine(name, line); if (formatted) console.log(formatted); });
  }
  child.once('error', error => { console.error(`[${name}] Failed to start: ${error.message}`); stop(1); });
  child.once('exit', (code, receivedSignal) => {
    if (!stopping) { console.error(`[${name}] Watcher exited (${receivedSignal || code}); stopping the backend group.`); stop(code || 1); }
  });
}
console.log(`[backend] Open ${publicUrl}`);
console.log(`[proxy] :${proxyPort} → server :${port}; frontend ${frontendTarget}`);
console.log('[backend] Start the client separately: npm run dev:web. Ctrl-C stops only server + proxy.');
process.once('SIGINT', () => stop(0)); process.once('SIGTERM', () => stop(0));
launch('server', 'src/main.ts');
launch('proxy', 'scripts/dev-proxy.ts');
