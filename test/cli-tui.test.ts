import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { AgentTuiModel, useTui } from '../src/cli/agent-tui.js';
import { RendezvousTui } from '../src/cli/tui-app.js';
import { parseCommand, tuiActions } from '../src/cli/tui-actions.js';
import { textWidth } from '../src/cli/tui-screen.js';

test('workspace offers all CLI workflows and parses advanced arguments without a shell', () => {
  for (const id of ['setup', 'start', 'inspect', 'create', 'join', 'owner', 'agents', 'rooms', 'config', 'open', 'close', 'run']) {
    assert.ok(tuiActions.some(a => a.id === id), id);
  }
  assert.deepEqual(parseCommand(`rendezvous join --task 'literal $(whoami)' --name "two words"`), ['join', '--task', 'literal $(whoami)', '--name', 'two words']);
  assert.throws(() => parseCommand('join "unfinished'), /quote/);
});

test('workspace renders crimson and rose, bounded small screens, and guided forms', () => {
  const app = new RendezvousTui('unused');
  assert.match(app.render(120, 36).join('\n'), /38;2;223;7;18/);
  assert.match(app.render(120, 36).join('\n'), /38;2;253;164;175/);
  assert.match(app.render(120, 36, false).join('\n'), /Start an agent/);
  for (const [width, height] of [[120, 36], [80, 24], [40, 12], [1, 1]]) {
    const lines = app.render(width, height, false);
    assert.equal(lines.length, height);
    assert.ok(lines.every(line => textWidth(line) <= Math.max(1, width - 1)));
  }
  app.activate(tuiActions.find(a => a.id === 'setup')!);
  assert.match(app.render(100, 32, false).join('\n'), /Profile name/);
  assert.match(app.render(100, 32, false).join('\n'), /Agent UUID/);
});

test('workspace palette, forms, navigation and cancellation restore the terminal', { timeout: 5000 }, async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(raw: boolean) { this.isRaw = raw; return this; } });
  let screen = '';
  const output = Object.assign(new Writable({ write(chunk, _encoding, done) { screen += chunk; done(); } }), { isTTY: true, columns: 120, rows: 36 });
  const app = new RendezvousTui('unused', input as unknown as typeof process.stdin, output as unknown as typeof process.stderr);
  app.refresh = async () => {};
  (app as any).refreshAgentStatuses = async () => {};
  const running = app.run(); await new Promise(resolve => setImmediate(resolve));
  input.emit('keypress', '/', {}); input.emit('keypress', 'set up', {});
  input.emit('keypress', '\r', { name: 'return' });
  assert.equal(app.form?.action.id, 'setup');
  input.emit('keypress', 'reviewer', {}); assert.equal(app.form?.values.profile, 'reviewer');
  input.emit('keypress', undefined, { name: 'escape' });
  app.render(120, 36);
  input.write('\x1b[<0;5;10M'); assert.equal(app.view, 'agents');
  assert.equal(app.input, '', 'mouse report cannot become typed input');
  app.render(120, 36);
  input.write('\x1b[<65;40;12M'); assert.equal(app.selected, 3);
  const sent: any[] = [];
  const model = new AgentTuiModel('reviewer'); model.session = 'original-session';
  app.jobs.push({ id: 'reviewer', title: 'Agent start reviewer', child: { send: (message: any) => sent.push(message) } as unknown as ChildProcess, model, output: [], running: true, controls: true });
  app.selectedJob = 'reviewer';
  app.activate(tuiActions.find(a => a.id === 'close')!);
  model.session = 'new-session';
  input.emit('keypress', undefined, { name: 'right' }); input.emit('keypress', '\r', { name: 'return' });
  assert.equal(sent[0].sessionId, 'original-session', 'confirmation stays bound to the original session');
  app.jobs[0].running = false;
  output.columns = 40; output.emit('resize');
  app.activate(tuiActions.find(a => a.id === 'quit')!);
  input.emit('keypress', undefined, { name: 'right' }); input.emit('keypress', '\r', { name: 'return' });
  await running;
  assert.equal(input.isRaw, false);
  assert.ok(screen.includes('\x1b[?1049h') && screen.endsWith('\x1b[?1049l'));
  assert.equal(output.listenerCount('resize'), 0);
  assert.ok(screen.includes('\x1b[?1000h') && screen.includes('\x1b[?1000l'));
  assert.equal(input.listenerCount('data'), 0);
});

test('TUI selection depends on terminal capability, preserves explicit plain and JSON modes', () => {
  const tty = { isTTY: true } as typeof process.stdin;
  const output = { isTTY: true } as typeof process.stderr;
  assert.equal(useTui({}, tty, output, { TERM: 'xterm' }), true);
  assert.equal(useTui({ noTui: true }, tty, output, {}), false);
  assert.equal(useTui({ events: true }, tty, output, {}), false);
  assert.equal(useTui({}, { isTTY: false } as typeof process.stdin, output, {}), false);
  assert.equal(useTui({}, tty, output, { TERM: 'dumb' }), false);
});

test('TUI separates transcript and execution, shows silent processing, bounds history and adapts to width', () => {
  const model = new AgentTuiModel('researcher');
  const event = { time: '2026-09-24T01:00:00.000Z', sessionId: 'session', agentId: 'agent' };
  model.add({ ...event, kind: 'received', sequence: 1, text: 'hello from peer' });
  model.add({ ...event, kind: 'silent', text: 'No reply chosen' });
  model.add({ ...event, kind: 'waiting_peer' });
  assert.match(model.state, /no reply/);
  assert.ok(model.room[0].includes('hello from peer'));
  assert.ok(model.execution.some(x => x.includes('No reply chosen')));
  for (let i = 0; i < 1000; i++) model.log(String(i));
  assert.equal(model.execution.length, 200);
});

test('mouse input separates fragmented reports from keyboard input', async () => {
  const { TerminalInput } = await import('../src/cli/tui-input.js');
  const reports: unknown[] = [], typed: string[] = [];
  const router = new TerminalInput((...args) => reports.push(args));
  router.keyboard.on('keypress', text => { if (text) typed.push(text); });
  router.feed('a\x1b[<0;'); router.feed('4;8M\x1b[<0;4;8m'); router.feed('b\x1b[<65;4;8M');
  assert.deepEqual(reports, [[0, 3, 7, false], [0, 3, 7, true], [65, 3, 7, false]]);
  assert.equal(typed.join(''), 'ab'); router.close();
});

test('friend picker keeps UUIDs as values, disables offline choices, ignores cancelled responses', () => {
  const app = new RendezvousTui('unused');
  const sent: any[] = [];
  const model = new AgentTuiModel('reviewer');
  app.jobs.push({ id: 'job', title: 'Agent start reviewer', model, output: [], running: true, controls: true,
    child: { send: (message: any) => sent.push(message) } as unknown as ChildProcess });
  app.view = 'job'; app.selectedJob = 'job';
  app.activate(tuiActions.find(a => a.id === 'open')!);
  assert.equal(sent[0].action, 'peers');
  // Exercise the same validated IPC-result boundary used by the child listener.
  (app as any).receivePeers(app.jobs[0], { id: sent[0].id, next_cursor: null, peers: [
    { id: 'peer-one', display_name: 'Reviewer', availability: 'offline' },
    { id: 'peer-two', display_name: 'Reviewer', availability: 'available' },
  ] });
  assert.equal(app.picker!.rows.find(row => row.id === 'peer-one')!.disabled, true);
  assert.equal(app.picker!.rows[0].id, 'peer-two', 'available contacts come first');
  assert.match(app.render(120, 36, false).join('\n'), /offline.*peer-one/);
  app.picker!.choose(app.picker!.rows[0]);
  assert.equal(app.form!.values.peer, 'peer-two');
  assert.deepEqual(app.form!.action.fields!.map(field => field.key), ['message']);
  (app as any).receivePeers(app.jobs[0], { id: sent[0].id, peers: [] });
  assert.equal(app.form!.values.peer, 'peer-two');
});


test('agent cards show availability and the workspace renders an explicit private composer', () => {
  const app = new RendezvousTui('unused');
  app.profiles = [{ version: 1, name: 'reviewer', agentId: 'id', origin: 'https://relay.example', agent: 'codex', workspace: '/tmp', instructions: 'Review', credentialFile: 'credential' }];
  app.view = 'agents'; app.agentStatuses.set('reviewer', 'available');
  assert.match(app.render(120, 36, false).join('\n'), /available.*codex/);
  assert.ok(!tuiActions.some(a => a.id === 'status'));
  const model = new AgentTuiModel('reviewer');
  model.add({ kind: 'local_reply', scope: 'local', time: new Date().toISOString(), text: 'Private answer' });
  app.jobs.push({ id: 'job', title: 'Agent reviewer', model, output: [], running: true, controls: true, child: {} as ChildProcess });
  app.view = 'job'; app.selectedJob = 'job';
  const screen = app.render(120, 36, false).join('\n');
  assert.match(screen, /PRIVATE CHAT/); assert.match(screen, /Private answer/); assert.doesNotMatch(screen, /Steer session/);
});


test('chat shows final messages once, with separate private and shared transcripts', () => {
  const app = new RendezvousTui('unused');
  const model = new AgentTuiModel('Reviewer');
  const time = '2026-09-24T12:00:00.000Z';
  model.add({ kind: 'local_input', scope: 'local', time, text: 'Hello privately' });
  model.add({ kind: 'assistant', scope: 'local', time, text: '{"message":"Private answer","status":"DONE"}' });
  model.add({ kind: 'local_reply', scope: 'local', time, text: 'Private answer' });
  model.add({ kind: 'received', time, sessionId: 'session-a', text: 'Peer: Shared question' });
  app.jobs.push({ id: 'one', title: 'Agent Reviewer', model, output: [], running: true, controls: true, child: {} as ChildProcess });
  app.selectedJob = 'one'; app.view = 'job';
  const screen = app.render(120, 36, false).join('\n');
  assert.equal(screen.match(/Private answer/g)?.length, 1);
  assert.match(screen, /You  ·/); assert.match(screen, /Reviewer  ·/);
  assert.doesNotMatch(screen, /"status"|Shared question|turn_finished/);
  (app as any).switchPane('conversation');
  const shared = app.render(120, 36, false).join('\n');
  assert.match(shared, /Shared question/); assert.doesNotMatch(shared, /Private answer/);
});

test('composer separates drafts and routes explicit session instructions with stale-session protection', () => {
  const app = new RendezvousTui('unused');
  const sent: any[] = [];
  const model = new AgentTuiModel('Reviewer'); model.session = 'session-a';
  app.jobs.push({ id: 'one', title: 'Reviewer', model, output: [], running: true, controls: true,
    child: { send: (message: any) => sent.push(message) } as unknown as ChildProcess });
  app.selectedJob = 'one'; app.view = 'job';
  app.input = 'Keep this private';
  (app as any).switchPane('conversation'); assert.equal(app.input, '');
  app.input = 'Guide the session';
  (app as any).switchPane('activity'); assert.equal(app.input, 'Keep this private');
  (app as any).key(undefined, { name: 'return' });
  assert.equal(sent[0].action, 'chat'); assert.equal(sent[0].sessionId, undefined);
  app.jobs[0].chatRequest = undefined;
  (app as any).switchPane('conversation'); assert.equal(app.input, 'Guide the session');
  (app as any).key(undefined, { name: 'return' });
  assert.equal(sent[1].action, 'steer'); assert.equal(sent[1].sessionId, 'session-a');
  app.jobs[0].chatRequest = undefined; model.session = 'session-b';
  (app as any).key(undefined, { name: 'return' });
  assert.equal(sent.length, 2, 'a stale draft cannot target a replacement session');
});

test('active work cards open independent agents and preserve drafts without stopping listeners', () => {
  const app = new RendezvousTui('unused');
  for (const name of ['Reviewer', 'Writer']) app.jobs.push({ id: name, title: name, model: new AgentTuiModel(name),
    output: [], running: true, controls: true, child: {} as ChildProcess });
  app.view = 'jobs';
  const screen = app.render(120, 36, false).join('\n');
  assert.match(screen, /Reviewer.*Writer/); assert.match(screen, /Start an agent/);
  // Click the second card, then return using the keyboard shortcut.
  (app as any).mouse(0, 80, 11, false);
  assert.equal(app.selectedJob, 'Writer'); assert.equal(app.view, 'job');
  app.input = 'Writer draft';
  (app as any).key(undefined, { ctrl: true, name: 'b' });
  assert.equal(app.view, 'jobs'); assert.ok(app.jobs.every(j => j.running));
  app.selected = 0; (app as any).openSelected(); assert.equal(app.input, '');
  (app as any).key(undefined, { ctrl: true, name: 'b' });
  app.selected = 1; (app as any).openSelected(); assert.equal(app.input, 'Writer draft');
  for (const width of [46, 80, 120]) assert.ok(app.render(width, 24, false).every(line => textWidth(line) <= width - 1));
});
