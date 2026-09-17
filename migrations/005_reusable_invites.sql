-- Upgrade databases that previously enforced single-use invites once.
-- Do not replay 004: it would reset invite limits on every startup.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='invites'::regclass
    AND conname='invites_max_uses_check' AND pg_get_constraintdef(oid) NOT LIKE '%10%') THEN
    ALTER TABLE invites DROP CONSTRAINT invites_max_uses_check;
    UPDATE invites i SET max_uses=s.max_participants FROM sessions s WHERE s.id=i.session_id;
    ALTER TABLE invites ADD CONSTRAINT invites_max_uses_check CHECK (max_uses BETWEEN 1 AND 10);
  END IF;
END $$;
