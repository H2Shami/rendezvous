import { applyMigrations } from "./migrations.js";
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as postgresDrizzle } from "drizzle-orm/node-postgres";
import { drizzle as pgliteDrizzle } from "drizzle-orm/pglite";
import {
  PgDatabase,
  PgDialect,
  type PgQueryResultHKT,
} from "drizzle-orm/pg-core";
import { PgliteSession } from "drizzle-orm/pglite";
import * as schema from "./schema.js";
import { migrate as migratePostgres } from "drizzle-orm/node-postgres/migrator";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";

const migrationsFolder = fileURLToPath(new URL("../drizzle/", import.meta.url));
async function assertFreshOrDrizzle(db: Queryable) {
  const { rows } = await db.query<{ legacy: boolean }>(`SELECT
    (to_regclass('public.sessions') IS NOT NULL OR to_regclass('public.schema_migrations') IS NOT NULL)
    AND to_regclass('drizzle.__drizzle_migrations') IS NULL AS legacy`);
  if (rows[0].legacy)
    throw new Error(
      "Legacy database detected. Drizzle requires a fresh database or DATA_DIR; existing data has not been modified. See docs/migrations.md.",
    );
}

export type Orm = Pick<
  PgDatabase<PgQueryResultHKT, typeof schema>,
  "select" | "insert" | "update" | "delete"
>;

export interface Queryable {
  readonly orm: Orm;
  // Explicit SQL escape hatch for lease fencing/advisory locks and test fixtures.
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
}

export interface Database extends Queryable {
  migrate(): Promise<void>;
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
      orm: postgresDrizzle(client, { schema }),
      query: async <T>(sql: string, args?: unknown[]) => ({
        rows: (await client.query(sql, args)).rows as T[],
      }),
      exec: (sql) => client.query(sql),
    });
    db = {
      ...wrap(pool),
      close: () => pool.end(),
      migrate: async () => {
        const client = await pool.connect();
        try {
          // The migrator opens its own transaction; hold a session lock on this
          // pinned connection across the ledger read and the entire migration.
          await client.query("SELECT pg_advisory_lock(72656, 1)");
          await assertFreshOrDrizzle(wrap(client));
          await migratePostgres(postgresDrizzle(client, { schema }), {
            migrationsFolder,
          });
        } finally {
          try {
            await client.query("SELECT pg_advisory_unlock(72656, 1)");
          } finally {
            client.release();
          }
        }
      },
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
      orm: pgliteDrizzle(embedded, { schema }),
      migrate: async () => {
        await assertFreshOrDrizzle(db);
        await migratePglite(pgliteDrizzle(embedded, { schema }), {
          migrationsFolder,
        });
      },
      query: (sql, args) => embedded.query(sql, args),
      exec: (sql) => embedded.exec(sql),
      transaction: (fn) =>
        embedded.transaction((tx) =>
          fn({
            query: (sql, args) => tx.query(sql, args),
            exec: (sql) => tx.exec(sql),
            // Bind typed builders to the SAME PGlite transaction as the SQL escape
            // hatch. PgliteSession explicitly accepts PGlite's Transaction client.
            orm: new PgDatabase(
              new PgDialect(),
              new PgliteSession(tx, new PgDialect(), undefined),
              undefined,
            ),
          }),
        ),
      close: () => embedded.close(),
    };
  }
  try {
    await applyMigrations(db);
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
