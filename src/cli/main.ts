#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, realpath, mkdir, open, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { parseInvitation, RoomClient, createRoom, serverOrigin } from './client.js';
import { loadState, lockState, saveState } from './state.js';
import { CodexRuntime } from './runtime.js';
import { listen } from './bridge.js';

import { summary, createHelp, listenHelp } from './help.js';
import { spawnSync } from 'node:child_process';
import { addAbortSignal } from 'node:stream';

class UsageError extends Error {}

function positive(value: string | undefined, fallback: number, flag: string, max = 86400) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < 1 || n > max) {
    throw new UsageError(`${flag} must be an integer from 1 to ${max}.`);
  }
  return n;
}

async function objectiveText(path: string, signal: AbortSignal) {
  if (path !== '-') return await readFile(resolve(path), 'utf8');
  if (process.stdin.isTTY) throw new UsageError('--objective-file - requires piped input. Use --objective-file task.txt instead.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of addAbortSignal(signal, process.stdin)) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > 32768) throw new UsageError('Task input exceeds 32768 bytes.');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function shellQuote(value: string) { return "'" + value.replaceAll("'", "'\\''") + "'"; }

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] === 'help' ? args[1] : args.find(arg => !arg.startsWith('-'));
  if (!args.length || args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    if (args[0] === 'help' && command && !['create', 'listen'].includes(command)) {
      throw new UsageError('Unknown help topic. Use rendezvous help create or rendezvous help listen.');
    }
    console.log(command === 'create' ? createHelp : command === 'listen' ? listenHelp : summary); return;
  }
  if (args.length === 1 && ['--version', '-V'].includes(args[0])) {
    const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    console.log(pkg.version); return;
  }
  let parsed;
  try {
    parsed = parseArgs({ allowPositionals: true, options: {
      workspace: { type: 'string' }, 'objective-file': { type: 'string' }, name: { type: 'string' },
      state: { type: 'string' }, 'max-turns': { type: 'string' }, 'turn-timeout': { type: 'string' },
      'retry-interrupted': { type: 'boolean' }, quiet: { type: 'boolean', short: 'q' },
      server: { type: 'string' }, output: { type: 'string' }, participants: { type: 'string' },
      ttl: { type: 'string' }, json: { type: 'boolean' }, 'room-file': { type: 'string' },
    } });
  } catch (error) { throw new UsageError(error instanceof Error ? error.message : 'Invalid arguments.'); }
  const { values, positionals } = parsed;
  if (positionals.length !== 1 || !['create', 'listen'].includes(positionals[0])) {
    throw new UsageError('Expected one command: create or listen.');
  }
  const creating = positionals[0] === 'create';
  const allowed = creating ? ['server', 'output', 'participants', 'ttl', 'json', 'quiet']
    : ['workspace', 'objective-file', 'name', 'state', 'max-turns', 'turn-timeout', 'retry-interrupted', 'quiet', 'room-file'];
  for (const key of Object.keys(values)) {
    if (!allowed.includes(key)) throw new UsageError(`--${key} is not an option for ${positionals[0]}.`);
  }
  const log = (message: string) => { if (!values.quiet) console.error(message); };
  if (creating) {
    let origin: string;
    try { origin = serverOrigin(values.server ?? process.env.RENDEZVOUS_URL ?? ''); }
    catch (error) { throw new UsageError((error as Error).message); }
    const participants = positive(values.participants, 2, '--participants', 10);
    const ttl = values.ttl === undefined ? undefined : positive(values.ttl, 86400, '--ttl', 604800);
    const output = resolve(values.output ?? `${homedir()}/.rendezvous/created/${randomUUID()}.json`);
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    // Reserve the destination before creating anything remotely. Never overwrite credentials.
    const file = await open(output, 'wx', 0o600);
    const controller = new AbortController();
    const stop = () => { process.exitCode = 130; controller.abort(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
      log(`Creating room at ${origin}…`);
      const room = await createRoom(origin, participants, ttl, controller.signal);
      await file.writeFile(JSON.stringify(room, null, 2) + '\n');
      await file.sync();
      console.log(values.json ? JSON.stringify({ ...room, room_file: output }, null, 2) : room.invite_url);
      log(`Room created. Expires: ${room.expires_at}\nPrivate room file: ${output}\nShare the invitation above with peers. Keep the owner URL in the file private.\nStart your agent: rendezvous listen --room-file ${shellQuote(output)} --objective-file task.txt`);
    } catch (error) {
      console.error(`Creation was not retried. If the request reached the server, a room may exist. Check ${output} and the server before creating another.`);
      throw error;
    } finally {
      await file.close(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    }
    return;
  }
  let invitationValue = process.env.RENDEZVOUS_INVITATION_URL;
  if (values['room-file']) {
    const contents = await readFile(resolve(values['room-file']), 'utf8');
    let room;
    try { room = JSON.parse(contents); }
    catch { throw new UsageError('--room-file is not valid JSON. Use a file saved by rendezvous create.'); }
    if (!room || typeof room.invite_url !== 'string') throw new UsageError('--room-file must be a JSON file saved by rendezvous create.');
    invitationValue = room.invite_url;
  }
  const invitation = invitationValue ? parseInvitation(invitationValue) : undefined;
  delete process.env.RENDEZVOUS_INVITATION_URL;
  if (!invitation && !values.state) throw new UsageError('Provide --room-file, set RENDEZVOUS_INVITATION_URL for first join, or use --state to resume.');
  const hash = invitation ? createHash('sha256').update(`${invitation.origin}/${invitation.roomId}`).digest('hex') : '';
  const statePath = resolve(values.state ?? `${homedir()}/.rendezvous/rooms/${hash}.json`);
  const maxTurns = positive(values['max-turns'], 20, '--max-turns');
  const timeoutMs = positive(values['turn-timeout'], 300, '--turn-timeout') * 1000;
  const controller = new AbortController();
  const stop = () => { process.exitCode = 130; controller.abort(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const release = await lockState(statePath);
  try {
    let state = await loadState(statePath);
    if (state && invitation && (state.origin !== invitation.origin || state.roomId !== invitation.roomId)) {
      throw new Error('State file belongs to another room/server.');
    }
    const workspace = await realpath(values.workspace ?? state?.workspace ?? process.cwd());
    if (state && state.workspace !== workspace) throw new Error('Cannot change the workspace of an existing room conversation.');
    if (values.name !== undefined && values.name.length > 100) throw new UsageError('--name must be at most 100 characters.');
    const objective = values['objective-file'] ? (await objectiveText(values['objective-file'], controller.signal)).trim() : state?.objective;
    if (!objective || Buffer.byteLength(objective) > 32768) throw new UsageError('Provide --objective-file containing your task/boundaries (1–32768 bytes).');
    if (!(await stat(workspace)).isDirectory()) throw new UsageError('--workspace must be a directory.');
    if (state?.inFlight && !values['retry-interrupted']) throw new Error('Previous turn was interrupted. Inspect room and Codex history, then use --retry-interrupted if replay is appropriate.');
    const codex = spawnSync('codex', ['--version'], { timeout: 10000, stdio: 'ignore' });
    if (codex.error || codex.status !== 0) throw new Error('Cannot run codex. Install the Codex CLI, ensure it is on PATH, and run codex login before listening.');
    if (!state) {
      if (!invitation) throw new Error('State not found; provide an invitation to join.');
      // A failed join is not automatically retried: its invite use may already be consumed.
      log('Joining room…');
      const joined = await new RoomClient(invitation.origin, invitation.roomId).join(invitation.secret, values.name ?? 'Codex', controller.signal);
      state = { version: 1, origin: invitation.origin, roomId: invitation.roomId,
        participantId: joined.participant_id, token: joined.participant_token, workspace, objective,
        cursor: 0, initialized: false };
      await saveState(statePath, state);
    }
    if (values['objective-file']) { state.objective = objective; state.initialized = false; }
    if (values['retry-interrupted']) state.inFlight = false;
    await saveState(statePath, state);
    log(`Listening to ${state.roomId} at ${state.origin}\nWorkspace: ${workspace}\nPrivate state: ${statePath}\nResume: rendezvous listen --state ${shellQuote(statePath)}\nCtrl+C to disconnect.`);
    const currentState = state;
    await listen({ state, client: new RoomClient(state.origin, state.roomId, state.token),
      runtime: new CodexRuntime(workspace, timeoutMs), signal: controller.signal,
      save: () => saveState(statePath, currentState), log, maxTurns });
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    log('Disconnected. Interrupted work is retained for inspection before retry.');
  } finally {
    await release(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}

process.stdout.on('error', error => {
  if ((error as NodeJS.ErrnoException).code === 'EPIPE') process.exit(0);
  throw error;
});
main().catch(error => {
  const code = (error as NodeJS.ErrnoException).code;
  const message = code === 'EEXIST' ? 'Output file already exists. Choose a new --output path; existing credentials were not overwritten.'
    : code === 'ELOCKED' ? 'This state file is already in use. Stop the other listener or choose a separate --state file.'
    : code === 'ENOENT' ? 'A file or directory was not found. Check the workspace, objective, room file, and state paths.'
    : code === 'EACCES' ? 'Permission denied. Choose a path you can read/write.'
    : error instanceof SyntaxError ? 'Invalid JSON in a saved file or server response. Check the file or server before retrying.'
    : error instanceof TypeError && error.message === 'fetch failed' ? 'Cannot reach the server. Check the URL and that the server is running.'
    : error instanceof Error ? error.message : 'CLI failed.';
  console.error(`Error: ${message}`);
  if (error instanceof UsageError) console.error('Run rendezvous <command> --help for usage and examples.');
  process.exitCode ||= error instanceof UsageError ? 2 : 1;
});
