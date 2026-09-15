import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexRuntime } from '../src/cli/runtime.js';

test('runtime subprocess parses output, rejects failures and terminates on timeout/abort', {
  skip: process.platform === 'win32', timeout: 10_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rendezvous-runtime-test-'));
  try {
    const executable = join(directory, 'fake-codex.mjs');
    await copyFile(new URL('./fixtures/codex-fake.mjs', import.meta.url), executable);
    await chmod(executable, 0o700);
    const runtime = new CodexRuntime(directory, 2000, executable);
    let thread: string | undefined;
    const result = await runtime.run('reply', undefined, new AbortController().signal, async id => { thread = id; });
    assert.equal(thread, 'fixture-thread'); assert.equal(result.message, 'fixture reply');
    await assert.rejects(runtime.run('invalid', undefined, new AbortController().signal, async () => {}));
    await assert.rejects(runtime.run('fail', undefined, new AbortController().signal, async () => {}), /Codex turn failed/);
    await assert.rejects(runtime.run('reply', 'wrong-thread', new AbortController().signal, async () => {}), /wrong thread/);
    const bounded = new CodexRuntime(directory, 100, executable);
    await assert.rejects(bounded.run('hang', undefined, new AbortController().signal, async () => {}), /interrupted|time limit/);
    await assert.rejects(runtime.run('hang', undefined, AbortSignal.timeout(100), async () => {}), /interrupted|time limit/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
