-- Upgrade original signed-message and intermediate discovery databases in place.
-- Keep admission records and message contents; discard obsolete transport fields.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS next_sequence integer NOT NULL DEFAULT 1;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS credential_hash text;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS left_at timestamptz;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS content text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='messages' AND column_name='envelope') THEN
    ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_sender_participant_id_sequence_key;
    UPDATE messages SET content=COALESCE(envelope->'payload'->>'text', (envelope->'payload')::text, ''),
      sequence=message_offset, created_at=received_at;
  END IF;
END $$;
UPDATE participants SET display_name=metadata_json->>'name' WHERE display_name IS NULL;
-- Old signing-only identities cannot authenticate in the token-based API.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='participants' AND column_name='agent_id') THEN
    UPDATE participants SET revoked_at=COALESCE(revoked_at,now()) WHERE credential_hash IS NULL AND agent_id IS NULL;
  ELSE
    UPDATE participants SET revoked_at=COALESCE(revoked_at,now()) WHERE credential_hash IS NULL;
  END IF;
END $$;
ALTER TABLE participants DROP COLUMN IF EXISTS public_key;
ALTER TABLE participants DROP COLUMN IF EXISTS last_sequence;
ALTER TABLE participants DROP COLUMN IF EXISTS a2a_endpoint;
ALTER TABLE participants DROP COLUMN IF EXISTS agent_card_url;
ALTER TABLE participants DROP COLUMN IF EXISTS agent_card;
ALTER TABLE messages DROP COLUMN IF EXISTS envelope;
ALTER TABLE messages DROP COLUMN IF EXISTS envelope_hash;
ALTER TABLE messages DROP COLUMN IF EXISTS message_offset;
ALTER TABLE messages DROP COLUMN IF EXISTS received_at;
ALTER TABLE messages ALTER COLUMN content SET NOT NULL;
ALTER TABLE sessions DROP COLUMN IF EXISTS next_message_offset;
ALTER TABLE sessions DROP COLUMN IF EXISTS message_budget;
DROP TABLE IF EXISTS challenges;
UPDATE sessions SET next_sequence=GREATEST(next_sequence, COALESCE((SELECT max(sequence)+1 FROM messages WHERE session_id=sessions.id),1));
UPDATE sessions SET status=CASE WHEN (SELECT count(*) FROM participants WHERE session_id=sessions.id AND revoked_at IS NULL AND left_at IS NULL)>=LEAST(max_participants,2) THEN 'ACTIVE' ELSE 'WAITING' END WHERE status<>'CLOSED' AND owner_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS messages_session_sequence ON messages(session_id,sequence);
CREATE UNIQUE INDEX IF NOT EXISTS participants_credential ON participants(session_id,credential_hash);
