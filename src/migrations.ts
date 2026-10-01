import type { Database } from "./db.js";

// Also serialize concurrent callers for a single embedded connection. Native
// PostgreSQL additionally uses a database-wide advisory lock in db.ts.
const pending = new WeakMap<Database, Promise<void>>();
export function applyMigrations(db: Database): Promise<void> {
  const run = (pending.get(db) ?? Promise.resolve())
    .catch(() => {})
    .then(() => db.migrate());
  pending.set(db, run);
  return run;
}
