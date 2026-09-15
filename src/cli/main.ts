import { parseArgs } from 'node:util';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { parseInvitation, RoomClient } from './client.js';
import { loadState, lockState, saveState } from './state.js';
import { CodexRuntime } from './runtime.js';
import { listen } from './bridge.js';

const help = `Rendezvous CLI (development preview)

npm run rendezvous -- listen --workspace /path/to/repo --objective-file /path/to/task.txt
  First run: set RENDEZVOUS_INVITATION_URL to the complete invitation URL.
  Resume: use --state /path/printed/on/first/run.json; no invitation needed.

Options:
  --name NAME              Participant display name (default: Codex)
  --state FILE             Private state file (default: ~/.rendezvous/rooms/<hash>.json)
  --max-turns N            Maximum turns this run (default: 20)
  --turn-timeout N         Seconds per Codex turn (default: 300)
  --retry-interrupted     Explicitly replay an uncertain turn; may duplicate effects
  --help                  Show help

Read-only Codex execution. Requires an installed, authenticated Codex CLI.
Ctrl+C disconnects without leaving the room or invalidating its credential.
No autostart, public listening port, or attachment to an existing desktop chat.
`;

function positive(value: string | undefined, fallback: number) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > 86400) throw new Error('Limits must be integers from 1 to 86400.');
  return n;
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    workspace: { type: 'string' }, 'objective-file': { type: 'string' }, name: { type: 'string' },
    state: { type: 'string' }, 'max-turns': { type: 'string' }, 'turn-timeout': { type: 'string' },
    'retry-interrupted': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help || !positionals.length) { console.log(help); return; }
  if (positionals.length !== 1 || positionals[0] !== 'listen') throw new Error('Expected command: listen. Use --help.');
  const invitation = process.env.RENDEZVOUS_INVITATION_URL ? parseInvitation(process.env.RENDEZVOUS_INVITATION_URL) : undefined;
  delete process.env.RENDEZVOUS_INVITATION_URL;
  if (!invitation && !values.state) throw new Error('Set RENDEZVOUS_INVITATION_URL for first join, or --state to resume.');
  const hash = invitation ? createHash('sha256').update(`${invitation.origin}/${invitation.roomId}`).digest('hex') : '';
  const statePath = resolve(values.state ?? `${homedir()}/.rendezvous/rooms/${hash}.json`);
  const maxTurns = positive(values['max-turns'], 20);
  const timeoutMs = positive(values['turn-timeout'], 300) * 1000;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const release = await lockState(statePath);
  try {
    let state = await loadState(statePath);
    if (state && invitation && (state.origin !== invitation.origin || state.roomId !== invitation.roomId)) {
      throw new Error('State file belongs to another room/server.');
    }
    const workspace = await realpath(values.workspace ?? state?.workspace ?? process.cwd());
    if (state && state.workspace !== workspace) throw new Error('Cannot change the workspace of an existing room conversation.');
    const objective = values['objective-file'] ? (await readFile(resolve(values['objective-file']), 'utf8')).trim() : state?.objective;
    if (!objective || Buffer.byteLength(objective) > 32768) throw new Error('Provide --objective-file containing your task/boundaries (1–32768 bytes).');
    if (!state) {
      if (!invitation) throw new Error('State not found; provide an invitation to join.');
      // A failed join is not automatically retried: its invite use may already be consumed.
      const joined = await new RoomClient(invitation.origin, invitation.roomId).join(invitation.secret, values.name ?? 'Codex', controller.signal);
      state = { version: 1, origin: invitation.origin, roomId: invitation.roomId,
        participantId: joined.participant_id, token: joined.participant_token, workspace, objective,
        cursor: 0, initialized: false };
      await saveState(statePath, state);
    }
    if (values['objective-file']) { state.objective = objective; state.initialized = false; }
    if (values['retry-interrupted']) state.inFlight = false;
    await saveState(statePath, state);
    console.log(`Listening to ${state.roomId} at ${state.origin}\nWorkspace: ${workspace}\nPrivate state: ${statePath}\nCtrl+C to disconnect.`);
    const currentState = state;
    await listen({ state, client: new RoomClient(state.origin, state.roomId, state.token),
      runtime: new CodexRuntime(workspace, timeoutMs), signal: controller.signal,
      save: () => saveState(statePath, currentState), log: console.log, maxTurns });
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    console.log('Disconnected. Interrupted work is retained for inspection before retry.');
  } finally {
    await release(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'CLI failed.'); process.exitCode = 1; });
