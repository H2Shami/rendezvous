import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

export function contextId(env = process.env) {
  const value = env.CODEX_THREAD_ID ? `codex:${env.CODEX_THREAD_ID}`
    : env.TMUX_PANE && env.TMUX ? `tmux:${env.TMUX}:${env.TMUX_PANE}` : null;
  return value ? createHash('sha256').update(value).digest('hex').slice(0, 24) : null;
}
export function defaultState(command, env = process.env) {
  const context = contextId(env);
  if (command === 'create') return resolve(`.rendezvous/owner-${randomUUID()}.json`);
  if (context) return resolve(`.rendezvous/agent-${context}.json`);
  if (['connect', 'join'].includes(command)) return resolve(`.rendezvous/agent-${randomUUID()}.json`);
  throw new Error('Provide --state with the private path printed when you joined. There is no shared default identity.');
}
export function checkContext(state, context, adopt = false) {
  if (state.client_context && state.client_context !== context && !adopt) {
    throw new Error('STATE_CONTEXT_MISMATCH: This private identity belongs to another agent session. Join with a new --state path. Use --adopt-state only to deliberately take over that identity.');
  }
  return adopt ? context : state.client_context || context;
}
