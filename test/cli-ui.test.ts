import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colorEnabled, CRIMSON, plainTerminal } from '../src/cli/ui.js';

test('crimson theme respects terminal and standard color overrides', () => {
  assert.equal(CRIMSON, '\x1b[38;2;223;7;18m');
  assert.equal(colorEnabled({ isTTY: true }, {}), true);
  assert.equal(colorEnabled({ isTTY: false }, {}), false);
  assert.equal(colorEnabled({ isTTY: true }, { NO_COLOR: '' }), false);
  assert.equal(colorEnabled({ isTTY: false }, { FORCE_COLOR: '1' }), true);
  assert.equal(colorEnabled({ isTTY: true }, { FORCE_COLOR: '0' }), false);
  assert.equal(colorEnabled({ isTTY: true }, { TERM: 'dumb' }), false);
  assert.ok(!plainTerminal('\x1b[2Jhello').includes('\x1b'));
});
