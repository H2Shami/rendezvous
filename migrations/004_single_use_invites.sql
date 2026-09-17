-- Preserve historical use counts and admitted participants. Previously used
-- invites stay exhausted; unused invites admit exactly one participant.
UPDATE invites SET max_uses=1 WHERE max_uses<>1;
ALTER TABLE invites DROP CONSTRAINT IF EXISTS invites_max_uses_check;
ALTER TABLE invites ADD CONSTRAINT invites_max_uses_check CHECK (max_uses=1);
