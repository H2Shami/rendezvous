import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { AgentTui, AgentTuiModel, useTui } from '../src/cli/agent-tui.js';

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
  assert.match(model.render(120, 24).join('\n'), /ROOM TRANSCRIPT.*HARNESS EXECUTION/);
  const narrow = model.render(40, 12);
  assert.ok(narrow.length <= 12 && narrow.every(x => [...x].length <= 39));
  model.tab = 'execution'; assert.match(model.render(80, 24).join('\n'), /No reply chosen/);
  for (let i = 0; i < 1000; i++) model.log(String(i));
  assert.equal(model.execution.length, 200);
});

test('TUI input, cancellation, resize and shutdown restore terminal state', async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(raw: boolean) { this.isRaw = raw; return this; } });
  let screen = '', quits = 0;
  const output = Object.assign(new Writable({ write(chunk, _encoding, done) { screen += chunk; done(); } }), { isTTY: true, columns: 120, rows: 24 });
  const tui = new AgentTui('test', () => { quits++; }, input as unknown as typeof process.stdin, output as unknown as typeof process.stderr);
  try {
    assert.equal(input.isRaw, true);
    const pending = tui.ask('session', 'Choose scope', new AbortController().signal);
    input.emit('keypress', 'API', {}); input.emit('keypress', '\r', { name: 'return' });
    assert.equal(await pending, 'API');
    const abort = new AbortController();
    const rejected = tui.ask('session', 'Next?', abort.signal);
    abort.abort(new Error('closed')); await assert.rejects(rejected, /closed/);
    input.emit('keypress', '\t', { name: 'tab' }); assert.equal(tui.model.tab, 'execution');
    input.emit('keypress', undefined, { name: 'pageup' }); assert.equal(tui.model.scroll, 10);
    output.columns = 40; output.emit('resize');
    input.emit('keypress', '\x03', { name: 'c', ctrl: true }); assert.equal(quits, 1);
    assert.ok(screen.includes('\x1b[?1049h'));
  } finally { tui.stop(); tui.stop(); }
  assert.equal(input.isRaw, false); assert.ok(screen.endsWith('\x1b[?7h\x1b[?25h\x1b[?1049l'));
  assert.equal(output.listenerCount('resize'), 0);
});
