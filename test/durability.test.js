import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { openDatabase } from '../src/db.js';
import { Service } from '../src/service.js';
import { fixture, join, message } from './helpers.js';

test('committed messages, replay constraints and invitations survive database restart', async () => {
  const dir = await mkdtemp(pathJoin(tmpdir(), 'rendezvous-durable-'));
  const f = await fixture({ dataDir: pathJoin(dir, 'pg') });
  let db;
  try {
    const s = await f.create(), a = await join(f, s); const m = message(f, a);
    await f.service.send(s.session_id, a.credential, m);
    await f.app.close(); await f.db.close();
    db = await openDatabase({ databaseUrl: process.env.TEST_DATABASE_URL, dataDir: pathJoin(dir, 'pg') });
    const service = new Service(db, f.auth, { clock: f.now, logger: () => {} });
    const history = await service.history(s.session_id, a.credential);
    assert.deepEqual(history.messages[0].message, m);
    assert.equal((await service.send(s.session_id, a.credential, m)).duplicate, true);
    const info = await service.inspect(s.session_id, s.owner_token);
    assert.equal(info.invites[0].use_count, 1); assert.equal(info.participants[0].last_sequence, 1);
    await db.query('DELETE FROM sessions WHERE id=$1', [s.session_id]);
  } finally { if (db) await db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('rate and durable message budgets are enforced without losing retry semantics', async () => {
  const f = await fixture({ messagesPerMinute: 2, messageBudget: 1, sessionsPerHour: 1 });
  try {
    const s = await f.service.create({}, 'same-ip');
    await assert.rejects(f.service.create({}, 'same-ip'), e => e.code === 'RATE_LIMITED');
    const a = await join(f, s); const m = message(f, a);
    await f.service.send(s.session_id, a.credential, m);
    assert.equal((await f.service.send(s.session_id, a.credential, m)).duplicate, true);
    await assert.rejects(f.service.send(s.session_id, a.credential, message(f, a, { sequence: 2 })), e => e.code === 'RATE_LIMITED');
    f.advance(61000);
    await assert.rejects(f.service.send(s.session_id, a.credential, message(f, a, { sequence: 2 })), e => e.code === 'MESSAGE_BUDGET_EXCEEDED');
    await f.db.query('DELETE FROM sessions WHERE id=$1', [s.session_id]);
  } finally { await f.stop(); }
});
