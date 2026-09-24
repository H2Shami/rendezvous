import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { AgentTuiModel, useTui } from '../src/cli/agent-tui.js';
import { RendezvousTui } from '../src/cli/tui-app.js';
import { parseCommand, tuiActions } from '../src/cli/tui-actions.js';
import { textWidth } from '../src/cli/tui-screen.js';

test('workspace offers all CLI workflows and parses advanced arguments without a shell', () => {
  for (const id of ['setup', 'start', 'inspect', 'status', 'create', 'join', 'owner', 'agents', 'rooms', 'config', 'open', 'close', 'run']) {
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
  const running = app.run(); await new Promise(resolve => setImmediate(resolve));
  input.emit('keypress', '/', {}); input.emit('keypress', 'set up', {});
  input.emit('keypress', '\r', { name: 'return' });
  assert.equal(app.form?.action.id, 'setup');
  input.emit('keypress', 'reviewer', {}); assert.equal(app.form?.values.profile, 'reviewer');
  input.emit('keypress', undefined, { name: 'escape' });
  input.emit('keypress', '2', {}); assert.equal(app.view, 'agents');
  const sent: any[] = [];
  const model = new AgentTuiModel('reviewer'); model.session = 'original-session';
  app.jobs.push({ id: 'reviewer', title: 'Agent start reviewer', child: { send: (message: any) => sent.push(message) } as unknown as ChildProcess, model, output: [], running: true, controls: true });
  app.selectedJob = 'reviewer';
  app.activate(tuiActions.find(a => a.id === 'close')!);
  model.session = 'new-session';
  input.emit('keypress', 'yes', {}); input.emit('keypress', '\r', { name: 'return' });
  assert.equal(sent[0].sessionId, 'original-session', 'confirmation stays bound to the original session');
  app.jobs[0].running = false;
  output.columns = 40; output.emit('resize');
  app.activate(tuiActions.find(a => a.id === 'quit')!);
  input.emit('keypress', 'yes', {}); input.emit('keypress', '\r', { name: 'return' });
  await running;
  assert.equal(input.isRaw, false);
  assert.ok(screen.includes('\x1b[?1049h') && screen.endsWith('\x1b[?1049l'));
  assert.equal(output.listenerCount('resize'), 0);
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
