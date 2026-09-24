import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localChat } from '../src/cli/local-chat.js';
import { LocalInput } from '../src/cli/local-input.js';
import type { ConversationOptions } from '../src/cli/agent-conversations.js';

test('interrupted private work preserves its thread and never automatically replays', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'private-chat-'));
  let calls = 0;
  try {
    const options = { directory, client: { signal: new AbortController().signal }, profile: { agentId: 'agent', instructions: 'Local scope' },
      runtime: { async run(_prompt: string, _thread: string | undefined, _signal: AbortSignal, onThread: (id: string) => Promise<void>) {
        calls++; await onThread('private-thread'); throw new Error('Harness interrupted');
      } },
    } as unknown as ConversationOptions;
    await assert.rejects(localChat(options, 'Local work'), /Harness interrupted/);
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'local-chat.json'), 'utf8')), { inFlight: true, threadId: 'private-thread' });
    await assert.rejects(localChat(options, 'Retry'), /not be replayed/);
    assert.equal(calls, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('local instruction queue is bounded and abortable', async () => {
  const input = new LocalInput(), abort = new AbortController();
  input.send('first'); assert.throws(() => input.send('overflow'), /already queued/);
  assert.equal(await input.next(abort.signal), 'first');
  const pending = input.next(abort.signal); abort.abort(new Error('session ended'));
  await assert.rejects(pending, /session ended/);
});
