CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'WAITING' CHECK (status IN ('WAITING','ACTIVE','CLOSED')),
  owner_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  max_participants integer NOT NULL CHECK (max_participants BETWEEN 1 AND 10),
  next_sequence integer NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS invites (
  id uuid PRIMARY KEY, session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  secret_hash text NOT NULL, max_uses integer NOT NULL CHECK (max_uses BETWEEN 1 AND 10),
  use_count integer NOT NULL DEFAULT 0, expires_at timestamptz NOT NULL,
  revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invites_session ON invites(session_id);
CREATE TABLE IF NOT EXISTS participants (
  id uuid PRIMARY KEY, session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  credential_hash text, display_name text, metadata_json json NOT NULL DEFAULT '{}',
  joined_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
  left_at timestamptz, last_seen_at timestamptz
);
CREATE INDEX IF NOT EXISTS participants_session ON participants(session_id);
CREATE TABLE IF NOT EXISTS security_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event text NOT NULL, session_id uuid REFERENCES sessions(id) ON DELETE CASCADE,
  participant_id uuid, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS security_events_time ON security_events(created_at);
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY, session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sender_participant_id uuid NOT NULL REFERENCES participants(id),
  sequence integer NOT NULL, content text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(session_id, sequence)
);
