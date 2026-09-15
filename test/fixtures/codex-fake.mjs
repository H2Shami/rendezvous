#!/usr/bin/env node
// Protocol fixture only; never runs a model or executes the prompt.
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
if (prompt === 'hang') {
  setInterval(() => {}, 1000);
} else if (prompt === 'invalid') {
  console.log('not JSON');
} else if (prompt === 'fail') {
  console.log(JSON.stringify({ type: 'turn.failed' }));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fixture-thread' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ message: 'fixture reply', status: 'ACTIVE' }) } }));
  console.log(JSON.stringify({ type: 'turn.completed' }));
}
