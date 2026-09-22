import { applyMigrations } from "./migrations.js";
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";

export interface Queryable {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
}

export interface Database extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function openDatabase({
  databaseUrl,
  dataDir = ".data/postgres",
}: { databaseUrl?: string; dataDir?: string } = {}): Promise<Database> {
  let db: Database;
  if (databaseUrl) {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
    const wrap = (client: pg.Pool | pg.PoolClient): Queryable => ({
      query: async <T>(sql: string, args?: unknown[]) => ({
        rows: (await client.query(sql, args)).rows as T[],
      }),
      exec: (sql) => client.query(sql),
    });
    db = {
      ...wrap(pool),
      close: () => pool.end(),
      transaction: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const result = await fn(wrap(client));
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      },
    };
  } else {
    const embedded = new PGlite(dataDir);
    await embedded.waitReady;
    db = {
      query: (sql, args) => embedded.query(sql, args),
      exec: (sql) => embedded.exec(sql),
      transaction: (fn) => embedded.transaction((tx) => fn(tx)),
      close: () => embedded.close(),
    };
  }
  try {
    await applyMigrations(db, Boolean(databaseUrl));
  } catch (error) {
    await db.close();
    throw error;
  }
  return db;
}

export const one = async <T>(
  db: Queryable,
  sql: string,
  args: unknown[] = [],
) => (await db.query<T>(sql, args)).rows[0];
