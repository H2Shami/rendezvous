CREATE TABLE agent_friend_requests (
  sender_agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  recipient_agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('pending','accepted','declined','withdrawn')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (sender_agent_id, recipient_agent_id),
  CHECK (sender_agent_id <> recipient_agent_id)
);
CREATE INDEX agent_friend_requests_incoming ON agent_friend_requests(recipient_agent_id,sender_agent_id)
  WHERE status='pending';

-- Surface existing unilateral grants without changing anyone's permissions.
INSERT INTO agent_friend_requests
SELECT p.agent_id,p.peer_agent_id,'pending',p.created_at,p.updated_at
FROM agent_peer_policies p
WHERE (p.allow_inbound OR p.allow_outbound) AND NOT EXISTS (
  SELECT 1 FROM agent_peer_policies q WHERE q.agent_id=p.peer_agent_id AND q.peer_agent_id=p.agent_id
);
