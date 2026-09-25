import { agentStatus } from './agent-listener.js';
import { fork, type ChildProcess } from 'node:child_process';
import { roomStatus, type RoomStatus } from './room-status.js';
import { TerminalInput } from './tui-input.js';
import { randomUUID } from 'node:crypto';
import { colorEnabled } from './ui.js';
import { listProfiles, type AgentProfile } from './profiles.js';
import { ownedRooms, readConfig, type Config, type LocalRoom } from './config.js';
import { displayText, type ExecutionEvent } from './agent-events.js';
import { AgentTuiModel } from './agent-tui.js';
import { statusColor, palette as p, textWidth, TuiScreen } from './tui-screen.js';
import { tuiActions, type TuiAction } from './tui-actions.js';

interface Choice { id: string; title: string; detail: string; status?: string; disabled?: boolean }
interface Picker { title: string; rows: Choice[]; choose: (row: Choice) => void; request?: string; loading?: boolean; error?: string }
interface Prompt { id: string; label: string; hint: string; secret: boolean; defaultValue?: string }
interface Job { id: string; title: string; child: ChildProcess; model: AgentTuiModel; output: string[]; running: boolean; code?: number | null; prompt?: Prompt; controls?: boolean; chatRequest?: string; drafts?: Partial<Record<Pane, string>>; draftSession?: string }
type Pane = 'activity' | 'conversation' | 'execution' | 'output';
const panes: Pane[] = ['activity', 'conversation', 'execution', 'output'];
const paneLabels = { activity: 'Private chat', conversation: 'Session', execution: 'Execution', output: 'Output' };
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
  roomStatuses = new Map<string, RoomStatus>();
  private roomRefresh = 0;
  config: Config = {};
  jobs: Job[] = [];
  selectedJob?: string;
  pane: 'activity' | 'conversation' | 'execution' | 'output' = 'activity';
  selected = 0;
  input = '';
  paletteOpen = false;
  form?: Form;
  picker?: Picker;
  notice = '';
  scroll = 0;
  private inputRouter?: TerminalInput;
  private hits: { x: number; y: number; w: number; h: number; action: () => void }[] = [];
  private hit(x: number, y: number, w: number, h: number, action: () => void) { this.hits.push({ x, y, w, h, action }); }
  private mouse = (button: number, x: number, y: number, released: boolean) => {
    if (released || this.closing) return;
    if (button === 64 || button === 65) {
      if (this.view === 'job' && !this.picker && !this.paletteOpen && !this.form) this.scroll = Math.max(0, Math.min(10000, this.scroll + (button === 64 ? 3 : -3)));
      else for (let i = 0; i < 3; i++) this.key(undefined, { name: button === 64 ? 'up' : 'down' });
    } else if (button === 0) this.hits.findLast(hit => x >= hit.x && y >= hit.y && x < hit.x + hit.w && y < hit.y + hit.h)?.action();
    this.changed();
  };
  private statusTimer?: NodeJS.Timeout;
  private statusAbort = new AbortController();
  private refreshingAgents = false;
  agentStatuses = new Map<string, string>();
  private async refreshAgentStatuses() {
    if (this.refreshingAgents || this.closing) return; this.refreshingAgents = true;
    try {
      const profiles = await listProfiles(); this.profiles = profiles;
      const pending = [...profiles];
      await Promise.all(Array.from({ length: Math.min(4, profiles.length) }, async () => {
        while (pending.length && !this.closing) {
          const profile = pending.shift()!;
          try { const status = await agentStatus(profile.name, AbortSignal.any([this.statusAbort.signal, AbortSignal.timeout(5000)])); this.agentStatuses.set(profile.name, status.availability); }
          catch { this.agentStatuses.set(profile.name, 'unknown · refresh failed'); }
          this.changed();
        }
      }));
    } catch { this.notice = 'Could not refresh saved agents.'; }
    finally { this.refreshingAgents = false; this.changed(); }
  }
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
  private saveDraft() {
    const job = this.job();
    if (this.view === 'job' && !this.form && !this.picker && !this.paletteOpen && job && !job.prompt) { (job.drafts ??= {})[this.pane] = this.input; }
  }
  private switchPane(pane: Pane) {
    if (this.job()?.prompt) return;
    this.saveDraft(); this.pane = pane; this.scroll = 0;
    const job = this.job(); this.input = job?.drafts?.[pane] ?? '';
    if (job && pane === 'conversation' && !this.input) job.draftSession = job.model.session;
    this.changed();
  }
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
    this.inputRouter = new TerminalInput(this.mouse); this.inputRouter.keyboard.on('keypress', this.key);
    this.stdin.on('data', this.inputRouter.feed); this.stdin.setRawMode(true); this.stdin.resume();
    this.stdin.on('keypress', this.key); this.stderr.on('resize', this.resize);
    process.once('SIGINT', this.requestQuit); process.once('SIGTERM', this.requestQuit);
    this.stderr.write('\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?1000h\x1b[?1006h');
    this.statusTimer = setInterval(() => { if (this.view === 'agents') void this.refreshAgentStatuses(); }, 10000);
    this.timer = setInterval(() => this.draw(), 80);
    try {
      const done = new Promise<void>(resolve => { this.done = resolve; });
      if (initial?.length) this.launch(initial);
      this.draw(); await done;
    } finally {
      clearInterval(this.statusTimer); this.statusAbort.abort();
      this.stdin.removeListener('data', this.inputRouter.feed); this.inputRouter.close();
      clearInterval(this.timer); this.stdin.removeListener('keypress', this.key); this.stderr.removeListener('resize', this.resize);
      process.removeListener('SIGINT', this.requestQuit); process.removeListener('SIGTERM', this.requestQuit);
      this.stdin.setRawMode(this.oldRaw); if (!this.wasFlowing) this.stdin.pause();
      this.stderr.write('\x1b[?1000l\x1b[?1006l\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l');
    }
  }
  private resize = () => this.changed();
  private requestQuit = () => { process.exitCode = 130; void this.quit(); };
  private async quit() {
    if (this.closing) return; this.closing = true; this.statusAbort.abort();
    this.notice = 'Stopping active work and releasing listeners…'; this.changed();
    await Promise.all(this.jobs.filter(job => job.running).map(job => new Promise<void>(resolve => {
      job.child.once('close', () => resolve()); job.child.kill('SIGTERM');
    })));
    this.done();
  }
  launch(args: string[]) {
    if (this.closing) return;
    if (args[0] === 'agent' && args[1] === 'start') {
      const existing = this.jobs.find(j => j.running && j.model.profile === args[2]);
      if (existing) { this.selectedJob = existing.id; this.view = 'job'; this.pane = 'activity'; this.input = existing.drafts?.activity ?? ''; this.scroll = 0; this.changed(); return; }
    }
    if (this.jobs.filter(job => job.running).length >= 8) { this.notice = 'Stop a process before starting more work (8 active processes maximum).'; return; }
    const child = fork(this.entry, args, { execArgv: process.execArgv.filter(arg => !arg.startsWith('--test')),
      env: { ...process.env, RENDEZVOUS_TUI_CHILD: '1', NO_COLOR: '1', FORCE_COLOR: '0' }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    child.stdin!.end();
    const title = args[0] === 'agent' ? `Agent ${args[1]}${args[2] ? ` · ${args[2]}` : ''}` : `${args[0] === '--version' ? 'Version' : args[0]}`;
    const job: Job = { id: randomUUID(), title: this.safe(title), child, model: new AgentTuiModel(args[0] === 'agent' ? args[2] ?? 'Agent' : 'Room'), output: [], running: true };
    this.jobs.push(job); if (this.jobs.length > 30) { const i = this.jobs.findIndex(j => !j.running); if (i >= 0) this.jobs.splice(i, 1); }
    this.selectedJob = job.id; this.view = 'job'; this.pane = args.includes('start') ? 'activity' : args[0] === 'join' || args[0] === 'create' && !args.includes('--no-join') ? 'conversation' : 'output';
    this.input = ''; this.scroll = 0;
    const append = (text: string) => { job.output.push(this.safe(text)); if (job.output.length > 250) job.output.shift(); this.changed(); };
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
        if (event.kind === 'session' && !job.drafts?.conversation && !(this.selectedJob === job.id && this.pane === 'conversation' && this.input)) job.draftSession = job.model.session;
      } else if (message?.type === 'prompt' && typeof message.id === 'string' && typeof message.label === 'string') {
        job.prompt = { id: message.id, label: this.safe(message.label), hint: this.safe(message.hint ?? ''), secret: !!message.secret, defaultValue: message.defaultValue };
        // A background request is announced, never allowed to steal typed input.
        this.notice = `${job.title} needs your input. Select its process to answer.`;
      } else if (message?.type === 'prompt_done' && job.prompt?.id === message.id) { job.prompt = undefined; if (this.selectedJob === job.id && !this.form && !this.paletteOpen) this.input = ''; }
      else if (message?.type === 'peers_result') this.receivePeers(job, message);
      else if (message?.type === 'controls') job.controls = !!message.available;
      else if (message?.type === 'control_result') {
        if (job.chatRequest === message.id) { job.chatRequest = undefined; if (message.ok && job.drafts) job.drafts[message.action === 'steer' ? 'conversation' : 'activity'] = '';  if (message.ok && this.pane === (message.action === 'steer' ? 'conversation' : 'activity') && this.selectedJob === job.id && !this.form && !this.picker && !this.paletteOpen) this.input = ''; }
        this.notice = message.ok ? message.action === 'steer' ? 'Instruction queued for the session harness.' : message.action === 'chat' ? 'Private message accepted.' : 'Action completed.' : this.safe(message.error ?? 'Action failed.');
      }
      this.changed();
    });
    child.on('error', error => append(`Could not start: ${error.message}`));
    child.on('close', code => {
      job.running = false; job.code = code; job.prompt = undefined; job.chatRequest = undefined;
      if (code !== 0 && code !== 130) job.model.add({ kind: 'error', time: new Date().toISOString(), text: job.output.slice(-3).join('\n') || 'Process stopped. See Output for diagnostics.' });
      append(code === 0 ? 'Completed.' : code === 130 ? 'Disconnected.' : `Process exited (${code ?? 'signal'}).`);
      void this.refresh();
    });
    this.changed();
  }
  private async refreshRooms() {
    const version = ++this.roomRefresh;
    let rooms: LocalRoom[];
    try { rooms = await ownedRooms(); } catch { this.notice = 'Could not reload saved rooms.'; this.changed(); return; }
    const pending = [...rooms], statuses = new Map<string, RoomStatus>();
    await Promise.all(Array.from({ length: Math.min(4, rooms.length) }, async () => {
      while (pending.length) { const room = pending.shift()!; statuses.set(room.room_file, await roomStatus(room)); }
    }));
    if (version !== this.roomRefresh) return;
    this.rooms = rooms; this.roomStatuses = statuses; this.changed();
  }
  private async roomPicker(action: TuiAction) {
    this.pick('Refreshing rooms from their servers…', [], () => {});
    const pending = this.picker;
    await this.refreshRooms();
    if (this.picker !== pending) return;
    const rows: Choice[] = this.rooms.map(room => ({ id: room.room_file, title: `Room ${room.session_id.slice(0, 8)}`,
      detail: this.roomStatuses.get(room.room_file)?.detail ?? 'unverified',
      status: this.roomStatuses.get(room.room_file)?.state ?? 'unverified',
      disabled: action.id === 'join' && !this.roomStatuses.get(room.room_file)?.usable }));
    if (action.id === 'join') rows.unshift({ id: '', title: 'Use an invitation', detail: 'Enter a private invitation link', disabled: false });
    this.pick('Choose a room · refreshed', rows, row => {
      const room = this.rooms.find(r => r.room_file === row.id);
      if (room && action.id === 'join') void this.chooseRoom(room);
      else this.activate(action, { room: room?.session_id ?? '' });
    });
  }
  private async chooseRoom(room: LocalRoom) {
    this.pick('Checking selected room…', [], () => {});
    const pending = this.picker;
    const current = (await ownedRooms().catch(() => [])).find(r => r.room_file === room.room_file);
    const status = current ? await roomStatus(current) : { state: 'unavailable', usable: false, detail: 'Saved room no longer exists locally' };
    if (this.picker !== pending) return;
    this.roomStatuses.set(room.room_file, status); this.picker = undefined;
    if (!status.usable) { this.notice = `${status.detail}. Choose another room, or reopen Rooms to retry.`; this.changed(); return; }
    this.activate(tuiActions.find(a => a.id === 'join')!, { room: current!.session_id, server: new URL(current!.invite_url).origin });
  }
  private pick(title: string, rows: Choice[], choose: (row: Choice) => void) {
    this.form = undefined; this.paletteOpen = false; this.input = ''; this.selected = 0;
    this.picker = { title, rows, choose }; this.changed();
  }
  private contact(job: Job, after?: string, previous: Choice[] = []) {
    if (!job.running || !job.controls) { this.notice = 'That listener is no longer online.'; this.changed(); return; }
    this.pick(`Friends of ${job.model.profile}`, previous, () => {});
    const id = randomUUID(); this.picker!.request = id; this.picker!.loading = true;
    job.child.send({ type: 'control', id, action: 'peers', after });
  }
  private receivePeers(job: Job, message: any) {
    if (!this.picker || this.picker.request !== message.id) return;
    const previous = this.picker.rows.filter(row => row.id !== 'more');
    if (message.error) {
      this.pick('Friend list unavailable', [{ id: 'retry', title: 'Retry discovery', detail: job.model.server.replace(/^Connecting to /, '') }], () => this.contact(job));
      this.picker!.error = message.code === 'NOT_FOUND' ? 'This server is missing friend discovery. Deploy the backend update, then retry.' : this.safe(message.error);
      this.changed(); return;
    }
    const rows: Choice[] = [...previous, ...message.peers.map((peer: any) => ({ id: peer.id,
      title: this.safe(peer.display_name), detail: `${peer.availability} · ${peer.id}`, status: peer.availability, disabled: peer.availability !== 'available' }))];
    rows.sort((a, b) => Number(a.disabled) - Number(b.disabled) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    if (message.next_cursor) rows.push({ id: 'more', title: 'Load more friends', detail: 'Search includes the loaded pages' });
    this.pick(`Friends of ${job.model.profile}`, rows, row => {
      if (row.id === 'more') { this.contact(job, message.next_cursor, rows); return; }
      this.selectedJob = job.id; this.view = 'job'; this.pane = 'activity';
      this.activate({ ...tuiActions.find(a => a.id === 'open')!, description: `Message ${row.title} from ${job.model.profile}` }, { peer: row.id });
    });
    if (!rows.length) this.notice = 'No permitted friends yet. Add a friend and enable outbound/inbound access in the dashboard.';
  }
  private pickerRows() { const query = this.input.toLowerCase(); return this.picker!.rows.filter(row => row.id === 'more' || `${row.title} ${row.detail}`.toLowerCase().includes(query)); }
  private selectView(view: View) { this.saveDraft(); this.view = view; this.selected = 0; this.input = ''; this.form = undefined; this.picker = undefined; this.paletteOpen = false; this.scroll = 0; this.changed(); if (view === 'agents') void this.refreshAgentStatuses(); if (view === 'rooms') { this.notice = 'Refreshing rooms from their servers…'; void this.refreshRooms().then(() => { if (this.notice === 'Refreshing rooms from their servers…') this.notice = ''; this.changed(); }); } }
  private actions() { const query = this.input.replace(/^\//, '').toLowerCase(); return tuiActions.filter(a => `${a.id} ${a.title} ${a.description}`.toLowerCase().includes(query)); }
  activate(action: TuiAction, values: Record<string, string> = {}) {
    if (nav.some(n => n.id === action.id)) { this.selectView(action.id as View); return; }
    if (!this.paletteOpen && !this.form && !this.picker) this.saveDraft();
    this.paletteOpen = false; this.picker = undefined; this.input = ''; this.selected = 0; this.notice = '';
    if (action.id === 'open' && !values.peer) {
      const listeners = this.jobs.filter(j => j.running && j.controls);
      const selected = this.view === 'job' ? this.job() : undefined;
      if (selected?.controls && selected.running) this.contact(selected);
      else if (listeners.length === 1) this.contact(listeners[0]);
      else this.pick('Which agent should make contact?', listeners.map(j => ({ id: j.id, title: j.model.profile, detail: j.model.state })), row => this.contact(listeners.find(j => j.id === row.id)!));
      if (!listeners.length) this.notice = 'Start a saved agent first, then choose Contact an agent.';
      return;
    }
    if (['start', 'inspect'].includes(action.id) && !values.profile) {
      this.pick('Refreshing saved agents…', [], () => {});
      const pending = this.picker;
      void listProfiles().then(profiles => {
        if (this.picker !== pending) return;
        this.profiles = profiles;
        this.pick('Choose a saved agent', profiles.map(profile => ({ id: profile.name, title: profile.name, detail: `${profile.agent} · ${profile.origin}` })), row => this.activate(action, { profile: row.id }));
        if (!profiles.length) this.notice = 'No saved agents. Choose Set up an agent first.';
      }).catch(() => { if (this.picker === pending) { this.notice = 'Could not refresh saved agents. Reopen to retry.'; this.changed(); } });
      return;
    }
    if (['join', 'owner'].includes(action.id) && values.room === undefined) {
      void this.roomPicker(action); return;
    }
    if (values.profile) action = { ...action, title: `${action.title} · ${values.profile}` };
    if (action.fields) action = { ...action, fields: action.fields.filter(field => !((field.key === 'profile' || field.key === 'room') && values[field.key] !== undefined)) };
    if (action.command && action.fields?.length === 0) { this.launch(action.command(values)); return; }
    if (nav.some(n => n.id === action.id)) { this.selectView(action.id as View); return; }
    const job = this.job();
    if (action.id === 'quit' || action.id === 'stop' || action.id === 'close') {
      if (action.id !== 'quit' && !job?.running) { this.notice = 'Select a running process first.'; this.changed(); return; }
      if (action.id === 'close' && (!job?.controls || job.model.session === 'none')) { this.notice = 'Select an online agent with an active conversation.'; this.changed(); return; }
      this.form = { action: { ...action, fields: [{ key: 'confirm', label: action.id === 'quit' ? 'Stop active work and quit?' : `Confirm ${action.id} for ${job!.title}?`, required: true, choices: ['no', 'yes'] }] }, values: { confirm: 'no' }, field: 0, job: job?.id, session: job?.model.session };
    } else if (action.fields) {
      this.form = { action, values: { ...values, ...Object.fromEntries(action.fields.map(field => [field.key, values[field.key] ?? (field.key === 'agent' ? this.config.agent : undefined) ?? field.initial ?? ''])) }, field: 0, job: job?.id, session: job?.model.session };
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
        if (values.confirm !== 'yes') { this.form = undefined; this.notice = 'Cancelled.'; this.changed(); return; }
        if (action.id === 'quit') void this.quit();
        else if (!job?.running) throw new Error('That process is no longer running.');
        else if (action.id === 'stop') job.child.kill('SIGTERM');
        else if (!job.controls) throw new Error('The listener is reconnecting; try again when online.');
        else job.child.send({ type: 'control', id: randomUUID(), action: 'close', sessionId: form.session });
      } else if (action.id === 'steer') {
        if (!job?.running || !job.controls || !form.session || form.session === 'none') throw new Error('Select an active agent conversation.');
        job.child.send({ type: 'control', id: randomUUID(), action: 'steer', sessionId: form.session, message: values.message });
      } else if (action.id === 'open') {
        if (!job?.running || !job.controls) throw new Error('Select a running agent listener first.');
        job.child.send({ type: 'control', id: randomUUID(), action: 'open', peer: values.peer, message: values.message });
        this.pane = 'conversation'; this.input = job.drafts?.conversation ?? ''; this.scroll = 0;
      } else this.launch(action.command!(values));
      this.form = undefined;
    } catch (error) { this.notice = this.safe(error instanceof Error ? error.message : 'Action failed.'); }
    this.changed();
  }
  private key = (text: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }) => {
    if (this.closing) return;
    if (key.ctrl && key.name === 'c') { this.requestQuit(); return; }
    if (key.ctrl && key.name === 'b' && this.view === 'job' && !this.form && !this.picker && !this.paletteOpen) { this.selectView('jobs'); return; }
    if (key.ctrl && key.name === 'p') { if (!this.paletteOpen) this.saveDraft(); this.paletteOpen = !this.paletteOpen; this.form = undefined; this.picker = undefined; this.input = ''; this.selected = 0; this.changed(); return; }
    if (key.name === 'escape') { this.picker = undefined; this.form = undefined; this.paletteOpen = false; this.input = ''; this.notice = ''; this.changed(); return; }
    if (this.picker) {
      const rows = this.pickerRows();
      if (key.name === 'down') this.selected = Math.min(Math.max(0, rows.length - 1), this.selected + 1);
      else if (key.name === 'up' || this.view === 'jobs' && key.name === 'left') this.selected = Math.max(0, this.selected - 1);
      else if (key.name === 'return' && rows[this.selected] && !this.picker.loading) {
        const row = rows[this.selected];
        if (row.disabled) this.notice = `Unavailable: ${row.detail}. Reopen this list to refresh.`;
        else this.picker.choose(row);
      } else if (key.name === 'backspace') { this.input = [...this.input].slice(0, -1).join(''); this.selected = 0; }
      else if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) { this.input += text; this.selected = 0; }
    } else if (this.form) {
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
      else if (key.name === 'up' || this.view === 'jobs' && key.name === 'left') this.selected = Math.max(0, this.selected - 1);
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
    } else if (this.view === 'job' && this.job()?.controls && this.job()?.running) {
      const job = this.job()!;
      if (text === '/' && !this.input) { this.paletteOpen = true; this.selected = 0; }
      else if (key.name === 'tab') { this.switchPane(panes[(panes.indexOf(this.pane) + 1) % panes.length]); }
      else if (key.name === 'pageup') this.scroll = Math.min(10000, this.scroll + 8);
      else if (key.name === 'pagedown') this.scroll = Math.max(0, this.scroll - 8);
      else if (key.name === 'end') this.scroll = 0;
      else if (key.ctrl && key.name === 'u' && !job.chatRequest) this.input = '';
      else if (key.name === 'return' && this.input.trim() && !job.chatRequest) {
        if (this.pane !== 'activity' && this.pane !== 'conversation') { this.notice = 'Choose Private chat or Session to send a message.'; this.changed(); return; }
        const steering = this.pane === 'conversation';
        if (steering && (job.model.session === 'none' || job.draftSession !== job.model.session)) {
          this.notice = 'Session unavailable or changed. Clear this draft (Ctrl+U), then reopen Session before writing a new instruction.'; this.changed(); return;
        }
        job.chatRequest = randomUUID();
        job.child.send({ type: 'control', id: job.chatRequest, action: steering ? 'steer' : 'chat',
          ...(steering ? { sessionId: job.draftSession } : {}), message: this.input.trim() });
      } else if (!job.chatRequest && key.name === 'backspace') this.input = [...this.input].slice(0, -1).join('');
      else if (!job.chatRequest && !key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) this.input = (this.input + text).slice(0, 32768);
    } else if (text === '/') { this.paletteOpen = true; this.input = ''; this.selected = 0; }
    else if (key.name === 'tab' && this.view === 'job') { this.switchPane(panes[(panes.indexOf(this.pane) + 1) % panes.length]); }
    else if (key.name === 'pageup') this.scroll = Math.min(10000, this.scroll + 8);
    else if (key.name === 'pagedown') this.scroll = Math.max(0, this.scroll - 8);
    else if (key.name === 'end') this.scroll = 0;
    else if (key.name === 'up' || this.view === 'jobs' && key.name === 'left') this.selected = Math.max(0, this.selected - 1);
    else if (key.name === 'down' || this.view === 'jobs' && key.name === 'right') this.selected++;
    else if (key.name === 'return') this.openSelected();
    else if (text && /^[1-5]$/.test(text)) this.selectView(nav[Number(text) - 1].id);
    else if (text === 'n') this.activate(tuiActions.find(a => a.id === (this.view === 'agents' ? 'setup' : this.view === 'rooms' ? 'create' : 'start'))!);
    this.changed();
  };
  private openSelected() {
    if (this.view === 'agents' && this.profiles.length) {
      const profile = this.profiles[this.selected % this.profiles.length];
      const job = this.jobs.find(j => j.running && j.model.profile === profile.name);
      if (job) { this.selectedJob = job.id; this.view = 'job'; this.pane = 'activity'; this.input = job.drafts?.activity ?? ''; this.scroll = 0; }
      else this.activate(tuiActions.find(a => a.id === 'start')!, { profile: profile.name });
    }
    else if (this.view === 'rooms' && this.rooms.length) void this.chooseRoom(this.rooms[this.selected % this.rooms.length]);
    else if (this.view === 'jobs' && this.jobs.length) { this.selectedJob = this.jobs[this.selected % this.jobs.length].id; this.view = 'job'; this.pane = this.job()?.model.profile === 'Room' ? 'conversation' : 'activity'; this.input = this.job()?.drafts?.[this.pane] ?? ''; this.scroll = 0; }
    else if (this.view === 'settings') this.activate(tuiActions.find(a => a.id === (this.selected % 2 ? 'config-server' : 'config-agent'))!);
    else if (this.view === 'home') this.activate(tuiActions.find(a => a.id === ['start', 'setup', 'create', 'join'][this.selected % 4])!);
  }
  render(columns: number, rows: number, color = true) {
    this.hits = [];
    const width = Math.max(1, Math.min(columns - 1, 240)), height = Math.max(1, rows);
    const s = new TuiScreen(width, height), sidebar = width >= 95 ? 25 : 0, x = sidebar + 3, mainWidth = width - x - 3;
    if (width < 45 || height < 20) { s.text(0, 0, 'rendezvous', p.primary, true); s.text(0, 2, 'Enlarge terminal to 46 × 20.', p.secondary); s.text(0, 4, 'Ctrl+C quits safely.', p.muted); return s.lines(color); }
    s.rect(0, 0, width, 3, p.panel); s.text(2, 1, '●', p.primary, true); s.text(4, 1, 'rendezvous', p.text, true);
    s.text(17, 1, `/ ${this.view === 'job' ? this.job()?.title ?? 'Execution' : nav.find(n => n.id === this.view)?.title}`, p.muted, false, width - 41);
    this.hit(width - 23, 0, 23, 3, () => this.key(undefined, { name: 'p', ctrl: true }));
    if (width > 65) s.text(width - 22, 1, 'ctrl+p  commands', p.secondary);
    if (sidebar) {
      s.rect(0, 3, sidebar, height - 5, p.panel); s.text(3, 5, 'WORKSPACE', p.muted);
      nav.forEach((item, i) => {
        this.hit(1, 7 + i * 2, sidebar - 2, 2, () => this.selectView(item.id));
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
      this.hit(x, 13, mainWidth, 3, () => this.key(undefined, { name: 'p', ctrl: true }));
      const cards = [['Start an agent', 'Bring a saved identity online'], ['Set up an agent', 'Connect a new profile'], ['Create a room', 'Invite agents to collaborate'], ['Join a room', 'Continue a conversation']];
      cards.forEach(([title, detail], i) => { const y = (height < 30 ? 16 : 18) + i * (height < 30 ? 1 : 2); this.hit(x, y, mainWidth, height < 30 ? 1 : 2, () => { this.selected = i; this.openSelected(); }); if (this.selected % 4 === i) s.text(x, y, '›', p.primary, true); s.text(x + 2, y, title, p.secondary, true); if (mainWidth > 60) s.text(x + 24, y, detail, p.muted, false, mainWidth - 24); });
    } else if (this.view === 'job') {
      const job = this.job();
      s.text(x, 4, '← Active work · Ctrl+B', p.secondary, false, mainWidth);
      this.hit(x, 4, 23, 1, () => this.selectView('jobs'));
      s.text(x, 5, job?.model.profile === 'Room' ? job.title : job?.model.profile ?? 'No process selected', p.text, true, mainWidth);
      if (job) s.text(x, 6, this.pane === 'activity' ? 'Private conversation · separate from friend sessions' : this.pane === 'conversation' ? job.model.session === 'none' ? 'No active friend session' : 'Shared session · participants and their owners can see replies' : `${job.model.identity} · ${job.model.server.replace(/^Connecting to /, '')}`, p.muted, false, mainWidth);
      s.text(x, 7, job?.running ? job.model.state : job?.code === 0 ? 'Completed' : 'Stopped', job?.running ? p.secondary : p.muted, false, Math.min(mainWidth, 44));
      if (job && mainWidth > 75 && (this.pane === 'execution' || this.pane === 'output')) s.text(x + 46, 7, `Session ${job.model.session.slice(0, 8)} · thread ${job.model.thread.slice(0, 12)}`, p.muted, false, mainWidth - 46);
      let tabX = x;
      for (const tab of panes) {
        const label = paneLabels[tab], tabWidth = label.length + 4;
        s.text(tabX, 9, this.pane === tab ? `[ ${label} ]` : `  ${label}  `, this.pane === tab ? p.secondary : p.muted, this.pane === tab, Math.max(0, x + mainWidth - tabX));
        this.hit(tabX, 9, tabWidth, 1, () => this.switchPane(tab)); tabX += tabWidth + 1;
      }
      if (job?.running && job.controls) {
        s.text(x, 8, '[ Contact friend ]', p.secondary, false, mainWidth);
        this.hit(x, 8, 18, 1, () => this.activate(tuiActions.find(a => a.id === 'open')!));
        if (job.model.session !== 'none') {
          s.text(x + 21, 8, '[ End session ]', p.secondary, false, mainWidth - 21);
          this.hit(x + 21, 8, 15, 1, () => this.activate(tuiActions.find(a => a.id === 'close')!));
        }
      }
      const chatPane = this.pane === 'activity' || this.pane === 'conversation';
      const visible: { text: string; color: string; bold?: boolean; mine?: boolean }[] = [];
      const wrap = (value: string, color: string, mine = false) => {
        for (const paragraph of value.split('\n')) {
          let line = '';
          for (const char of paragraph) {
            if (textWidth(line + char) > mainWidth - 6) { visible.push({ text: line, color, mine }); line = ''; }
            line += char;
          }
          visible.push({ text: line, color, mine });
        }
      };
      if (chatPane && job) {
        for (const message of job.model.chat.filter(m => m.private === (this.pane === 'activity'))) {
          visible.push({ text: `${message.sender}  ·  ${message.time}${message.session ? `  ·  ${message.session.slice(0, 8)}` : ''}`, color: message.mine ? p.secondary : p.success, bold: true, mine: message.mine });
          wrap(message.text, p.text, message.mine);
          visible.push({ text: '', color: p.muted });
        }
      } else for (const entry of job ? this.pane === 'execution' ? job.model.execution : job.output : []) wrap(entry, p.muted);
      const count = Math.max(1, height - 19), end = Math.max(0, visible.length - this.scroll);
      s.rect(x, 11, mainWidth, count + 1, p.panel);
      visible.slice(Math.max(0, end - count), end).forEach((line, i) => {
        if (line.mine) s.rect(x + 1, 12 + i, mainWidth - 2, 1, p.raised);
        s.text(x + 2, 12 + i, line.text, line.color, line.bold, mainWidth - 4);
      });
      if (!visible.length) s.text(x + 2, 12, this.pane === 'activity' ? 'Your private conversation with this agent.' : this.pane === 'conversation' ? 'Contact a friend to begin a shared session.' : 'No diagnostics yet.', p.muted, false, mainWidth - 4);
      const prompt = job?.prompt;
      s.rect(x, height - 6, mainWidth, 3, p.raised); s.text(x, height - 6, '▌', p.primary);
      s.text(x + 2, height - 6, prompt ? `${prompt.secret ? 'PRIVATE · ' : ''}${prompt.label}` : job?.controls && chatPane ? this.pane === 'conversation' ? 'SESSION INSTRUCTION · agent replies may be shared' : 'PRIVATE CHAT · only you and this agent' : 'COMMANDS', p.secondary, true, mainWidth - 4);
      s.text(x + 2, height - 5, prompt ? (prompt.secret ? '•'.repeat(Math.min(40, this.input.length)) : this.input) || prompt.defaultValue || 'Type your answer, then Enter…' : job?.controls && chatPane ? this.input || (job.chatRequest ? 'Harness working…' : this.pane === 'conversation' ? job.model.session === 'none' ? 'No active session' : 'Guide your agent in this session… Enter sends' : 'Message your agent… Enter sends · / commands') : '/ commands · choose a chat tab to write', prompt ? p.text : p.muted, false, mainWidth - 4);
      if (prompt) s.text(x + 2, height - 4, prompt.hint, p.muted, false, mainWidth - 4);
    } else if (this.view === 'jobs') {
      s.text(x, 5, 'Active work', p.text, true);
      s.text(x, 7, '[ + Start an agent ]', p.secondary);
      this.hit(x, 7, 20, 1, () => this.activate(tuiActions.find(a => a.id === 'start')!));
      const columns = mainWidth >= 90 ? 3 : mainWidth >= 58 ? 2 : 1;
      const cardWidth = Math.floor((mainWidth - (columns - 1) * 2) / columns);
      const page = columns * Math.max(1, Math.floor((height - 13) / 7));
      const selected = this.jobs.length ? this.selected % this.jobs.length : 0;
      const start = Math.floor(selected / page) * page;
      this.jobs.slice(start, start + page).forEach((job, i) => {
        const cx = x + (i % columns) * (cardWidth + 2), cy = 10 + Math.floor(i / columns) * 7;
        const active = start + i === selected;
        s.rect(cx, cy, cardWidth, 6, active ? p.raised : p.panel);
        s.text(cx, cy, '┌' + '─'.repeat(cardWidth - 2) + '┐', active ? p.secondary : p.border);
        s.text(cx, cy + 5, '└' + '─'.repeat(cardWidth - 2) + '┘', active ? p.secondary : p.border);
        s.text(cx + 2, cy + 1, '●', job.running ? job.prompt ? '#fbbf24' : p.success : p.muted);
        s.text(cx + 4, cy + 1, job.model.profile === 'Room' ? job.title : job.model.profile, p.text, true, cardWidth - 6);
        s.text(cx + 2, cy + 2, job.running ? job.prompt ? 'Needs your input' : job.model.state : 'Stopped', p.secondary, false, cardWidth - 4);
        s.text(cx + 2, cy + 3, job.model.session === 'none' ? 'Private chat · no session' : `Session ${job.model.session.slice(0, 8)}`, p.muted, false, cardWidth - 4);
        s.text(cx + 2, cy + 4, 'Open →', p.muted, false, cardWidth - 4);
        this.hit(cx, cy, cardWidth, 6, () => { this.selected = start + i; this.openSelected(); });
      });
      if (!this.jobs.length) s.text(x, 11, 'Start an agent to open its workspace.', p.muted);
    } else {
      const heading = nav.find(n => n.id === this.view)!; s.text(x, 5, heading.title, p.text, true); s.text(x, 7, heading.hint, p.muted);
      const entries = this.view === 'agents' ? this.profiles.map(a => [a.name, `${this.agentStatuses.get(a.name) ?? 'checking…'} · ${a.agent}`, a.origin])
        : this.view === 'rooms' ? this.rooms.map(r => [r.session_id, r.invite_url.split('/').slice(0, 3).join('/'), this.roomStatuses.get(r.room_file)?.detail ?? 'Not yet checked on server'])
        : [['Default harness', this.config.agent ?? 'codex', 'Used when a command does not choose a harness'], ['Default server', this.config.server ?? 'https://dev.userendezvous.com', 'Command overrides remain available']];
      if (!entries.length) { s.text(x, 11, 'Nothing here yet.', p.secondary, true); s.text(x, 13, 'Press / to get started.', p.muted); }
      const selected = entries.length ? this.selected % entries.length : 0, page = Math.max(1, Math.floor((height - 14) / 4));
      const start = Math.floor(selected / page) * page;
      entries.slice(start, start + page).forEach(([title, detail, meta], i) => { const y = 10 + i * 4, active = start + i === selected; this.hit(x, y, mainWidth, 3, () => { this.selected = start + i; this.openSelected(); }); s.rect(x, y, mainWidth, 3, active ? p.raised : p.panel); if (active) s.text(x, y, '▌', p.primary); s.text(x + 2, y, title, active ? p.secondary : p.text, true, mainWidth - 4); const hasStatus = this.view === 'agents';
        if (hasStatus) s.text(x + 2, y + 1, '●', statusColor(this.agentStatuses.get(this.profiles[start + i].name) ?? 'checking…'));
        s.text(x + (hasStatus ? 4 : 2), y + 1, detail, p.muted, false, mainWidth - (hasStatus ? 6 : 4)); const hasRoomStatus = this.view === 'rooms';
        if (hasRoomStatus) s.text(x + 2, y + 2, '●', statusColor(this.roomStatuses.get(this.rooms[start + i].room_file)?.state ?? 'unchecked'));
        s.text(x + (hasRoomStatus ? 4 : 2), y + 2, meta, p.muted, false, mainWidth - (hasRoomStatus ? 6 : 4)); });
    }
    s.rect(0, height - 2, width, 2, p.panel);
    s.text(2, height - 2, this.notice || (sidebar ? 'click or ↑↓ select   enter open   wheel scroll   / commands' : '1 home  2 agents  3 rooms  4 work  5 settings  / commands'), this.notice ? p.secondary : p.muted, false, width - 4);
    s.text(2, height - 1, this.closing ? 'Disconnecting…' : 'ctrl+p command palette                              ctrl+c quit', p.muted, false, width - 4);
    if (this.paletteOpen || this.form || this.picker) this.modal(s, width, height);
    return s.lines(color);
  }
  private modal(s: TuiScreen, width: number, height: number) {
    const w = Math.min(76, width - 4), x = Math.floor((width - w) / 2), y = 3, h = height - 6;
    this.hits = []; // A modal captures clicks; never activate the page behind it.
    s.rect(x, y, w, h, p.raised); s.text(x, y, '▌', p.primary, true);
    if (this.picker) {
      s.text(x + 2, y + 1, this.picker.title, p.secondary, true, w - 4);
      s.text(x + 2, y + 3, `› ${this.input || 'Search by name…'}`, p.text, false, w - 4);
      const rows = this.pickerRows(), count = Math.max(1, Math.floor((h - 7) / 2)), start = Math.floor(this.selected / count) * count;
      if (this.picker.error) s.wrap(x + 2, y + 3, this.picker.error, w - 4, p.secondary, 2);
      if (this.picker.loading) s.text(x + 2, y + 5, 'Loading friends…', p.muted);
      else if (!rows.length) s.text(x + 2, y + 5, 'No matching options.', p.muted);
      else rows.slice(start, start + count).forEach((row, i) => {
        const line = y + 5 + i * 2, active = start + i === this.selected;
        this.hit(x + 1, line, w - 2, 2, () => { this.selected = start + i; this.key(undefined, { name: 'return' }); });
        if (active) s.rect(x + 1, line, w - 2, 2, p.panel);
        s.text(x + 2, line, `${active ? '› ' : '  '}${row.title}`, row.disabled ? p.muted : p.secondary, active, w - 4);
        if (row.status) s.text(x + 4, line + 1, '●', statusColor(row.status));
        s.text(x + (row.status ? 6 : 4), line + 1, row.detail, p.muted, false, w - (row.status ? 8 : 6));
      });
      s.text(x + 2, y + h - 1, '↑↓ select · type to search · enter choose · esc cancel', p.muted, false, w - 4);
    } else if (this.form) {
      const { action, values, field: focused } = this.form, fields = action.fields!;
      s.text(x + 2, y + 1, action.title, p.secondary, true, w - 4);
      s.text(x + 2, y + 2, action.description, p.muted, false, w - 4);
      const page = Math.max(1, Math.floor((h - 7) / 3)), first = Math.floor(focused / page) * page;
      fields.slice(first, first + page).forEach((field, i) => {
        const active = first + i === focused, row = y + 4 + i * 3;
        this.hit(x + 2, row, w - 4, 2, () => { this.form!.field = first + i; if (field.choices) this.key(undefined, { name: 'right' }); });
        s.text(x + 2, row, `${field.label}${field.required ? ' *' : ''}`, active ? p.secondary : p.muted, active, w - 4);
        s.rect(x + 2, row + 1, w - 4, 1, active ? p.background : p.panel);
        s.text(x + 3, row + 1, `${active ? '› ' : ''}${[...(values[field.key] || '…')].slice(-Math.max(1, w - 14)).join('')}${active ? field.choices ? '   ‹  ›' : '▏' : ''}`, p.text, false, w - 6);
      });
      s.text(x + 2, y + h - 2, '[ Submit ]   tab next · ←→ choose · ctrl+u clear', p.secondary, false, w - 4);
      this.hit(x + 2, y + h - 2, 10, 1, () => this.submit());
      s.text(x + 2, y + h - 1, `${focused + 1}/${fields.length} fields                                      esc cancel`, p.muted, false, w - 4);
    } else {
      s.text(x + 2, y + 1, 'Command palette', p.secondary, true); s.text(x + 2, y + 3, `› ${this.input || 'Search actions…'}`, p.text, false, w - 4);
      const actions = this.actions(), count = Math.max(1, Math.floor((h - 7) / 2)), start = Math.floor(Math.max(0, this.selected) / count) * count;
      actions.slice(start, start + count).forEach((action, i) => { const row = y + 5 + i * 2, active = start + i === this.selected; this.hit(x + 1, row, w - 2, 2, () => this.activate(action)); if (active) s.rect(x + 1, row, w - 2, 2, p.panel); s.text(x + 2, row, `${active ? '› ' : '  '}${action.title}`, active ? p.secondary : p.text, active, w - 4); s.text(x + 4, row + 1, action.description, p.muted, false, w - 6); });
      s.text(x + 2, y + h - 1, '↑↓ select · enter open · esc dismiss', p.muted, false, w - 4);
    }
  }
  private draw() {
    if (!this.dirty || this.writing) return; this.dirty = false; this.writing = true;
    const lines = this.render(this.stderr.columns || 100, this.stderr.rows || 32, colorEnabled(this.stderr));
    this.stderr.write('\x1b[H' + lines.join('\r\n') + '\x1b[J', () => { this.writing = false; });
  }
}
