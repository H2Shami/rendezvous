#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { open, unlink, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Agent, request, saveState } from './agent.js';
import { defaultState } from './context.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  state: { type: 'string' }, name: { type: 'string', default: 'Agent' },
  base: { type: 'string', default: 'http://localhost:3000' }, transport: { type: 'string', default: 'ws' },
  json: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  timeout: { type: 'string', default: '55' }, 'adopt-state': { type: 'boolean', default: false },
} });
const [command, ...args] = positionals;
let statePath;
const abort = new AbortController();
process.on('SIGINT', () => abort.abort()); process.on('SIGTERM', () => abort.abort());
let lock, rl;
function show(row) {
  if (values.json) console.log(JSON.stringify(row));
  else console.log(`[${row.offset}] ${row.message.sender_id.slice(0, 8)}: ${JSON.stringify(row.message.payload)}`);
}
try {
  if (values.help || !command) {
    console.log(`Agent Rendezvous — Node 22+, no package installation required\n\ncreate  --base URL --state owner.json     Create a session; save owner credentials\nconnect --state agent.json --name NAME    Join once (prompts for invitation URL)\njoin    --state agent.json --name NAME    Join and open interactive chat\nchat    --state agent.json                Reconnect interactive chat\nsend    --state agent.json 'hello'        Send text (or JSON with --json)\nretry   --state agent.json                Retry the exact pending message\nread    --state agent.json                Fetch messages since saved cursor\nwatch   --state agent.json                Receive continuously\n\njoin/connect accept the full URL as an optional positional argument.\n--transport http selects HTTP polling; default ws uses WebSocket receive.\nNever share your state file. Use a different file for each participant.\nInteractive commands: /quit, /retry, /disconnect, /reconnect.`);
    console.log('\nwait    --state agent.json --timeout 55   Wait for peer messages in an active agent tool call\nState defaults are isolated by Codex thread or tmux pane; otherwise connect prints a fresh path.\n--adopt-state deliberately takes over an existing identity.\nFor ongoing agent conversations: connect, send/read replies, then repeat wait.\nA background watcher cannot wake an agent after its turn ends.');
  } else {
    if (!['create', 'connect', 'join', 'chat', 'send', 'retry', 'read', 'watch', 'wait'].includes(command)) throw new Error('Unknown command. Use --help.');
    statePath = values.state ? resolve(values.state) : defaultState(command);
    if (!['ws', 'http'].includes(values.transport)) throw new Error('--transport must be ws or http.');
    await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
    try { lock = await open(`${statePath}.lock`, 'wx', 0o600); await lock.writeFile(String(process.pid)); }
    catch (e) { if (e.code === 'EEXIST') throw new Error(`State is locked by another process. After a crash, verify its PID in ${statePath}.lock is no longer running before removing the lock.`); throw e; }
    if (command === 'create') {
      try { const file = await open(statePath, 'wx', 0o600); await file.close(); } catch (e) { if (e.code === 'EEXIST') throw new Error('Owner state already exists. Choose another --state path.'); throw e; }
      const result = await request(`${values.base.replace(/\/$/, '')}/api/v1/sessions`, { method: 'POST', body: {} });
      await saveState(statePath, result); console.log(`Session created:\n${result.invite_url}\n\nOwner screen:\n${result.owner_url}\n\nCredentials saved to ${statePath}`);
    } else {
      let agent;
      if (['connect', 'join'].includes(command)) {
        let invite = args[0];
        if (!invite) { rl = createInterface({ input: process.stdin, output: process.stdout }); invite = await rl.question('Full invitation URL: '); rl.close(); rl = undefined; }
        agent = await Agent.connect(invite, statePath, values.name, { adopt: values['adopt-state'] });
        console.log(`Joined as ${agent.state.participant_id}`);
        console.log(`Private state: ${statePath}`);
        if (command === 'connect') console.log(`JOINED, NOT LISTENING. Next: node ${JSON.stringify(process.argv[1])} wait --state ${JSON.stringify(statePath)}\nWhile a conversation is ongoing, process replies and repeat wait after each message or idle timeout. Ending your agent turn stops reception; this command cannot wake an idle runtime.`);
      } else agent = await Agent.load(statePath, { adopt: values['adopt-state'] });
      if (command === 'send') {
        if (!args.length) throw new Error('Provide message text or JSON.');
        const payload = values.json ? JSON.parse(args.join(' ')) : { text: args.join(' ') };
        console.log(JSON.stringify(await agent.send(payload)));
      } else if (command === 'retry') console.log(JSON.stringify(await agent.retry()));
      else if (command === 'read') await agent.read(show);
      else if (command === 'wait') {
        const result = await agent.wait({ timeoutSeconds: Number(values.timeout), signal: abort.signal, onMessage: show });
        console.log(JSON.stringify({ type: 'wait_result', ...result, ...(result.status === 'timeout' ? { next_action: 'Repeat wait while the conversation is ongoing. An idle timeout is not a conversation end.' } : {}) }));
      }
      else if (command === 'watch') await agent.watch({ transport: values.transport, signal: abort.signal, onMessage: show, onStatus: s => console.error(s) });
      else if (['join', 'chat'].includes(command)) {
        console.log('Type a message. /quit exits; /disconnect and /reconnect test recovery.');
        let receiver, watching;
        const start = () => {
          receiver = new AbortController();
          watching = agent.watch({ transport: values.transport, signal: receiver.signal, onMessage: show, onStatus: s => console.error(s) }).catch(e => console.error(e.message));
        };
        start();
        rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
        abort.signal.addEventListener('abort', () => rl?.close(), { once: true });
        for await (const line of rl) {
          if (line === '/quit') break;
          if (line === '/disconnect') { receiver.abort(); await watching; console.log('Disconnected. Messages remain durable.'); continue; }
          if (line === '/reconnect') { receiver.abort(); await watching; start(); continue; }
          if (!line.trim()) continue;
          try { const ack = line === '/retry' ? await agent.retry() : await agent.send({ text: line }); console.log(`ack ${ack.offset}${ack.duplicate ? ' (retry)' : ''}`); }
          catch (e) { console.error(e.message); }
        }
        receiver.abort(); await watching;
      }
    }
  }
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally { rl?.close(); if (lock) { await lock.close(); await unlink(`${statePath}.lock`); } }
