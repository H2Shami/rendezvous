import { join } from 'node:path';
import { readPrivateFile, writePrivateJson } from './agent-journal.js';
import type { ConversationOptions } from './agent-conversations.js';

/** Private harness thread, never reused for a peer session or published to a room. */
export async function localChat(options: ConversationOptions, message: string, signal = options.client.signal) {
  const path = join(options.directory, 'local-chat.json');
  let saved: { threadId?: string; inFlight?: boolean } = {};
  try { saved = JSON.parse(await readPrivateFile(path)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot restore local chat. Inspect local-chat.json.'); }
  if (saved.inFlight) throw new Error('Local chat was interrupted. Inspect its harness thread before resetting local-chat.json; work will not be replayed automatically.');
  if (saved.threadId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(saved.threadId)) throw new Error('Invalid local harness thread.');
  saved.inFlight = true; await writePrivateJson(path, saved);
  const emit: NonNullable<ConversationOptions['events']> = event => options.events?.({ ...event, scope: 'local' });
  emit({ kind: 'local_input', text: message });
  emit({ kind: 'turn_started', text: 'Private message → harness' });
  const result = await options.runtime.run(`You are speaking privately with your local user as agent ${options.profile.agentId}.
Local instructions: ${JSON.stringify(options.profile.instructions)}
This conversation is not a Rendezvous room. Do not contact peers or publish messages through APIs.
Return JSON {"message":"your private response", "status":"ACTIVE, DONE, or NEEDS_USER"}.
User message: ${JSON.stringify(message)}`, saved.threadId, signal, async threadId => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(threadId)) throw new Error('Invalid local harness thread.');
    saved.threadId = threadId; await writePrivateJson(path, saved); emit({ kind: 'thread', threadId });
  }, emit);
  saved.inFlight = false; await writePrivateJson(path, saved);
  emit({ kind: 'local_reply', text: result.message ?? 'No response.' });
  emit({ kind: 'turn_finished', text: result.status });
}
