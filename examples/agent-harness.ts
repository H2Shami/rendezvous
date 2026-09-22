/** A provider-independent adapter. Supply your own model, tools and conversation store. */
import { AgentClient, type AgentSession, type SessionMessage } from '../src/client/index.js';

export interface Conversation {
  reply(messages: readonly SessionMessage[], signal: AbortSignal): Promise<string | undefined>;
  stop(): Promise<void>;
}
export interface Harness {
  /** Use bindingId as the stable conversation key. Never put API keys in prompts. */
  createConversation(bindingId: string): Promise<Conversation>;
}

export async function attachConversation(session: AgentSession, conversation: Conversation, signal?: AbortSignal) {
  return session.run({
    async onMessages(messages, boundSession, turnSignal) {
      // Human and peer messages are external input; local tool approval stays in the harness.
      const response = await conversation.reply(messages, turnSignal);
      if (response !== undefined && !turnSignal.aborted) await boundSession.send(response, { signal: turnSignal });
    },
    async stop() { await conversation.stop(); },
  }, { signal });
}

/** Automatic acceptance follows the owner's server-side friend grants. The client
 * does not execute a model itself. An offer is yielded once per journaled session. */
export async function receiveSessions(client: AgentClient, harness: Harness, signal: AbortSignal) {
  const tasks = new Set<Promise<void>>();
  let failure: unknown;
  const stop = new AbortController(), combined = AbortSignal.any([signal, stop.signal]);
  try {
    for await (const session of client.offers({ signal: combined })) {
      const task = (async () => {
        // Persist your conversation before acceptance. The SDK already saved bindingId.
        let conversation: Conversation | undefined;
        try {
          conversation = await harness.createConversation(session.bindingId);
          await session.accept();
        } catch (error) {
          // Acceptance may have committed before its response was lost.
          let stopped = !conversation;
          if (conversation) { try { await conversation.stop(); stopped = true; } catch { /* Never acknowledge failed cleanup. */ } }
          try { await session.close(); if (stopped) await session.stopped(); } catch { /* Keep the journal for recovery. */ }
          throw error;
        }
        await attachConversation(session, conversation, combined);
      })();
      const tracked = task.catch(error => { failure = error; stop.abort(error); }).finally(() => { tasks.delete(tracked); });
      tasks.add(tracked);
    }
  } catch (error) { if (!combined.aborted) failure = error; }
  finally { stop.abort(); await Promise.all(tasks); }
  if (failure) throw failure;
}

// Each runtime environment supplies its own key; one process can own many clients:
// const researcher = new AgentClient({ serverUrl, apiKey: () => secrets.get('researcher'), journal: researcherJournal });
// const reviewer = new AgentClient({ serverUrl, apiKey: () => secrets.get('reviewer'), journal: reviewerJournal });
// await Promise.all([researcher.connect(), reviewer.connect()]);
// try { await receiveSessions(reviewer, yourHarness, shutdownSignal); }
// finally { await reviewer.disconnect(); }
// Outgoing: const session = await researcher.open(peerId); create a conversation
// using session.bindingId, then attachConversation(session, conversation).
// Recovery: inspect client.sessions/recoveryState and explicitly restore saved
// conversations. Do not automatically rerun records with interrupted turns.
