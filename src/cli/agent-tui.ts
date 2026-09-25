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
  chat: { sender: string; text: string; private: boolean; time: string; session?: string; mine: boolean }[] = [];
  room: string[] = [];
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
    const speakers: Partial<Record<ExecutionEvent['kind'], string>> = {
      local_input: 'You', local_reply: this.profile, local_directive: 'You · session instruction',
      received: 'Room', reply_sent: this.profile,
    };
    if (speakers[event.kind] && event.text) {
      this.chat.push({ sender: speakers[event.kind]!, text: displayText(event.text),
        private: event.kind === 'local_input' || event.kind === 'local_reply',
        mine: event.kind === 'local_input' || event.kind === 'local_directive',
        time: event.time.slice(11, 19), session: event.sessionId });
      if (this.chat.length > 200) this.chat.shift();
    }
    const line = displayText(eventLine(event));
    const target = ['received', 'reply_sent'].includes(event.kind) ? this.room : this.execution;
    target.push(line); if (target.length > 200) target.shift();
  }
  log(text: string) { this.execution.push(displayText(text)); if (this.execution.length > 200) this.execution.shift(); }
}
