import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { openDatabase, type Database } from '../src/db.js';
import { applyMigrations, migrationFiles } from '../src/migrations.js';

test('migration history applies once, serializes startup and rejects changed applied SQL', async () => {
  const db = await openDatabase({ databaseUrl: process.env.TEST_DATABASE_URL, dataDir: 'memory://' });
  try {
    const before = (await db.query('SELECT name,checksum,applied_at FROM schema_migrations ORDER BY name')).rows;
    assert.equal(before.length, migrationFiles.length);
    await Promise.all([applyMigrations(db, Boolean(process.env.TEST_DATABASE_URL)), applyMigrations(db, Boolean(process.env.TEST_DATABASE_URL))]);
    assert.deepEqual((await db.query('SELECT name,checksum,applied_at FROM schema_migrations ORDER BY name')).rows, before);
    // Alter only the test database's checksum, never an actual migration file.
    const saved = (await db.query<{ checksum: string }>("SELECT checksum FROM schema_migrations WHERE name='002_http.sql'")).rows[0].checksum;
    try {
      await db.query("UPDATE schema_migrations SET checksum='changed' WHERE name='002_http.sql'");
      await assert.rejects(applyMigrations(db, Boolean(process.env.TEST_DATABASE_URL)), /Applied migration changed: 002_http.sql/);
    } finally { await db.query("UPDATE schema_migrations SET checksum=$1 WHERE name='002_http.sql'", [saved]); }
    assert.deepEqual((await db.query('SELECT name,checksum,applied_at FROM schema_migrations ORDER BY name')).rows, before);
  } finally { await db.close(); }
});

test('failed migration rolls back its SQL and is not recorded as applied', async () => {
  const db = await openDatabase({ dataDir: 'memory://' });
  try {
    await db.query("DELETE FROM schema_migrations WHERE name='012_agent_sessions.sql'");
    const failing: Database = { ...db, transaction: fn => db.transaction(tx => fn({
      query: (sql, params) => tx.query(sql, params),
      exec: async sql => {
        await tx.exec(sql);
        if (sql.includes('CREATE TABLE IF NOT EXISTS agent_message_receipts')) {
          await tx.exec('CREATE TABLE failed_migration_marker(id integer)');
          throw new Error('migration failure');
        }
      },
    })) };
    await assert.rejects(applyMigrations(failing), /migration failure/);
    assert.equal((await db.query<{ present: boolean }>("SELECT to_regclass('failed_migration_marker') IS NOT NULL AS present")).rows[0].present, false);
    assert.equal((await db.query("SELECT name FROM schema_migrations WHERE name='012_agent_sessions.sql'")).rows.length, 0);
    await applyMigrations(db);
    assert.equal((await db.query('SELECT name FROM schema_migrations')).rows.length, migrationFiles.length);
  } finally { await db.close(); }
});

test('pre-ledger REN-9 databases baseline historical migrations and apply only new changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rendezvous-pre-ledger-'));
  const old = new PGlite(dir); await old.waitReady;
  try {
    for (const file of migrationFiles.filter(m => m.slice(0, 3) <= '011')) await old.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
    // 002 would reset this status if replayed. No session participant is needed
    // for the migration runner to preserve the application's existing data.
    await old.exec("INSERT INTO sessions(id,status,owner_hash,expires_at,max_participants) VALUES('11111111-1111-4111-8111-111111111111','ACTIVE','hash',now()+interval '1 day',2)");
  } finally { await old.close(); }
  const db = await openDatabase({ dataDir: dir });
  try {
    assert.equal((await db.query<{ status: string }>('SELECT status FROM sessions')).rows[0].status, 'ACTIVE');
    const history = (await db.query<{ name: string; baselined: boolean }>('SELECT name,baselined FROM schema_migrations')).rows;
    assert.equal(history.length, migrationFiles.length);
    for (const m of history) assert.equal(m.baselined, m.name.slice(0, 3) <= '011');
    assert.equal((await db.query<{ present: boolean }>("SELECT to_regclass('agent_message_receipts') IS NOT NULL AS present")).rows[0].present, true);
  } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
});
