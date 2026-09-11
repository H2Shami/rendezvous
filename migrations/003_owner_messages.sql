-- NULL sender is the session owner; ordinary senders retain their participant FK.
-- Owners can contribute without consuming an invited participant slot.
ALTER TABLE messages ALTER COLUMN sender_participant_id DROP NOT NULL;
