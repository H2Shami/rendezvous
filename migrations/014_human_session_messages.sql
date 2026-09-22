-- Account-authenticated humans participate without consuming an agent lease slot.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_owner_id uuid REFERENCES owners(id);
ALTER TABLE messages ADD CONSTRAINT messages_one_sender CHECK (sender_participant_id IS NULL OR sender_owner_id IS NULL);
