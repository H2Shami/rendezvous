#!/usr/bin/env node
import { basename } from 'node:path';
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fixture 1.0'); process.exit(0); }
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const agent = basename(process.argv[1]);
if (process.env.FIXTURE_LOG) appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ agent, args, prompt,
  transportSecret: process.env.RENDEZVOUS_TOKEN, nestedClaude: process.env.CLAUDECODE }) + '\n');
const resumeIndex = args.findIndex(v => ['resume', '--resume', '--session'].includes(v));
const id = resumeIndex >= 0 ? args[resumeIndex + 1] : `${agent}-thread`;
const thread = prompt === 'wrong' ? 'wrong-thread' : id;
const emit = event => console.log(JSON.stringify(event));
const reply = JSON.stringify({ message: 'fixture reply', status: 'ACTIVE' });
if (prompt === 'hang') { setInterval(() => {}, 1000); }
else if (prompt === 'fail') { emit({ type: 'error', is_error: true }); process.exitCode = 1; }
else if (agent === 'codex') {
  emit({ type: 'thread.started', thread_id: thread });
  emit({ type: 'item.completed', item: { type: 'agent_message', text: reply } });
  if (prompt !== 'incomplete') emit({ type: 'turn.completed' });
} else if (agent === 'opencode') {
  emit({ type: 'step_start', sessionID: thread });
  emit({ type: 'text', sessionID: thread, part: { text: reply } });
  if (prompt !== 'incomplete') emit({ type: 'step_finish', sessionID: thread, part: { reason: 'stop' } });
} else {
  emit({ type: 'system', subtype: 'init', session_id: thread });
  if (prompt !== 'incomplete') emit({ type: 'result', subtype: 'success', is_error: false,
    session_id: thread, result: prompt === 'invalid' ? 'not JSON' : reply,
    ...(agent === 'claude' && prompt !== 'invalid' ? { structured_output: JSON.parse(reply) } : {}) });
}
