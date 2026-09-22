import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Database } from './db.js';

// 004 was retired by 005; replaying it would reset existing invitation limits.
export const migrationFiles = [
  '001_initial.sql', '002_http.sql', '003_owner_messages.sql', '005_reusable_invites.sql',
  '006_owner_auth.sql', '007_owner_login_flow.sql', '008_workos_auth.sql',
  '009_agent_identities.sql', '010_agent_receivers.sql', '011_agent_peer_policies.sql',
  '012_agent_sessions.sql', '013_migration_history.sql', '014_human_session_messages.sql',
] as const;
const historyFile = '013_migration_history.sql';

export async function applyMigrations(db: Database, nativePostgres = false) {
  const migrations = await Promise.all(migrationFiles.map(async name => {
    const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
  await db.transaction(async tx => {
    // Serialize even the first creation of the ledger across PostgreSQL processes.
    // PGlite already serializes transactions on its single connection.
    if (nativePostgres) await tx.query('SELECT pg_advisory_xact_lock(72656, 1)');
    const existing = (await tx.query<{ present: boolean }>("SELECT to_regclass('schema_migrations') IS NOT NULL AS present")).rows[0].present;
    if (!existing) {
      await tx.exec(migrations.find(m => m.name === historyFile)!.sql);
      // The previous runner committed the whole migration list atomically. These
      // terminal tables identify completed REN-9 or pre-ledger REN-10 installs.
      // Adopt their history without replaying 002 over agent participants.
      const markers = (await tx.query<{ sessions: boolean; policies: boolean }>(`SELECT
        to_regclass('agent_message_receipts') IS NOT NULL AS sessions,
        to_regclass('agent_peer_policies') IS NOT NULL AS policies`)).rows[0];
      const baseline = markers.sessions ? '012' : markers.policies ? '011' : '';
      for (const m of migrations.filter(m => m.name.slice(0, 3) <= baseline)) {
        await tx.query('INSERT INTO schema_migrations(name,checksum,baselined) VALUES($1,$2,true)', [m.name, m.checksum]);
      }
    }
    const applied = new Map((await tx.query<{ name: string; checksum: string }>('SELECT name,checksum FROM schema_migrations')).rows.map(m => [m.name, m.checksum]));
    for (const m of migrations) {
      const checksum = applied.get(m.name);
      if (checksum !== undefined) {
        if (checksum !== m.checksum) throw new Error(`Applied migration changed: ${m.name}. Add a new migration instead.`);
        continue;
      }
      // The ledger's bootstrap above already executed this new migration.
      if (existing || m.name !== historyFile) await tx.exec(m.sql);
      await tx.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [m.name, m.checksum]);
    }
  });
}
