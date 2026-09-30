import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { Service } from '../src/service.js';
import { security } from '../src/security.js';
import { secret, uuid } from '../src/validation.js';

test('messages, tokens and ordering survive a database/service restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rendezvous-durable-')); const auth = security({ pepper: secret() });
  let db = await openDatabase({ dataDir: dir });
  try {
    let service = new Service(db, auth, { logger: () => {} });
    const room = await service.create({}, 'test'); const p = await service.join(room.session_id, { invite_token: room.invite_token }, 'test');
    await service.send(room.session_id, p.participant_token, { content: 'stored while nobody is polling' });
    await db.close(); db = await openDatabase({ dataDir: dir }); service = new Service(db, auth, { logger: () => {} });
    const page = await service.messages(room.session_id, p.participant_token, 0, 0);
    assert.equal(page.messages[0].content, 'stored while nobody is polling'); assert.equal(page.cursor, 1);
    assert.equal((await service.send(room.session_id, p.participant_token, { content: 'after restart' })).sequence, 2);
  } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
});
