import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { request, saveState } from '../client/agent.js';

// Local manual-test harness. Keeps credentials out of shell command text.
const target = 'rendezvous-demo';
const cwd = process.cwd();
const tmux = (...args) => execFileSync('tmux', args, { encoding: 'utf8' });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
try { tmux('has-session', '-t', target); throw new Error('rendezvous-demo already exists; inspect it before creating another demo.'); }
catch (e) { if (!e.status) throw e; }
await mkdir('.rendezvous', { recursive: true, mode: 0o700 });
try { await access('.rendezvous/tmux-owner.json'); throw new Error('Demo owner state already exists. Use the existing demo.'); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
const room = await request('http://localhost:3000/api/v1/sessions', { method: 'POST', body: {} });
await saveState('.rendezvous/tmux-owner.json', room);
// Download what a previously unaware agent would receive, without npm dependencies.
const response = await fetch('http://localhost:3000/client.mjs');
if (!response.ok) throw new Error('Client download failed.');
await writeFile('.rendezvous/downloaded-client.mjs', await response.text(), { mode: 0o600 });
tmux('new-session', '-d', '-s', target, '-n', 'alice', '-c', cwd,
  'node .rendezvous/downloaded-client.mjs join --state .rendezvous/tmux-alice.json --name Alice');
tmux('new-window', '-d', '-t', `${target}:1`, '-n', 'bob', '-c', cwd,
  'node .rendezvous/downloaded-client.mjs join --state .rendezvous/tmux-bob.json --name Bob');
await pause(700);
for (const window of ['alice', 'bob']) { tmux('send-keys', '-t', `${target}:${window}`, '-l', room.invite_url); tmux('send-keys', '-t', `${target}:${window}`, 'Enter'); }
await pause(1000);
const say = async (who, message) => { tmux('send-keys', '-t', `${target}:${who}`, '-l', message); tmux('send-keys', '-t', `${target}:${who}`, 'Enter'); await pause(700); };
await say('alice', 'When can your user hang out?');
await say('bob', 'Thursday evening works. I will confirm with my user.');
await say('bob', '/disconnect');
await say('alice', 'How about 7:30? This message was sent while Bob was offline.');
await say('bob', '/reconnect');
const bob = tmux('capture-pane', '-p', '-t', `${target}:bob`, '-S', '-40');
if (!bob.includes('This message was sent while Bob was offline')) throw new Error('Offline replay was not visible in Bob’s tmux pane.');
console.log('PASS: two independent downloaded CLI clients exchanged signed messages and replayed offline history in tmux.');
console.log('tmux session: rendezvous-demo (alice and bob windows)');
console.log('Owner URL and capabilities saved privately in .rendezvous/tmux-owner.json');
