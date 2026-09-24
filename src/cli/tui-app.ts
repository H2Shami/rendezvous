import { fork, type ChildProcess } from 'node:child_process';
import { emitKeypressEvents } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { colorEnabled } from './ui.js';
import { listProfiles, type AgentProfile } from './profiles.js';
import { ownedRooms, readConfig, type Config, type LocalRoom } from './config.js';
import { displayText, type ExecutionEvent } from './agent-events.js';
import { AgentTuiModel } from './agent-tui.js';
import { palette as p, TuiScreen } from './tui-screen.js';
import { tuiActions, type TuiAction } from './tui-actions.js';

interface Prompt { id: string; label: string; hint: string; secret: boolean; defaultValue?: string }
interface Job { id: string; title: string; child: ChildProcess; model: AgentTuiModel; output: string[]; running: boolean; code?: number | null; prompt?: Prompt; controls?: boolean }
type View = 'home' | 'agents' | 'rooms' | 'settings' | 'jobs' | 'job';
interface Form { action: TuiAction; values: Record<string, string>; field: number; job?: string; session?: string }
const nav: { id: View; title: string; hint: string }[] = [
  { id: 'home', title: 'Home', hint: 'Overview' }, { id: 'agents', title: 'Agents', hint: 'Saved identities' },
  { id: 'rooms', title: 'Rooms', hint: 'Create & join' }, { id: 'jobs', title: 'Active work', hint: 'Listeners & results' }, { id: 'settings', title: 'Settings', hint: 'Harness & server' },
];

/** Full CLI workspace. Commands run through the existing CLI over private IPC. */
export class RendezvousTui {
  view: View = 'home';
  profiles: AgentProfile[] = [];
  rooms: LocalRoom[] = [];
  config: Config = {};
  jobs: Job[] = [];
  selectedJob?: string;
  pane: 'conversation' | 'execution' | 'output' = 'conversation';
  selected = 0;
  input = '';
  paletteOpen = false;
  form?: Form;
  notice = '';
  scroll = 0;
  private timer?: NodeJS.Timeout;
  private dirty = true;
  private writing = false;
  private closing = false;
  private oldRaw = false;
  private wasFlowing = false;
  private done!: () => void;
  private secrets = Object.entries(process.env).filter(([key]) => /secret|token|password|api.?key/i.test(key)).map(([, value]) => value!).filter(Boolean);
  constructor(private entry: string, private stdin = process.stdin, private stderr = process.stderr) {}
  private safe = (value: string) => displayText(value, this.secrets);
  private job() { return this.jobs.find(job => job.id === this.selectedJob); }
  private changed() { this.dirty = true; }
  async refresh() {
    const results = await Promise.allSettled([listProfiles(), ownedRooms(), readConfig()]);
    if (results[0].status === 'fulfilled') this.profiles = results[0].value;
    if (results[1].status === 'fulfilled') this.rooms = results[1].value;
    if (results[2].status === 'fulfilled') this.config = results[2].value;
    if (results.some(r => r.status === 'rejected')) this.notice = 'Some saved data could not be read. Use command reference or inspect your local config.';
    this.changed();
  }
  async run(initial?: string[]) {
    await this.refresh();
    this.oldRaw = !!this.stdin.isRaw; this.wasFlowing = this.stdin.readableFlowing === true;
    emitKeypressEvents(this.stdin); this.stdin.setRawMode(true); this.stdin.resume();
    this.stdin.on('keypress', this.key); this.stderr.on('resize', this.resize);
    process.once('SIGINT', this.requestQuit); process.once('SIGTERM', this.requestQuit);
    this.stderr.write('\x1b[?1049h\x1b[?25l\x1b[?7l');
    this.timer = setInterval(() => this.draw(), 80);
    try {
      const done = new Promise<void>(resolve => { this.done = resolve; });
      if (initial?.length) this.launch(initial);
      this.draw(); await done;
    } finally {
      clearInterval(this.timer); this.stdin.removeListener('keypress', this.key); this.stderr.removeListener('resize', this.resize);
      process.removeListener('SIGINT', this.requestQuit); process.removeListener('SIGTERM', this.requestQuit);
      this.stdin.setRawMode(this.oldRaw); if (!this.wasFlowing) this.stdin.pause();
      this.stderr.write('\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l');
    }
  }
  private resize = () => this.changed();
  private requestQuit = () => { process.exitCode = 130; void this.quit(); };
  private async quit() {
    if (this.closing) return; this.closing = true;
    this.notice = 'Stopping active work and releasing listeners…'; this.changed();
    await Promise.all(this.jobs.filter(job => job.running).map(job => new Promise<void>(resolve => {
      job.child.once('close', () => resolve()); job.child.kill('SIGTERM');
    })));
    this.done();
  }
  launch(args: string[]) {
    if (this.closing) return;
    if (this.jobs.filter(job => job.running).length >= 8) { this.notice = 'Stop a process before starting more work (8 active processes maximum).'; return; }
    const child = fork(this.entry, args, { execArgv: process.execArgv.filter(arg => !arg.startsWith('--test')),
      env: { ...process.env, RENDEZVOUS_TUI_CHILD: '1', NO_COLOR: '1', FORCE_COLOR: '0' }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    child.stdin!.end();
    const title = args[0] === 'agent' ? `Agent ${args[1]}${args[2] ? ` · ${args[2]}` : ''}` : `${args[0] === '--version' ? 'Version' : args[0]}`;
    const job: Job = { id: randomUUID(), title: this.safe(title), child, model: new AgentTuiModel(args[0] === 'agent' ? args[2] ?? 'Agent' : 'Room'), output: [], running: true };
    this.jobs.push(job); if (this.jobs.length > 30) { const i = this.jobs.findIndex(j => !j.running); if (i >= 0) this.jobs.splice(i, 1); }
    this.selectedJob = job.id; this.view = 'job'; this.pane = args.includes('start') || args[0] === 'join' || args[0] === 'create' && !args.includes('--no-join') ? 'execution' : 'output';
    this.input = ''; this.scroll = 0;
    const append = (text: string) => { job.output.push(this.safe(text)); job.model.log(this.safe(text)); if (job.output.length > 250) job.output.shift(); this.changed(); };
    for (const stream of [child.stdout!, child.stderr!]) {
      stream.setEncoding('utf8'); let carry = '';
      stream.on('data', (chunk: string) => {
        const lines = (carry + chunk).split('\n'); carry = lines.pop()!.slice(-8192);
        for (const line of lines) append(line);
      });
      stream.on('end', () => { if (carry) append(carry); });
    }
    child.on('message', (message: any) => {
      if (message?.type === 'event' && message.event && typeof message.event.kind === 'string' && typeof message.event.time === 'string') {
        const event = message.event as ExecutionEvent;
        job.model.add({ ...event, ...(event.text ? { text: this.safe(event.text) } : {}) });
      } else if (message?.type === 'prompt' && typeof message.id === 'string' && typeof message.label === 'string') {
        job.prompt = { id: message.id, label: this.safe(message.label), hint: this.safe(message.hint ?? ''), secret: !!message.secret, defaultValue: message.defaultValue };
        // A background request is announced, never allowed to steal typed input.
        this.notice = `${job.title} needs your input. Select its process to answer.`;
      } else if (message?.type === 'prompt_done' && job.prompt?.id === message.id) { job.prompt = undefined; if (this.selectedJob === job.id && !this.form && !this.paletteOpen) this.input = ''; }
      else if (message?.type === 'controls') job.controls = !!message.available;
      else if (message?.type === 'control_result') this.notice = message.ok ? 'Action completed.' : this.safe(message.error ?? 'Action failed.');
      this.changed();
    });
    child.on('error', error => append(`Could not start: ${error.message}`));
    child.on('close', code => {
      job.running = false; job.code = code; job.prompt = undefined;
      append(code === 0 ? 'Completed.' : code === 130 ? 'Disconnected.' : `Process exited (${code ?? 'signal'}).`);
      void this.refresh();
    });
    this.changed();
  }
  private selectView(view: View) { this.view = view; this.selected = 0; this.input = ''; this.form = undefined; this.paletteOpen = false; this.scroll = 0; this.changed(); }
  private actions() { const query = this.input.replace(/^\//, '').toLowerCase(); return tuiActions.filter(a => `${a.id} ${a.title} ${a.description}`.toLowerCase().includes(query)); }
  activate(action: TuiAction, values: Record<string, string> = {}) {
    this.paletteOpen = false; this.input = ''; this.selected = 0; this.notice = '';
    if (nav.some(n => n.id === action.id)) { this.selectView(action.id as View); return; }
    const job = this.job();
    if (action.id === 'quit' || action.id === 'stop' || action.id === 'close') {
      if (action.id !== 'quit' && !job?.running) { this.notice = 'Select a running process first.'; this.changed(); return; }
      if (action.id === 'close' && (!job?.controls || job.model.session === 'none')) { this.notice = 'Select an online agent with an active conversation.'; this.changed(); return; }
      this.form = { action: { ...action, fields: [{ key: 'confirm', label: action.id === 'quit' ? 'Stop active work and quit? Type yes' : `Confirm ${action.id} for ${job!.title}. Type yes`, required: true }] }, values: {}, field: 0, job: job?.id, session: job?.model.session };
    } else if (action.fields) {
      this.form = { action, values: Object.fromEntries(action.fields.map(field => [field.key, values[field.key] ?? (field.key === 'agent' ? this.config.agent : undefined) ?? field.initial ?? ''])), field: 0, job: job?.id };
    } else if (action.command) this.launch(action.command({}));
    this.changed();
  }
  private submit() {
    const form = this.form!;
    const missing = form.action.fields!.findIndex(field => field.required && !form.values[field.key]?.trim());
    if (missing >= 0) { form.field = missing; this.notice = 'Complete the highlighted field.'; return; }
    try {
      const { action, values } = form;
      const job = this.jobs.find(j => j.id === form.job);
      if (['quit', 'stop', 'close'].includes(action.id)) {
        if (values.confirm?.toLowerCase() !== 'yes') { this.notice = 'Type yes to confirm, or Esc to cancel.'; return; }
        if (action.id === 'quit') void this.quit();
        else if (!job?.running) throw new Error('That process is no longer running.');
        else if (action.id === 'stop') job.child.kill('SIGTERM');
        else if (!job.controls) throw new Error('The listener is reconnecting; try again when online.');
        else job.child.send({ type: 'control', id: randomUUID(), action: 'close', sessionId: form.session });
      } else if (action.id === 'open') {
        if (!job?.running || !job.controls) throw new Error('Select a running agent listener first.');
        job.child.send({ type: 'control', id: randomUUID(), action: 'open', peer: values.peer, message: values.message });
      } else this.launch(action.command!(values));
      this.form = undefined;
    } catch (error) { this.notice = this.safe(error instanceof Error ? error.message : 'Action failed.'); }
    this.changed();
  }
  private key = (text: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }) => {
    if (this.closing) return;
    if (key.ctrl && key.name === 'c') { this.requestQuit(); return; }
    if (key.ctrl && key.name === 'p') { this.paletteOpen = !this.paletteOpen; this.form = undefined; this.input = ''; this.selected = 0; this.changed(); return; }
    if (key.name === 'escape') { this.form = undefined; this.paletteOpen = false; this.input = ''; this.notice = ''; this.changed(); return; }
    if (this.form) {
      const fields = this.form.action.fields!, field = fields[this.form.field];
      if (key.name === 'tab' || key.name === 'down' || key.name === 'up') this.form.field = (this.form.field + (key.name === 'up' || key.shift ? -1 : 1) + fields.length) % fields.length;
      else if (key.ctrl && key.name === 'u') this.form.values[field.key] = '';
      else if (key.name === 'return') { if (this.form.field === fields.length - 1 || key.ctrl) this.submit(); else this.form.field++; }
      else if (field.choices && (key.name === 'left' || key.name === 'right' || text === ' ')) {
        const i = field.choices.indexOf(this.form.values[field.key]); this.form.values[field.key] = field.choices[(i + (key.name === 'left' ? field.choices.length - 1 : 1)) % field.choices.length];
      } else if (!field.choices && key.name === 'backspace') this.form.values[field.key] = [...this.form.values[field.key]].slice(0, -1).join('');
      else if (!field.choices && !key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) this.form.values[field.key] = ((this.form.values[field.key] ?? '') + text).slice(0, 32768);
    } else if (this.paletteOpen) {
      const actions = this.actions();
      if (key.name === 'down') this.selected = Math.min(actions.length - 1, this.selected + 1);
      else if (key.name === 'up') this.selected = Math.max(0, this.selected - 1);
      else if (key.name === 'return' && actions[this.selected]) this.activate(actions[this.selected]);
      else if (key.name === 'backspace') { this.input = [...this.input].slice(0, -1).join(''); this.selected = 0; }
      else if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) { this.input += text; this.selected = 0; }
    } else if (this.view === 'job' && this.job()?.prompt) {
      const job = this.job()!;
      if (key.name === 'return' && (this.input.trim() || job.prompt!.defaultValue)) {
        const value = this.input.trim() || job.prompt!.defaultValue!;
        if (job.prompt!.secret) this.secrets.push(value);
        job.child.send({ type: 'answer', id: job.prompt!.id, value }); this.input = '';
      } else if (key.name === 'backspace') this.input = [...this.input].slice(0, -1).join('');
      else if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) this.input = (this.input + text).slice(0, 32768);
    } else if (text === '/') { this.paletteOpen = true; this.input = ''; this.selected = 0; }
    else if (key.name === 'tab' && this.view === 'job') { this.pane = this.pane === 'conversation' ? 'execution' : this.pane === 'execution' ? 'output' : 'conversation'; this.scroll = 0; }
    else if (key.name === 'pageup') this.scroll = Math.min(10000, this.scroll + 8);
    else if (key.name === 'pagedown') this.scroll = Math.max(0, this.scroll - 8);
    else if (key.name === 'end') this.scroll = 0;
    else if (key.name === 'up') this.selected = Math.max(0, this.selected - 1);
    else if (key.name === 'down') this.selected++;
    else if (key.name === 'return') this.openSelected();
    else if (text && /^[1-5]$/.test(text)) this.selectView(nav[Number(text) - 1].id);
    else if (text === 'n') this.activate(tuiActions.find(a => a.id === (this.view === 'agents' ? 'setup' : this.view === 'rooms' ? 'create' : 'start'))!);
    this.changed();
  };
  private openSelected() {
    if (this.view === 'agents' && this.profiles.length) this.activate(tuiActions.find(a => a.id === 'start')!, { profile: this.profiles[this.selected % this.profiles.length].name });
    else if (this.view === 'rooms' && this.rooms.length) this.activate(tuiActions.find(a => a.id === 'join')!, { room: this.rooms[this.selected % this.rooms.length].session_id });
    else if (this.view === 'jobs' && this.jobs.length) { this.selectedJob = this.jobs[this.selected % this.jobs.length].id; this.view = 'job'; this.pane = 'execution'; this.input = ''; this.scroll = 0; }
    else if (this.view === 'settings') this.activate(tuiActions.find(a => a.id === (this.selected % 2 ? 'config-server' : 'config-agent'))!);
    else if (this.view === 'home') this.activate(tuiActions.find(a => a.id === ['start', 'setup', 'create', 'join'][this.selected % 4])!);
  }
  render(columns: number, rows: number, color = true) {
    const width = Math.max(1, Math.min(columns - 1, 240)), height = Math.max(1, rows);
    const s = new TuiScreen(width, height), sidebar = width >= 95 ? 25 : 0, x = sidebar + 3, mainWidth = width - x - 3;
    if (width < 45 || height < 20) { s.text(0, 0, 'rendezvous', p.primary, true); s.text(0, 2, 'Enlarge terminal to 46 × 20.', p.secondary); s.text(0, 4, 'Ctrl+C quits safely.', p.muted); return s.lines(color); }
    s.rect(0, 0, width, 3, p.panel); s.text(2, 1, '●', p.primary, true); s.text(4, 1, 'rendezvous', p.text, true);
    s.text(17, 1, `/ ${this.view === 'job' ? this.job()?.title ?? 'Execution' : nav.find(n => n.id === this.view)?.title}`, p.muted, false, width - 41);
    if (width > 65) s.text(width - 22, 1, 'ctrl+p  commands', p.secondary);
    if (sidebar) {
      s.rect(0, 3, sidebar, height - 5, p.panel); s.text(3, 5, 'WORKSPACE', p.muted);
      nav.forEach((item, i) => {
        const active = item.id === this.view || item.id === 'jobs' && this.view === 'job';
        if (active) { s.rect(1, 7 + i * 2, sidebar - 2, 1, p.raised); s.text(1, 7 + i * 2, '▌', p.primary, true); }
        s.text(3, 7 + i * 2, `${i + 1}  ${item.title}`, active ? p.secondary : p.muted, active);
      });
      if (height >= 34) { s.text(3, 20, 'YOUR NETWORK', p.muted); s.text(3, 22, `${this.profiles.length} saved agents`, p.secondary);
      s.text(3, 24, `${this.jobs.filter(j => j.running).length} running processes`, p.secondary); }
      s.text(3, height - 5, this.config.agent ?? 'codex', p.text); s.text(3, height - 4, '● local workspace', p.muted);
    }
    if (this.view === 'home') {
      const center = x + Math.max(0, Math.floor((mainWidth - 48) / 2));
      s.text(center, 5, '╭─╮ ╭─╮ ╭─╮', p.primary, true, mainWidth);
      s.text(center, 6, '╰─╯─╰─╯─╰─╯   rendezvous', p.primary, true, mainWidth);
      s.text(center, 8, 'Good work happens in good company.', p.text, true, mainWidth);
      s.text(center, 10, 'Connect your agents. Follow the conversation.', p.muted, false, mainWidth);
      s.rect(x, 13, mainWidth, 3, p.panel); s.text(x, 13, '▌', p.primary); s.text(x + 2, 14, 'What would you like to do?  / commands', p.secondary, false, mainWidth - 4);
      const cards = [['Start an agent', 'Bring a saved identity online'], ['Set up an agent', 'Connect a new profile'], ['Create a room', 'Invite agents to collaborate'], ['Join a room', 'Continue a conversation']];
      cards.forEach(([title, detail], i) => { const y = (height < 30 ? 16 : 18) + i * (height < 30 ? 1 : 2); if (this.selected % 4 === i) s.text(x, y, '›', p.primary, true); s.text(x + 2, y, title, p.secondary, true); if (mainWidth > 60) s.text(x + 24, y, detail, p.muted, false, mainWidth - 24); });
    } else if (this.view === 'job') {
      const job = this.job();
      s.text(x, 5, job?.title ?? 'No process selected', p.text, true, mainWidth);
      if (job?.model.identity) s.text(x, 6, `${job.model.identity} · ${job.model.server.replace(/^Connecting to /, '')}`, p.muted, false, mainWidth);
      s.text(x, 7, job?.running ? job.model.state : job?.code === 0 ? 'Completed' : 'Stopped', job?.running ? p.secondary : p.muted, false, mainWidth);
      if (job && mainWidth > 55) s.text(x + 30, 7, `Session ${job.model.session.slice(0, 8)} · thread ${job.model.thread.slice(0, 12)}`, p.muted, false, mainWidth - 30);
      s.text(x, 9, ['conversation', 'execution', 'output'].map(tab => tab === this.pane ? `[ ${tab} ]` : `  ${tab}  `).join('  '), p.secondary, false, mainWidth);
      const entries = job ? this.pane === 'conversation' ? job.model.room : this.pane === 'execution' ? job.model.execution : job.output : [];
      const visible: string[] = [];
      for (const entry of entries) for (const line of entry.split('\n')) {
        const chars = [...line]; for (let i = 0; i < Math.max(1, chars.length); i += Math.max(1, mainWidth - 4)) visible.push(chars.slice(i, i + mainWidth - 4).join(''));
      }
      const count = Math.max(1, height - 19), end = Math.max(0, visible.length - this.scroll);
      s.rect(x, 11, mainWidth, count + 1, p.panel);
      visible.slice(Math.max(0, end - count), end).forEach((line, i) => s.text(x + 2, 12 + i, line, this.pane === 'execution' ? p.muted : p.text, false, mainWidth - 4));
      if (!entries.length) s.text(x + 2, 12, 'Waiting for activity…', p.muted, false, mainWidth - 4);
      const prompt = job?.prompt;
      s.rect(x, height - 6, mainWidth, 3, p.raised); s.text(x, height - 6, '▌', p.primary);
      s.text(x + 2, height - 6, prompt ? `${prompt.secret ? 'PRIVATE · ' : ''}${prompt.label}` : 'COMMANDS', p.secondary, true, mainWidth - 4);
      s.text(x + 2, height - 5, prompt ? (prompt.secret ? '•'.repeat(Math.min(40, this.input.length)) : this.input) || prompt.defaultValue || 'Type your answer, then Enter…' : '/ open · close · stop · switch processes', prompt ? p.text : p.muted, false, mainWidth - 4);
      if (prompt) s.text(x + 2, height - 4, prompt.hint, p.muted, false, mainWidth - 4);
    } else {
      const heading = nav.find(n => n.id === this.view)!; s.text(x, 5, heading.title, p.text, true); s.text(x, 7, heading.hint, p.muted);
      const entries = this.view === 'agents' ? this.profiles.map(a => [a.name, `${a.agent} · ${a.origin}`, a.agentId])
        : this.view === 'rooms' ? this.rooms.map(r => [r.session_id, r.invite_url.split('/').slice(0, 3).join('/'), `Expires ${r.expires_at}`])
        : this.view === 'jobs' ? this.jobs.map(j => [j.title, j.running ? j.model.state : `Finished · ${j.code ?? 'signal'}`, j.prompt ? 'Needs local input' : j.model.session])
        : [['Default harness', this.config.agent ?? 'codex', 'Used when a command does not choose a harness'], ['Default server', this.config.server ?? 'https://dev.userendezvous.com', 'Command overrides remain available']];
      if (!entries.length) { s.text(x, 11, 'Nothing here yet.', p.secondary, true); s.text(x, 13, 'Press / to get started.', p.muted); }
      const selected = entries.length ? this.selected % entries.length : 0, page = Math.max(1, Math.floor((height - 14) / 4));
      const start = Math.floor(selected / page) * page;
      entries.slice(start, start + page).forEach(([title, detail, meta], i) => { const y = 10 + i * 4, active = start + i === selected; s.rect(x, y, mainWidth, 3, active ? p.raised : p.panel); if (active) s.text(x, y, '▌', p.primary); s.text(x + 2, y, title, active ? p.secondary : p.text, true, mainWidth - 4); s.text(x + 2, y + 1, detail, p.muted, false, mainWidth - 4); s.text(x + 2, y + 2, meta, p.muted, false, mainWidth - 4); });
    }
    s.rect(0, height - 2, width, 2, p.panel);
    s.text(2, height - 2, this.notice || (sidebar ? '↑↓ select   enter open   n new   / commands   tab view' : '1 home  2 agents  3 rooms  4 work  5 settings  / commands'), this.notice ? p.secondary : p.muted, false, width - 4);
    s.text(2, height - 1, this.closing ? 'Disconnecting…' : 'ctrl+p command palette                              ctrl+c quit', p.muted, false, width - 4);
    if (this.paletteOpen || this.form) this.modal(s, width, height);
    return s.lines(color);
  }
  private modal(s: TuiScreen, width: number, height: number) {
    const w = Math.min(76, width - 4), x = Math.floor((width - w) / 2), y = 3, h = height - 6;
    s.rect(x, y, w, h, p.raised); s.text(x, y, '▌', p.primary, true);
    if (this.form) {
      const { action, values, field: focused } = this.form, fields = action.fields!;
      s.text(x + 2, y + 1, action.title, p.secondary, true, w - 4);
      s.text(x + 2, y + 2, action.description, p.muted, false, w - 4);
      const page = Math.max(1, Math.floor((h - 7) / 3)), first = Math.floor(focused / page) * page;
      fields.slice(first, first + page).forEach((field, i) => {
        const active = first + i === focused, row = y + 4 + i * 3;
        s.text(x + 2, row, `${field.label}${field.required ? ' *' : ''}`, active ? p.secondary : p.muted, active, w - 4);
        s.rect(x + 2, row + 1, w - 4, 1, active ? p.background : p.panel);
        s.text(x + 3, row + 1, `${active ? '› ' : ''}${[...(values[field.key] || '…')].slice(-Math.max(1, w - 14)).join('')}${active ? field.choices ? '   ‹  ›' : '▏' : ''}`, p.text, false, w - 6);
      });
      s.text(x + 2, y + h - 2, 'tab next · ←→ choose · ctrl+u clear · enter continue / submit', p.secondary, false, w - 4);
      s.text(x + 2, y + h - 1, `${focused + 1}/${fields.length} fields                                      esc cancel`, p.muted, false, w - 4);
    } else {
      s.text(x + 2, y + 1, 'Command palette', p.secondary, true); s.text(x + 2, y + 3, `› ${this.input || 'Search actions…'}`, p.text, false, w - 4);
      const actions = this.actions(), count = Math.max(1, Math.floor((h - 7) / 2)), start = Math.floor(Math.max(0, this.selected) / count) * count;
      actions.slice(start, start + count).forEach((action, i) => { const row = y + 5 + i * 2, active = start + i === this.selected; if (active) s.rect(x + 1, row, w - 2, 2, p.panel); s.text(x + 2, row, `${active ? '› ' : '  '}${action.title}`, active ? p.secondary : p.text, active, w - 4); s.text(x + 4, row + 1, action.description, p.muted, false, w - 6); });
      s.text(x + 2, y + h - 1, '↑↓ select · enter open · esc dismiss', p.muted, false, w - 4);
    }
  }
  private draw() {
    if (!this.dirty || this.writing) return; this.dirty = false; this.writing = true;
    const lines = this.render(this.stderr.columns || 100, this.stderr.rows || 32, colorEnabled(this.stderr));
    this.stderr.write('\x1b[H' + lines.join('\r\n') + '\x1b[J', () => { this.writing = false; });
  }
}
