import type { sessions, participants, invites } from "./schema.js";
export type Session = typeof sessions.$inferSelect;
export type Participant = typeof participants.$inferSelect;
export type Invite = typeof invites.$inferSelect;
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
