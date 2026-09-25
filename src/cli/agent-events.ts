import { stripVTControlCharacters } from 'node:util';

export type EventKind = 'connecting' | 'connected' | 'recovering' | 'disconnected' | 'session' | 'received' |
  'turn_started' | 'thread' | 'assistant' | 'tool' | 'diagnostic' | 'turn_finished' | 'reply_sending' |
  'reply_sent' | 'silent' | 'waiting_peer' | 'waiting_user' | 'local_input' | 'local_reply' | 'local_directive' | 'closed' | 'error' | 'dropped';
export interface ExecutionEvent {
  scope?: 'local'; kind: EventKind; time: string; profile?: string; agentId?: string; harness?: string;
  sessionId?: string; bindingId?: string; threadId?: string; turnId?: string;
  sequence?: number; text?: string;
}
export type EventInput = Omit<ExecutionEvent, 'time'>;
export type EventObserver = (event: Readonly<ExecutionEvent>) => void | Promise<void>;
export type EventSink = (event: EventInput) => void;

/** Display-only data. Never feed this redacted/truncated copy back into a harness or journal. */
export function displayText(value: string, secrets: readonly string[] = []) {
  let text = value;
  for (const secret of secrets) if (secret.length >= 8) text = text.replaceAll(secret, '[redacted]');
  text = text.replace(/agk_[0-9a-f-]{36}\.[A-Za-z0-9_-]+/gi, '[redacted agent key]')
    .replace(/\b(Bearer\s+)\S+/gi, '$1[redacted]')
    .replace(/\b(sk[-_]|sk_live_|sk_test_)[A-Za-z0-9_-]{12,}/g, '[redacted key]');
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 4096);
}

/** Best-effort bounded diagnostics. A pending/failing observer never blocks execution. */
export function executionEvents(observer?: EventObserver, context: Partial<EventInput> = {}, secrets: readonly string[] = []) {
  const queue: ExecutionEvent[] = [];
  let scheduled = false, pending = false, dropped = 0;
  const schedule = () => { if (!scheduled && !pending) { scheduled = true; setImmediate(drain); } };
  const drain = () => {
    scheduled = false;
    if (!observer || pending) return;
    const event = queue.shift();
    if (!event) return;
    try {
      const result = observer(Object.freeze(event));
      if (result && typeof result.then === 'function') {
        pending = true;
        void Promise.resolve(result).catch(() => {}).finally(() => { pending = false; schedule(); });
      }
    } catch { /* Diagnostics cannot fail a model turn or transport operation. */ }
    if (dropped && queue.length < 256) {
      queue.push({ kind: 'dropped', time: new Date().toISOString(), text: `${dropped} diagnostic events omitted (slow display).` }); dropped = 0;
    }
    if (queue.length) schedule();
  };
  const emit: EventSink = event => {
    if (!observer) return;
    if (queue.length >= 256) { dropped++; return; }
    const raw = { ...context, ...event, time: new Date().toISOString() };
    const safe = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, typeof value === 'string' ? displayText(value, secrets) : value])) as unknown as ExecutionEvent;
    queue.push(safe); schedule();
  };
  return emit;
}

export function eventLine(event: Readonly<ExecutionEvent>) {
  return `${event.time.slice(11, 19)} ${event.sessionId ? `[${event.sessionId.slice(0, 8)}] ` : ''}${event.kind}${event.sequence !== undefined ? ` #${event.sequence}` : ''}${event.text ? `: ${event.text}` : ''}`;
}

/** Only explicitly supported public execution fields; never dump raw provider events. */
export function harnessProgress(agent: string, event: any): EventInput[] {
  if (agent === 'codex') {
    const item = event.item;
    if (!item || !['item.started', 'item.completed', 'item.updated'].includes(event.type)) return [];
    if (item.type === 'command_execution') return [{ kind: 'tool', text: `${event.type}: ${item.command ?? 'command'}${typeof item.aggregated_output === 'string' && event.type === 'item.completed' ? `\n${item.aggregated_output}` : ''}` }];
    if (item.type === 'mcp_tool_call') return [{ kind: 'tool', text: `${event.type}: ${item.server ?? 'MCP'}/${item.tool ?? 'tool'}` }];
    if (item.type === 'agent_message' && event.type === 'item.completed') return [{ kind: 'assistant', text: item.text }];
  } else if (agent === 'claude' || agent === 'cursor') {
    if (event.type === 'assistant' && Array.isArray(event.message?.content)) return event.message.content.flatMap((part: any) =>
      part.type === 'text' && typeof part.text === 'string' ? [{ kind: 'assistant', text: part.text }] :
      part.type === 'tool_use' ? [{ kind: 'tool', text: `Started ${part.name ?? 'tool'}` }] : []);
    if (event.type === 'user' && Array.isArray(event.message?.content)) return event.message.content.filter((part: any) => part.type === 'tool_result')
      .map((part: any) => ({ kind: 'tool', text: `${part.is_error ? 'Failed' : 'Finished'} tool ${part.tool_use_id ?? ''}` }));
  } else if (agent === 'opencode') {
    if (event.type === 'text' && typeof event.part?.text === 'string') return [{ kind: 'assistant', text: event.part.text }];
    if (event.type === 'tool_use') return [{ kind: 'tool', text: `${event.part?.state?.status ?? 'Activity'}: ${event.part?.tool ?? 'tool'}` }];
  }
  return [];
}
