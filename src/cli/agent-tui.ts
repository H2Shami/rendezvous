import { emitKeypressEvents } from 'node:readline';
import type { AgentControls } from './agent-controls.js';
import { displayText, eventLine, type ExecutionEvent, type EventObserver } from './agent-events.js';

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
  execution: string[] = [];
  state = 'Starting';
  listener = 'Starting';
  identity = '';
  server = '';
  session = 'none';
  thread = 'none';
  lastActivity = '';
  tab: 'room' | 'execution' = 'room';
  scroll = 0;
  constructor(readonly profile: string) {}
  add(event: Readonly<ExecutionEvent>) {
    if (event.agentId) this.identity = displayText(event.agentId);
    if (event.kind === 'connecting') { this.listener = 'Connecting'; this.server = displayText(event.text ?? ''); }
    if (event.kind === 'connected') this.listener = 'Online';
    if (event.kind === 'disconnected') this.listener = 'Offline';
    const previous = this.state;
    if (states[event.kind]) this.state = states[event.kind]!;
    if (event.kind === 'waiting_peer' && previous === states.silent) this.state = 'Processed / no reply; waiting for peer';
    if (event.sessionId) this.session = displayText(event.sessionId);
    if (event.threadId) this.thread = displayText(event.threadId);
    this.lastActivity = event.time.slice(11, 19);
    const line = displayText(eventLine(event));
    const target = ['received', 'reply_sent'].includes(event.kind) ? this.room : this.execution;
    target.push(line); if (target.length > 200) target.shift();
  }
  log(text: string) { this.execution.push(displayText(text)); if (this.execution.length > 200) this.execution.shift(); }
  render(columns: number, rows: number, input = '', question?: string) {
    const width = Math.max(1, Math.min(columns - 1, 240)), height = Math.max(1, rows);
    const clip = (s: string, n = width) => [...displayText(s)].slice(0, n).join('');
    const lines = (entries: string[], n: number, count: number) => {
      const wrapped = entries.flatMap(entry => entry.split('\n').flatMap(line => {
        const chars = [...line]; return Array.from({ length: Math.max(1, Math.ceil(chars.length / n)) }, (_, i) => chars.slice(i * n, (i + 1) * n).join(''));
      }));
      const end = Math.max(0, wrapped.length - this.scroll);
      const visible = wrapped.slice(Math.max(0, end - count), end);
      return [...Array(Math.max(0, count - visible.length)).fill(''), ...visible];
    };
    const header = [clip(`RENDEZVOUS | ${this.profile} | ${this.listener} | ${this.state}`), clip(`Agent: ${this.identity} | ${this.server.replace(/^Connecting to /, '')}`), clip(`Session: ${this.session} | Last activity: ${this.lastActivity || '-'}`), clip(`Harness thread: ${this.thread}`)];
    const available = Math.max(1, height - 9);
    let content: string[];
    if (width >= 100) {
      const half = Math.floor((width - 3) / 2);
      const left = lines(this.room, half, available), right = lines(this.execution, half, available);
      content = [clip('ROOM TRANSCRIPT'.padEnd(half) + ' | HARNESS EXECUTION'), ...left.map((line, i) => line.padEnd(half) + ' | ' + right[i])];
    } else {
      content = [clip(`Tab: ${this.tab === 'room' ? 'ROOM TRANSCRIPT' : 'HARNESS EXECUTION'} (Tab switches)`), ...lines(this.tab === 'room' ? this.room : this.execution, width, available)];
    }
    return [...header, ...content, clip(question ? `LOCAL INPUT: ${question}` : 'Tab: view | PgUp/PgDn: scroll | End: live | Ctrl+C: disconnect'),
      clip(question ? `> ${input}` : input || ':open UUID message | :close (confirmation required)'), clip(this.scroll ? `Scrolled back ${this.scroll} lines` : 'Live; commands are local, never room messages')].slice(0, height);
  }
}

export class AgentTui {
  readonly model: AgentTuiModel;
  private timer?: NodeJS.Timeout;
  private dirty = true;
  private writing = false;
  private stopped = false;
  private buffer = '';
  private controls?: AgentControls;
  private closing?: string;
  private commandBusy = false;
  private pending?: { question: string; resolve: (answer: string) => void; reject: (reason: unknown) => void; cleanup: () => void };
  private originalRaw: boolean;
  private originallyPaused: boolean;
  constructor(profile: string, private quit: () => void, private input = process.stdin, private output = process.stderr) {
    this.model = new AgentTuiModel(profile);
    this.originalRaw = !!input.isRaw; this.originallyPaused = input.readableFlowing !== true;
    emitKeypressEvents(input); input.setRawMode(true); input.resume();
    input.on('keypress', this.key); output.on('resize', this.resize);
    output.write('\x1b[?1049h\x1b[?25l\x1b[?7l');
    this.timer = setInterval(() => this.draw(), 80);
    this.draw();
  }
  events: EventObserver = event => { if (!this.stopped) { this.model.add(event); this.dirty = true; } };
  setControls = (controls?: AgentControls) => { this.controls = controls; };
  log = (text: string) => { this.model.log(text); this.dirty = true; };
  private resize = () => { this.dirty = true; };
  private draw() {
    if (!this.dirty || this.writing || this.stopped) return;
    this.dirty = false; this.writing = true;
    const screen = this.model.render(this.output.columns || 80, this.output.rows || 24, this.buffer, this.pending?.question);
    this.output.write('\x1b[H' + screen.map(line => '\x1b[2K' + line).join('\r\n') + '\x1b[J', () => { this.writing = false; });
  }
  private key = (text: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean }) => {
    if (key.ctrl && key.name === 'c') { this.quit(); return; }
    if (key.name === 'tab') this.model.tab = this.model.tab === 'room' ? 'execution' : 'room';
    else if (key.name === 'pageup') this.model.scroll = Math.min(10000, this.model.scroll + 10);
    else if (key.name === 'pagedown') this.model.scroll = Math.max(0, this.model.scroll - 10);
    else if (key.name === 'end') this.model.scroll = 0;
    else if (key.name === 'escape') { this.buffer = ''; this.closing = undefined; }
    else if (this.pending || this.controls) {
      if (key.name === 'return' && this.buffer.trim()) {
        const answer = this.buffer.trim(); this.buffer = '';
        if (answer.startsWith(':')) void this.command(answer);
        else if (this.pending) {
          const pending = this.pending; this.pending = undefined; pending.cleanup(); pending.resolve(answer);
        } else this.log('Use :open UUID message or :close. Local input is only accepted when the harness asks.');
      } else if (key.name === 'backspace') this.buffer = [...this.buffer].slice(0, -1).join('');
      else if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) this.buffer = (this.buffer + text).slice(0, 32768);
    }
    this.dirty = true;
  };
  private async command(text: string) {
    if (!this.controls) { this.log('Session controls are not available.'); return; }
    if (this.commandBusy) { this.log('A command is already in progress.'); return; }
    if (text === ':close') {
      this.closing = this.model.session;
      this.log(`Type :close yes to close session ${this.closing}. The listener will remain online.`); return;
    }
    this.commandBusy = true;
    try {
      if (text === ':close yes' && this.closing) {
        const session = this.closing; this.closing = undefined;
        await this.controls.close(session); this.log('Session close requested.');
      } else {
        const open = /^:open\s+(\S+)\s+([\s\S]+)$/.exec(text);
        if (!open) { this.log('Use :open UUID message or :close, then :close yes to confirm.'); return; }
        await this.controls.open(open[1], open[2]); this.log('Session opened; waiting for peer acceptance.');
      }
    } catch (error) { this.log(error instanceof Error ? error.message : 'Command failed.'); }
    finally { this.commandBusy = false; }
  }
  ask = async (_session: string, question: string | null, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (this.pending || this.stopped) throw new Error('Terminal input is unavailable.');
    return new Promise<string>((resolve, reject) => {
      const abort = () => { this.pending = undefined; this.buffer = ''; signal.removeEventListener('abort', abort); this.dirty = true; reject(signal.reason); };
      this.pending = { question: displayText(question ?? 'Harness requests your input'), resolve, reject, cleanup: () => signal.removeEventListener('abort', abort) };
      this.buffer = ''; this.dirty = true; signal.addEventListener('abort', abort, { once: true });
    });
  };
  stop() {
    if (this.stopped) return; this.stopped = true;
    clearInterval(this.timer);
    this.input.removeListener('keypress', this.key); this.output.removeListener('resize', this.resize);
    if (this.pending) { this.pending.cleanup(); this.pending.reject(new Error('Terminal closed')); this.pending = undefined; }
    this.input.setRawMode(this.originalRaw); if (this.originallyPaused) this.input.pause();
    this.output.write('\x1b[?7h\x1b[?25h\x1b[?1049l');
  }
}
