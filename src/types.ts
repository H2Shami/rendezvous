export interface Session {
  id: string;
  status: "WAITING" | "ACTIVE" | "CLOSED";
  owner_hash: string;
  created_at: Date;
  expires_at: Date;
  max_participants: number;
  next_sequence: number;
}
export interface Participant {
  id: string;
  session_id: string;
  credential_hash: string | null;
  display_name: string | null;
  metadata_json: Record<string, unknown>;
  joined_at: Date;
  left_at: Date | null;
  last_seen_at: Date | null;
  revoked_at: Date | null;
}
export interface Invite {
  id: string;
  secret_hash: string;
  max_uses: number;
  use_count: number;
  expires_at: Date;
  revoked_at: Date | null;
}
export interface Message {
  id: string;
  sequence: number;
  sender_id: string;
  content: string;
  created_at: Date;
}
export interface MessagePage {
  messages: Message[];
  participants: Pick<
    Participant,
    "id" | "display_name" | "left_at" | "revoked_at"
  >[];
  cursor: number;
  session_status: "waiting" | "active" | "closed" | "expired";
}
