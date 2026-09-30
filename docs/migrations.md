# Database schema and migrations

`src/schema.ts` is the source of truth for all 16 PostgreSQL tables, indexes,
foreign keys, and checks. Row types are inferred from that schema. Both native
PostgreSQL (`pg`) and embedded PGlite use Drizzle query builders.

## Changing the schema

1. Edit `src/schema.ts`.
2. Run `npm run db:generate -- --name descriptive_change`.
3. Review and commit the SQL and metadata in `drizzle/` with the schema change.
4. Run `npm run db:check`, `npm run typecheck`, `npm test`, and `npm run test:postgres`.

Generation is offline and does not require database credentials. Startup runs
Drizzle's driver-specific migrator, recording applied files in
`drizzle.__drizzle_migrations`. Subsequent startups skip them. The SQL and ledger
inserts run transactionally. PostgreSQL startup takes a session advisory lock on a
pinned pool connection across both reading the ledger and applying migrations;
PGlite calls on the same database wrapper are serialized in process.

Never edit an applied migration: generate a follow-up instead. Unlike the previous
custom runner, Drizzle does not reject edits to applied SQL by checksum; review and
source control enforce migration immutability. Do not delete ledger rows to force
reapplication. Do not use `drizzle-kit push` against shared deployments.

## Fresh database required for this migration

This is an intentional pre-production baseline, not an in-place data upgrade.
The historical handwritten migration chain has been replaced by
`drizzle/0000_initial.sql`. Startup detects the old schema and exits with an
explanation **before altering it**. There is no automatic drop, reset, or adoption.

- PostgreSQL: create a new empty database and set `DATABASE_URL` to it.
  For disposable AWS dev data, alternatively follow the explicit
  [Pulumi pause/reset/resume procedure](../infra/RESET-DEV-DB.md) to reuse the
  existing database. Never reset a database while the application is running.
- PGlite: set `DATA_DIR` to a new private directory, for example
  `.data/drizzle-dev`. Keep the original directory if you want a backup.
- Existing rooms, identities, keys, and receiver leases are not copied. Create new
  agents/credentials and rooms after switching. Reconfigure local listeners.

Changing the database is a separate operator action; this PR does not run a reset
against any configured development or production database.

## Query boundaries

Use `db.orm` for typed select/insert/update/delete operations. Inside a transaction,
use **only** the supplied `tx.orm` / `tx.query`: both share the same connection and
commit/rollback boundary. Room CRUD, the shared message log, owner authentication,
identity/credential CRUD and policy CRUD use typed builders. Wire/API types remain
separate where their shape intentionally differs from stored rows.

`query`/`exec` remain explicit, parameterized SQL escape hatches for the existing
receiver/session state machine, fencing checks, joined authorization predicates,
advisory locks, and test fixtures. They are not string-building ORM emulation.
Those algorithms keep their lock order, bigint-as-string wire representation,
idempotency receipts and retention behavior. Migrating to Drizzle does not change
the public HTTP protocol. Prefer typed builders for new ordinary CRUD.

Regression coverage includes apply-once startup, failed DDL rollback, legacy schema
rejection without data loss, mixed typed/raw transaction rollback, restart durability,
message sequence ordering, grants, key revocation, receiver fencing, and receipts.
