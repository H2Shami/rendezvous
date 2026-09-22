CREATE TABLE IF NOT EXISTS agent_peer_policies (
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  peer_agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  allow_inbound boolean NOT NULL DEFAULT false,
  allow_outbound boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (agent_id, peer_agent_id),
  CHECK (agent_id <> peer_agent_id)
);
CREATE INDEX IF NOT EXISTS agent_peer_policies_peer ON agent_peer_policies(peer_agent_id);
CREATE INDEX IF NOT EXISTS agent_sessions_policy_pair ON agent_sessions(initiator_agent_id,recipient_agent_id,id)
  WHERE state IN ('pending','active');
