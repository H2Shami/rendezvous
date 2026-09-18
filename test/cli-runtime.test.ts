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

import { agentArguments, createRuntime } from '../src/cli/runtime.js';
import { AGENTS } from '../src/cli/config.js';

test('each agent adapter starts, resumes exact IDs, validates results, and stops failed turns', {
  skip: process.platform === 'win32', timeout: 10000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rendezvous-adapters-'));
  try {
    for (const agent of AGENTS) {
      const executable = join(directory, agent);
      await copyFile(new URL('./fixtures/agent-fake.mjs', import.meta.url), executable);
      await chmod(executable, 0o700);
      const runtime = createRuntime(agent, directory, 1500, executable);
      let id: string | undefined;
      assert.equal((await runtime.run('reply', undefined, new AbortController().signal, async value => { id = value; })).message, 'fixture reply');
      assert.equal(id, `${agent}-thread`);
      assert.equal((await runtime.run('reply', id, new AbortController().signal, async () => {})).status, 'ACTIVE');
      await assert.rejects(runtime.run('wrong', 'requested-session', new AbortController().signal, async () => {}), /wrong thread/);
      await assert.rejects(runtime.run('fail', id, new AbortController().signal, async () => {}), /failed/);
      await assert.rejects(runtime.run('incomplete', id, new AbortController().signal, async () => {}), /failed/);
      await assert.rejects(runtime.run('hang', id, AbortSignal.timeout(100), async () => {}), /interrupted/);
      const args = agentArguments(agent, '/tmp/schema', 'exact-id');
      assert.ok(args.includes('exact-id'));
      assert.ok(!args.includes('--last') && !args.includes('--continue') && !args.includes('--force'));
    }
    assert.ok(agentArguments('claude', '/tmp/schema').includes('dontAsk'));
    assert.ok(agentArguments('cursor', '/tmp/schema').includes('ask'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
