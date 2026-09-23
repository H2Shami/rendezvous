#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fixture 1.0'); process.exit(0); }
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const resumed = args.indexOf('resume');
const thread = resumed < 0 ? randomUUID() : args[resumed + 1];
const messages = JSON.parse(prompt.split('Incoming messages (JSON):\n')[1]);
const content = messages.at(-1)?.content ?? 'local answer';
const emit = value => console.log(JSON.stringify(value));
if (process.env.FIXTURE_LOG) appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ thread, args, prompt }) + '\n');
emit({ type: 'thread.started', thread_id: thread });
if (content === 'hang') {
  process.on('SIGTERM', () => { if (process.env.FIXTURE_LOG) appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ stopped: thread }) + '\n'); process.exit(0); });
  setInterval(() => {}, 1000);
} else {
  const result = { message: content.startsWith('reply:') ? null : `reply:${content}`,
    status: content === 'finish' ? 'DONE' : content === 'approval' ? 'NEEDS_USER' : 'ACTIVE' };
  emit({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) } });
  emit({ type: 'turn.completed' });
}
