/** Agent Friends wire contract. Identity, policy, receiver and session endpoints are implemented.
 * See docs/agent-friends-protocol.md. Keep independent of DB, CLI and server. */
export const AGENT_FRIENDS_PROTOCOL = "agent-friends-http-v1" as const;
export type UUID = string;
export type Timestamp = string;
export interface ProtocolEnvelope { protocol: typeof AGENT_FRIENDS_PROTOCOL }
/** Human owner management and runtime self-profile responses (REN-7). */
export interface AgentProfile { id: UUID; display_name: string }
export interface ManagedAgent extends AgentProfile {
  created_at: Timestamp; updated_at: Timestamp; disabled_at: Timestamp | null;
}
export interface AgentCredential {
  id: UUID; agent_id: UUID; created_at: Timestamp; revoked_at: Timestamp | null; last_used_at: Timestamp | null;
}
export interface AgentProfileResponse extends ProtocolEnvelope { agent: AgentProfile; availability: Availability }
export interface ManagedAgentResponse extends ProtocolEnvelope { agent: ManagedAgent }
export interface AgentListResponse extends ProtocolEnvelope { agents: ManagedAgent[]; next_cursor: UUID | null }
export interface CredentialListResponse extends ProtocolEnvelope { credentials: AgentCredential[]; next_cursor: UUID | null }
export interface IssuedCredentialResponse extends ProtocolEnvelope {
  credential: AgentCredential;
  /** Returned only by issuance/rotation; never persisted or returned by reads. */
  api_key: string;
}
export interface ReceiverReference { lease_id: UUID; generation: string }
export type Availability = "offline" | "paused" | "busy" | "available";
export type SessionState = "pending" | "active" | "closed" | "expired";
export type CloseReason = "COMPLETED" | "REJECTED" | "RECEIVER_LOST" |
  "ACCESS_REVOKED" | "OFFER_TIMEOUT" | "IDLE_TIMEOUT" | "LIFETIME_EXCEEDED" | "MESSAGE_BUDGET";
export interface SessionLimits {
  max_message_bytes: number;
  idle_timeout_seconds: number;
  max_session_seconds: number;
  message_budget: number;
}
export interface AgentLimits extends SessionLimits {
  inbound_sessions_per_hour: number;
  max_concurrent_sessions: number;
  messages_per_minute: number;
}
export interface SessionSnapshot {
  id: UUID;
  initiator_agent_id: UUID;
  recipient_agent_id: UUID;
  state: SessionState;
  version: number;
  created_at: Timestamp;
  offer_expires_at: Timestamp;
  expires_at: Timestamp;
  idle_expires_at: Timestamp | null;
  closed_at: Timestamp | null;
  close_reason: CloseReason | null;
  limits: SessionLimits;
}
export interface SessionResponse extends ProtocolEnvelope { session: SessionSnapshot }
export interface AcquireReceiverInput { connection_id: UUID; takeover: boolean }
export interface AcquireReceiverResponse extends ProtocolEnvelope {
  agent_id: UUID;
  receiver: ReceiverReference;
  expires_at: Timestamp;
  heartbeat_seconds: number;
  limits: AgentLimits;
}
export interface ReceiverInput { receiver: ReceiverReference }
export interface HeartbeatInput extends ReceiverInput { accepting_sessions: boolean }
export interface HeartbeatResponse extends ProtocolEnvelope {
  receiver: ReceiverReference;
  expires_at: Timestamp;
  sessions_to_stop: UUID[];
}
export interface ReleaseReceiverResponse extends ProtocolEnvelope { released: true }
export interface InboxResponse extends ProtocolEnvelope { offers: SessionSnapshot[] }
export interface SessionBindingInput extends ReceiverInput { binding_id: UUID }
export interface OpenSessionInput extends SessionBindingInput {
  idempotency_key: UUID;
  recipient_agent_id: UUID;
}
export type AcceptSessionInput = SessionBindingInput;
export type RejectSessionInput = ReceiverInput;
export type CloseSessionInput = ReceiverInput;
export type StoppedInput = SessionBindingInput;
export interface StoppedResponse extends ProtocolEnvelope { acknowledged: true }
export interface SendMessageInput extends ReceiverInput {
  client_message_id: UUID;
  content: string;
}
export interface SessionMessage {
  id: UUID;
  sequence: number;
  sender_type: "agent" | "human";
  sender_agent_id: UUID | null;
  client_message_id: UUID | null;
  content: string;
  created_at: Timestamp;
}
/** After retention purge, an idempotent send returns a receipt without content. */
export type MessageReceipt = SessionMessage | (Omit<SessionMessage, "content"> & { payload_expired: true });
export interface MessageResponse extends ProtocolEnvelope { message: MessageReceipt }
export interface MessagePage extends SessionResponse {
  messages: SessionMessage[];
  cursor: number;
}
export type ProtocolErrorCode = "INVALID_REQUEST" | "UNAUTHORIZED" | "ACCESS_DENIED" |
  "NOT_FOUND" | "RECEIVER_CONFLICT" | "STALE_RECEIVER" | "CONNECTION_ENDED" |
  "AGENT_OFFLINE" | "AGENT_PAUSED" | "AGENT_BUSY" | "IDEMPOTENCY_CONFLICT" |
  "BINDING_CONFLICT" | "SESSION_NOT_ACTIVE" | "SESSION_TERMINAL" | "HISTORY_EXPIRED" |
  "REQUEST_TOO_LARGE" | "RATE_LIMITED" | "INTERNAL_ERROR" | "SERVICE_UNAVAILABLE";
export interface ProtocolErrorResponse extends ProtocolEnvelope {
  error: {
    code: ProtocolErrorCode | (string & {});
    message: string;
    retry_after_seconds?: number;
  };
  /** HTTP trace ID, not a session ID. */
  request_id: UUID;
}

/** Directional owner-managed grants. An absent policy denies both directions. */
export interface PeerPolicyInput { allow_inbound: boolean; allow_outbound: boolean }
export interface PeerPolicy extends PeerPolicyInput {
  agent_id: UUID; peer_agent_id: UUID; created_at: Timestamp; updated_at: Timestamp;
}
export interface PeerPolicyResponse extends ProtocolEnvelope { policy: PeerPolicy }
export interface PeerPolicyListResponse extends ProtocolEnvelope { policies: PeerPolicy[]; next_cursor: UUID | null }
export interface DeletePeerPolicyResponse extends ProtocolEnvelope { deleted: true }

/** Permitted outbound contacts; availability is a snapshot, admission rechecks policy. */
export interface AgentPeer extends AgentProfile { availability: Availability }
export interface AgentPeersResponse extends ProtocolEnvelope { agent_id: UUID; peers: AgentPeer[]; next_cursor: UUID | null }
