import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
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

test('original signed-message storage migrates without losing message contents or ordering', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rendezvous-migration-'));
  const legacy = new PGlite(dir); await legacy.waitReady;
  const id = uuid(), p = uuid(), m = uuid(), raw = secret();
  const auth = security({ pepper: secret() });
  const unusedInvite = secret(), usedInvite = secret();
  try {
    await legacy.exec(await readFile(new URL('./fixtures/legacy.sql', import.meta.url), 'utf8'));
    await legacy.query("INSERT INTO sessions(id,owner_hash,expires_at,max_participants,next_message_offset) VALUES($1,$2,now()+interval '1 day',2,3)", [id, auth.digest(raw)]);
    for (const [token, uses] of [[unusedInvite, 0], [usedInvite, 2]] as const) {
      await legacy.query('INSERT INTO invites(id,session_id,secret_hash,max_uses,use_count,expires_at) VALUES($1,$2,$3,3,$4,now()+interval \'1 day\')', [uuid(), id, auth.digest(token), uses]);
    }
    await legacy.query("INSERT INTO participants(id,session_id,public_key,metadata_json) VALUES($1,$2,'legacy-key',$3)", [p, id, JSON.stringify({ name: 'Legacy' })]);
    await legacy.query('INSERT INTO messages(id,session_id,sender_participant_id,message_offset,sequence,envelope,envelope_hash) VALUES($1,$2,$3,1,1,$4,$5)', [m, id, p, JSON.stringify({ payload: { text: 'preserved text' } }), 'legacy-hash']);
    await legacy.query('INSERT INTO messages(id,session_id,sender_participant_id,message_offset,sequence,envelope,envelope_hash) VALUES($1,$2,$3,2,2,$4,$5)', [uuid(), id, p, JSON.stringify({ payload: { custom: true } }), 'legacy-hash-2']);
  } finally { await legacy.close(); }
  const db = await openDatabase({ dataDir: dir });
  try {
    const service = new Service(db, auth, { logger: () => {} });
    const page = await service.messages(id, raw, 0, 0);
    assert.deepEqual(page.messages.map(m => m.sequence), [1, 2]); assert.equal(page.messages[0].content, 'preserved text');
    assert.deepEqual(JSON.parse(page.messages[1].content), { custom: true });
    const info = await service.inspect(id, raw); assert.equal(info.participants[0].display_name, 'Legacy'); assert.ok(info.participants[0].revoked_at);
    const migratedInvites = (await db.query<{ max_uses: number; use_count: number }>('SELECT max_uses,use_count FROM invites WHERE session_id=$1 ORDER BY use_count', [id])).rows;
    assert.deepEqual(migratedInvites, [{ max_uses: 3, use_count: 0 }, { max_uses: 3, use_count: 2 }]);
    const lastUse = await service.join(id, { invite_token: usedInvite }, 'test');
    await service.leave(id, lastUse.participant_token);
    await assert.rejects(service.join(id, { invite_token: usedInvite }, 'test'), { code: 'INVITE_EXHAUSTED' });
    const admitted = await service.join(id, { invite_token: unusedInvite }, 'test');
    await service.leave(id, admitted.participant_token);

    await assert.rejects(db.query('UPDATE invites SET max_uses=11 WHERE session_id=$1', [id]));
    const invitation = await service.invite(id, raw, {}); const joined = await service.join(id, { invite_token: invitation.invite_token }, 'test');
    assert.equal((await service.send(id, joined.participant_token, { content: 'new text' })).sequence, 3);
    const columns = (await db.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name IN ('participants','messages')")).rows.map(r => r.column_name);
    for (const obsolete of ['public_key', 'last_sequence', 'envelope', 'envelope_hash', 'message_offset', 'a2a_endpoint']) assert.ok(!columns.includes(obsolete));
  } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('single-use databases regain reusable invites once and preserve later limits on restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rendezvous-reusable-'));
  let db = await openDatabase({ dataDir: dir });
  const auth = security({ pepper: secret() });
  try {
    const service = new Service(db, auth, { logger: () => {} });
    const room = await service.create({ max_participants: 3 }, 'test');
    await service.join(room.session_id, { invite_token: room.invite_token }, 'test');
    await db.exec(await readFile(new URL('../migrations/004_single_use_invites.sql', import.meta.url), 'utf8'));
    // Model an old installation, before apply-once history existed.
    await db.exec('ALTER TABLE messages DROP CONSTRAINT messages_one_sender; ALTER TABLE messages DROP COLUMN sender_owner_id; DROP TABLE schema_migrations; DROP TABLE agent_peer_policies; DROP TABLE agent_message_receipts;');
    await db.close(); db = await openDatabase({ dataDir: dir });
    const restored = new Service(db, auth, { logger: () => {} });
    const invite = (await restored.inspect(room.session_id, room.owner_token)).invites![0];
    assert.equal(invite.max_uses, 3); assert.equal(invite.use_count, 1);
    await restored.join(room.session_id, { invite_token: room.invite_token }, 'second');
    const limited = await restored.invite(room.session_id, room.owner_token, { max_uses: 1 });
    await db.close(); db = await openDatabase({ dataDir: dir });
    const limits = (await db.query<{ max_uses: number }>('SELECT max_uses FROM invites WHERE id=$1', [limited.invite_id])).rows;
    assert.equal(limits[0].max_uses, 1);
  } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
});
