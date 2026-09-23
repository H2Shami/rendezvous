import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { AgentClient, AgentClientError } from '../client/index.js';
import { Transport } from '../client/transport.js';
import { profile as validateProfile } from '../client/validation.js';
import { AgentJournal, readPrivateFile } from './agent-journal.js';
import { profileDirectory, readProfile } from './profiles.js';

async function credential(directory: string) {
  let key: string;
  try { key = (await readPrivateFile(join(directory, 'credential'))).trim(); }
  catch { throw new AgentClientError('CREDENTIAL_UNAVAILABLE', 'Cannot read the private profile credential file. Check its location and permissions (0600).'); }
  if (!/^agk_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(key))
    throw new AgentClientError('INVALID_CREDENTIAL', 'The profile credential is not a runtime agent API key.');
  return key;
}

/** Status authenticates without acquiring, renewing, or releasing a receiver. */
export async function agentStatus(name: string, signal: AbortSignal) {
  const saved = await readProfile(name);
  const result = await new Transport(saved.origin).request(
    await credential(profileDirectory(name)), '/agents/me', validateProfile, { signal });
  if (result.agent.id !== saved.agentId)
    throw new AgentClientError('IDENTITY_MISMATCH', 'Profile and credential belong to different agents.');
  return { name, agentId: saved.agentId, origin: saved.origin, availability: result.availability };
}

export async function startAgent(name: string, options: {
  takeover?: boolean;
  signal: AbortSignal;
  log: (message: string) => void;
}) {
  const saved = await readProfile(name), directory = profileDirectory(name);
  const compromised = new AbortController();
  const signal = AbortSignal.any([options.signal, compromised.signal]);
  const release = await lockfile.lock(directory, {
    realpath: true, retries: 0,
    onCompromised: () => compromised.abort(new Error('Agent profile lock was lost. Listener stopped.')),
  }).catch(error => {
    if (error.code === 'ELOCKED') throw new Error('This profile is already running locally. Stop that process first; --takeover does not bypass its journal lock.');
    throw error;
  });
  const journal = new AgentJournal(join(directory, 'journal.json'));
  let client: AgentClient | undefined;
  let connected = false;
  try {
    client = new AgentClient({ serverUrl: saved.origin, agentId: saved.agentId,
      apiKey: () => credential(directory), journal });
    let previous;
    try { previous = await journal.load(); }
    catch { throw new AgentClientError('JOURNAL_ERROR', 'Could not read the agent journal. Preserve it and check its format and permissions.'); }
    if (previous?.pendingOpen || Object.keys(previous?.sessions ?? {}).length)
      throw new AgentClientError('RECOVERY_REQUIRED', 'This listener version cannot resume saved session work. Preserve the journal and use a session-capable CLI.');
    await client.connect({ takeover: options.takeover, signal });
    connected = true;
    // Harness handling comes next. Keep the live receiver paused in this release.
    await client.setAcceptingSessions(false);
    options.log(`Agent ${name} connected; sessions paused. Press Ctrl+C to disconnect.`);
    const lifetime = client.signal;
    if (!lifetime.aborted) await new Promise<void>(resolve => {
      lifetime.addEventListener('abort', () => resolve(), { once: true });
    });
    if (!signal.aborted) throw client.signal.reason;
    if (compromised.signal.aborted) throw compromised.signal.reason;
  } finally {
    // Failed acquisitions keep their intent for explicit retry. In particular, a
    // mismatched identity must never release the journal's saved receiver.
    try { if (connected) await client!.disconnect(); }
    finally { if (!compromised.signal.aborted) await release(); }
  }
  options.log(`Agent ${name} disconnected.`);
}

export function agentErrorMessage(error: AgentClientError) {
  const messages: Record<string, string> = {
    CREDENTIAL_UNAVAILABLE: 'Cannot read the private profile credential file. Check its location and permissions (0600).',
    UNAUTHORIZED: 'Agent authentication failed. Check whether its key was revoked or the agent was disabled.',
    IDENTITY_MISMATCH: 'The key or journal belongs to another agent/server. Use the matching profile; preserve its journal.',
    RECEIVER_CONFLICT: 'This agent is already connected elsewhere. Stop it there, or use agent start NAME --takeover to replace it.',
    STALE_RECEIVER: 'This listener was replaced. Restart explicitly after checking the other listener.',
    CONNECTION_ENDED: 'The saved connection has ended. Run agent start again to establish a new lease.',
    LEASE_EXPIRED: 'The listener lease expired. Check connectivity and run agent start again.',
    NETWORK_ERROR: 'Cannot confirm the server response. Check connectivity, then restart with the same profile to recover.',
    UNSUPPORTED_PROTOCOL: 'Server and CLI protocols are incompatible. Update the CLI; if it is current, ask the server operator to support agent-friends-http-v1.',
    INVALID_RESPONSE: 'The server returned an incompatible response. Check the server URL and update the CLI/server to compatible versions.',
  };
  return messages[error.code] ?? error.message;
}
