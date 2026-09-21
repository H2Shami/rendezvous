CREATE TABLE IF NOT EXISTS owners (
  id uuid PRIMARY KEY,
  issuer text NOT NULL,
  subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  UNIQUE (issuer, subject)
);
CREATE TABLE IF NOT EXISTS owner_login_attempts (
  state_hash text PRIMARY KEY,
  browser_hash text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS owner_login_expiry ON owner_login_attempts(expires_at);
