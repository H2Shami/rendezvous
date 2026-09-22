-- Bootstrapped by the runner before applying or adopting historical migrations.
CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  baselined boolean NOT NULL DEFAULT false
);
