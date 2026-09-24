import { displayText, eventLine, type ExecutionEvent } from './agent-events.js';

export function useTui(options: { noTui?: boolean; events?: boolean }, input = process.stdin, output = process.stderr, env = process.env) {
  return !options.noTui && !options.events && !!input.isTTY && !!output.isTTY && env.TERM !== 'dumb';
}

const states: Partial<Record<ExecutionEvent['kind'], string>> = {
  connecting: 'Connecting', connected: 'Online / waiting for a session', recovering: 'Recovering saved listener',
  disconnected: 'Disconnected', session: 'Session assigned', received: 'Message received',
  turn_started: 'Harness processing', waiting_peer: 'Waiting for peer', silent: 'Processed / no reply',
  waiting_user: 'Waiting for LOCAL input', reply_sending: 'Sending reply', reply_sent: 'Reply sent',
  closed: 'Session ended / listener remains online', error: 'Error / inspect execution view',
};

/** A bounded display model, independent of terminal I/O and execution state. */
export class AgentTuiModel {
  room: string[] = [];
  activity: string[] = [];
  execution: string[] = [];
  state = 'Starting';
  listener = 'Starting';
  identity = '';
  server = '';
  session = 'none';
  thread = 'none';
  lastActivity = '';
  constructor(readonly profile: string) {}
  add(event: Readonly<ExecutionEvent>) {
    if (event.agentId) this.identity = displayText(event.agentId);
    if (event.kind === 'connecting') { this.listener = 'Connecting'; this.server = displayText(event.text ?? ''); }
    if (event.kind === 'connected') this.listener = 'Online';
    if (event.kind === 'disconnected') this.listener = 'Offline';
    if (event.scope === 'local' && event.kind === 'turn_finished') this.state = 'Ready for private input';
    const previous = this.state;
    if (states[event.kind]) this.state = states[event.kind]!;
    if (event.kind === 'waiting_peer' && previous === states.silent) this.state = 'Processed / no reply; waiting for peer';
    if (event.kind === 'closed') this.session = 'none';
    if (event.sessionId && event.kind !== 'closed') this.session = displayText(event.sessionId);
    if (event.threadId) this.thread = displayText(event.threadId);
    this.lastActivity = event.time.slice(11, 19);
    const label: Partial<Record<ExecutionEvent['kind'], string>> = { received: 'Peer / room → harness', local_input: 'You → harness (private)', local_directive: 'You → session harness (reply may be shared)', local_reply: 'Agent → you (private)', reply_sent: 'Agent → room', turn_started: 'Harness working', assistant: 'Assistant', tool: 'Tool', diagnostic: 'Diagnostic', waiting_peer: 'Waiting for peer', thread: 'Harness thread' };
    const activity = `${event.time.slice(11, 19)} ${event.scope === 'local' ? '[private] ' : ''}${label[event.kind] ?? event.kind}${event.text ? '\n' + displayText(event.text) : ''}`;
    this.activity.push(activity); if (this.activity.length > 200) this.activity.shift();
    const line = displayText(eventLine(event));
    const target = ['received', 'reply_sent'].includes(event.kind) ? this.room : this.execution;
    target.push(line); if (target.length > 200) target.shift();
  }
  log(text: string) { this.execution.push(displayText(text)); if (this.execution.length > 200) this.execution.shift(); }
}
