# Database migrations

Add a new numbered SQL file for schema or data changes, and register it in
`src/migrations.ts`. Never edit a migration that has been applied. A follow-up
migration must make any correction. Retired migration 004 remains excluded because
it would reset invitation limits; 005 handles upgrades from that historical state.

The runner records each filename, SHA-256 checksum and application timestamp in
`schema_migrations`. Startup executes only pending files and rejects an applied
file whose checksum has changed. SQL and history entries commit in one transaction;
a failure rolls both back. PostgreSQL uses a transaction advisory lock to serialize
concurrent startup, including the first creation of the history table. PGlite
serializes transactions on its single connection.

Migration 013 creates the history table. The runner bootstraps this metadata table
before processing historical files, then records 013 along with the other pending
migrations in the same transaction. It does not repeatedly execute historical SQL.

## Adopting databases without recorded history

Before this change, startup reran the registered migration list in one transaction.
The new runner recognizes completed REN-9 schemas by `agent_peer_policies`, and
pre-ledger REN-10 development schemas by `agent_message_receipts`. It baselines
files through 011 or 012 respectively without executing them, preserving existing
session/participant state. Those entries have `baselined: true`; their checksums
record the repository version adopted now, not proof of which bytes ran previously.
This assumes databases produced by the application's atomic migration runner,
not manually assembled partial schemas.

Fresh databases and older schemas without those markers run the historical,
previously idempotent upgrade chain once, then record it. Existing legacy-format
and single-use-invitation upgrade tests cover this path. On subsequent startups,
all recorded migrations are skipped.

Do not delete history rows to force migrations to rerun. Investigate a checksum
mismatch and restore the original file, then add a new migration for the desired
change. Checksums prevent accidental historical edits; they do not replace backups
or review of migration SQL.
