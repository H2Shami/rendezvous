import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executionEvents, displayText, harnessProgress, type ExecutionEvent } from '../src/cli/agent-events.js';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('diagnostics redact known secrets, neutralize terminal controls, and bound text', () => {
  const value = displayText('\x1b]52;c;clipboard\x07\x1b[31mhello\x1b[0m Bearer abcdefgh secretvalue ' + 'x'.repeat(5000), ['secretvalue']);
  assert.ok(!value.includes('\x1b') && !value.includes('clipboard') && !value.includes('abcdefgh') && !value.includes('secretvalue'));
  assert.ok(value.includes('hello')); assert.ok(value.length <= 4096);
});

test('slow and failing event observers do not block or fail the producer; queue is bounded', async () => {
  const seen: ExecutionEvent[] = []; let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const emit = executionEvents(async event => { seen.push(event); if (seen.length === 1) await blocked; }, { profile: 'a' });
  emit({ kind: 'connected' }); await tick();
  for (let i = 0; i < 10000; i++) emit({ kind: 'diagnostic', text: String(i) });
  await tick(); assert.equal(seen.length, 1);
  release(); for (let i = 0; i < 270; i++) await tick();
  assert.ok(seen.length <= 258); assert.ok(seen.some(e => e.kind === 'dropped'));
  let calls = 0;
  const failing = executionEvents(() => { calls++; if (calls === 1) throw new Error('display'); return Promise.reject(new Error('display')); });
  failing({ kind: 'connected' }); failing({ kind: 'closed' });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(calls, 2);
});

test('provider events expose supported public activity without dumping hidden or unknown fields', () => {
  assert.deepEqual(harnessProgress('codex', { type: 'item.completed', item: { type: 'reasoning', text: 'private' } }), []);
  assert.equal(harnessProgress('codex', { type: 'item.completed', item: { type: 'command_execution', command: 'ls', aggregated_output: 'file' } })[0].text, 'item.completed: ls\nfile');
  assert.equal(harnessProgress('claude', { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: 'private' }] } })[0].text, 'Started Read');
  assert.equal(harnessProgress('opencode', { type: 'tool_use', part: { tool: 'read', state: { status: 'completed' } } })[0].kind, 'tool');
  assert.deepEqual(harnessProgress('cursor', { type: 'unknown', secret: 'private' }), []);
});
