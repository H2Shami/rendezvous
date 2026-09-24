import { LocalInput } from './local-input.js';
import { localChat } from './local-chat.js';
import { AgentClientError, type AgentSession } from '../client/index.js';
import { converse, type ConversationOptions } from './agent-conversations.js';

export interface AgentControls {
  peers?(after?: string): Promise<import('../agents/protocol.js').AgentPeersResponse>;
  steer?(sessionId: string, message: string): Promise<void>;
  chat?(message: string): Promise<void>;
  open(peer: string, message: string): Promise<void>;
  close(sessionId: string): Promise<void>;
}

/** One harness conversation at a time. Keep an outstanding offer instead of cancelling
 * and losing a journaled offer when a local open command wins the race. */
export async function controlledConversations(options: ConversationOptions, register: (controls?: AgentControls) => void,
  initial?: { peer: string; message: string }) {
  const { client } = options;
  let current: AgentSession | undefined, busy = true, finished = false;
  let queued: { peer?: string; message: string; resolve: () => void; reject: (error: unknown) => void } | undefined;
  let wake!: () => void;
  const commandSignal = () => new Promise<{ kind: 'command' }>(resolve => { wake = () => resolve({ kind: 'command' }); });
  let command = commandSignal();
  const abort = new AbortController();
  const offers = client.offers({ signal: AbortSignal.any([client.signal, abort.signal]) });
  const next = () => offers.next().then(result => ({ kind: 'offer' as const, result }), error => ({ kind: 'error' as const, error }));
  let input: LocalInput | undefined;
  let offered: ReturnType<typeof next> | undefined;
  async function run(session: AgentSession, message?: string) {
    busy = true; current = session; input = new LocalInput();
    options.events?.({ kind: 'session', sessionId: session.id, bindingId: session.bindingId,
      text: session.snapshot.state === 'pending' ? 'Waiting for peer acceptance' : 'Resuming conversation' });
    try { await converse({ ...options, localInput: input }, session, message); }
    finally { current = undefined; input = undefined; busy = false; }
  }
  register({
    async steer(sessionId, message) {
      if (!current || current.id !== sessionId || !input || current.snapshot.state !== 'active') throw new Error('Select the current active conversation.');
      if (!message.trim() || Buffer.byteLength(message) > 32768) throw new Error('Message must contain 1–32768 bytes.');
      input.send(JSON.stringify({ kind: 'steer', message }));
    },
    chat(message) {
      if (finished || client.signal.aborted) return Promise.reject(new Error('Listener disconnected.'));
      if (!message.trim() || Buffer.byteLength(message) > 32768) return Promise.reject(new Error('Message must contain 1–32768 bytes.'));
      if (current?.snapshot.state === 'active' && input) {
        try { input.send(JSON.stringify({ kind: 'private', message })); return Promise.resolve(); } catch (error) { return Promise.reject(error); }
      }
      if (busy || queued) return Promise.reject(new Error('The harness is busy. Wait for the current turn or session acceptance.'));
      return new Promise<void>((resolve, reject) => { queued = { message, resolve, reject }; wake(); });
    },
    peers: after => client.peers({ after }),
    open(peer, message) {
      if (finished || client.signal.aborted) return Promise.reject(new Error('Listener disconnected.'));
      if (busy || queued) return Promise.reject(new Error('Finish or close the current conversation first.'));
      if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(peer) || peer.toLowerCase() === options.profile.agentId.toLowerCase())
        return Promise.reject(new Error('Use a different agent’s UUID.'));
      if (!message.trim() || Buffer.byteLength(message) > 32768) return Promise.reject(new Error('Message must contain 1–32768 bytes.'));
      return new Promise<void>((resolve, reject) => { queued = { peer, message, resolve, reject }; wake(); });
    },
    async close(sessionId) {
      if (!current || current.id !== sessionId) throw new Error('That conversation is no longer current.');
      await current.close();
    },
  });
  try {
    for (const session of client.sessions) await run(session);
    if (initial) { busy = true; await run(await client.open(initial.peer), initial.message); }
    busy = false;
    while (!client.signal.aborted) {
      offered ??= next();
      const action = queued ? { kind: 'command' as const } : await Promise.race([offered, command]);
      if (action.kind === 'error') throw action.error;
      if (action.kind === 'offer') {
        offered = undefined;
        if (action.result.done) break;
        await run(action.result.value);
      } else {
        const request = queued!; queued = undefined; command = commandSignal(); busy = true;
        if (!request.peer) {
          try { await client.setAcceptingSessions(false); await localChat(options, request.message); request.resolve(); }
          catch (error) { options.events?.({ kind: 'error', scope: 'local', text: error instanceof Error ? error.message : 'Private turn failed' }); request.reject(error); }
          finally { busy = false; if (!client.signal.aborted) await client.setAcceptingSessions(true); }
          continue;
        }
        let session: AgentSession;
        try { session = await client.open(request.peer); }
        catch (error) {
          request.reject(error); busy = false;
          // Only definite admission rejection clears the SDK's pending-open journal.
          if (error instanceof AgentClientError && ['ACCESS_DENIED', 'AGENT_OFFLINE', 'AGENT_PAUSED', 'AGENT_BUSY', 'INVALID_REQUEST'].includes(error.code)) continue;
          throw error;
        }
        request.resolve(); await run(session, request.message);
      }
    }
  } finally {
    finished = true; register(undefined); queued?.reject(new Error('Listener disconnected.'));
    abort.abort(); await offered; await offers.return(undefined);
  }
}
