import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { CodexRuntime } from '../src/cli/runtime.js';

// Opt-in: two real model turns, using the operator's Codex account, in an empty repo.
test('installed Codex starts and resumes an isolated conversation', {
  skip: process.env.RENDEZVOUS_CODEX_SMOKE !== '1', timeout: 180_000,
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'rendezvous-codex-smoke-'));
  try {
    assert.equal(spawnSync('git', ['init', '--quiet', workspace]).status, 0);
    const runtime = new CodexRuntime(workspace, 75_000);
    let threadId: string | undefined;
    const first = await runtime.run('Do not use any tools. Remember the word marigold. Return message "ready" and status ACTIVE as JSON.',
      undefined, AbortSignal.timeout(80_000), async id => { threadId = id; });
    assert.equal(first.message, 'ready'); assert.ok(threadId);
    const saved = threadId;
    const second = await runtime.run('Do not use any tools. Return the word I asked you to remember as message, with status DONE, as JSON.',
      threadId, AbortSignal.timeout(80_000), async id => { assert.equal(id, saved); });
    assert.equal(second.message, 'marigold'); assert.equal(second.status, 'DONE');
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
