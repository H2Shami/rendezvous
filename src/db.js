import { readFile } from 'node:fs/promises';

export async function openDatabase({ databaseUrl, dataDir = '.data/postgres' } = {}) {
  let db;
  if (databaseUrl) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
    db = {
      query: (q, p) => pool.query(q, p),
      exec: q => pool.query(q),
      transaction: async fn => {
        const client = await pool.connect();
        try { await client.query('BEGIN'); const out = await fn(client); await client.query('COMMIT'); return out; }
        catch (err) { await client.query('ROLLBACK'); throw err; }
        finally { client.release(); }
      },
      close: () => pool.end(),
    };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    db = new PGlite(dataDir);
    await db.waitReady;
  }
  await db.exec(await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'));
  return db;
}
export const one = async (db, sql, args = []) => (await db.query(sql, args)).rows[0];
