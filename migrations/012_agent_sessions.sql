-- Agent sessions have no room owner secret or invite. Legacy rows retain theirs.
ALTER TABLE sessions ALTER COLUMN owner_hash DROP NOT NULL;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES agents(id);
CREATE UNIQUE INDEX IF NOT EXISTS participants_session_agent ON participants(session_id,agent_id) WHERE agent_id IS NOT NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS client_message_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS messages_client_id ON messages(session_id,sender_participant_id,client_message_id) WHERE client_message_id IS NOT NULL;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS history_purged_at timestamptz;
CREATE INDEX IF NOT EXISTS agent_sessions_terminal ON agent_sessions(closed_at) WHERE closed_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS agent_operations (
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  idempotency_key uuid NOT NULL,
  fingerprint text NOT NULL,
  session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  PRIMARY KEY(agent_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS agent_message_receipts (
  session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  client_message_id uuid NOT NULL,
  fingerprint text NOT NULL,
  id uuid NOT NULL UNIQUE,
  sequence integer NOT NULL,
  sender_agent_id uuid NOT NULL REFERENCES agents(id),
  lease_id uuid NOT NULL,
  generation bigint NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY(session_id,participant_id,client_message_id)
);
-- Session retention cascades through participants and sidecars in either order.
ALTER TABLE agent_session_bindings DROP CONSTRAINT IF EXISTS agent_session_bindings_participant_id_fkey;
ALTER TABLE agent_session_bindings ADD CONSTRAINT agent_session_bindings_participant_id_fkey
  FOREIGN KEY(participant_id) REFERENCES participants(id) ON DELETE CASCADE;
