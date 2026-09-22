import type { ReceiverReference, SessionSnapshot } from '../agents/protocol.js';
export interface PendingMessage { id: string; content: string; firstAttemptAt: number }
export interface SessionRecord {
  snapshot: SessionSnapshot;
  bindingId: string;
  receiver: ReceiverReference;
  cursor: number;
  accepted: boolean;
  stopped: boolean;
  /** Saved before entering model/tool code; never cleared by a crash or failed callback. */
  turn?: { through: number };
  pendingMessage?: PendingMessage;
}
export interface ClientState {
  version: 1;
  origin: string;
  agentId: string;
  connection?: { id: string; credentialId: string; takeover: boolean; firstAttemptAt: number; receiver?: ReceiverReference; expiresAt?: string; heartbeatSeconds?: number };
  pendingOpen?: { id: string; peer: string; bindingId: string; receiver: ReceiverReference; firstAttemptAt: number };
  sessions: Record<string, SessionRecord>;
}
/** One exclusive writer per journal. save must atomically persist before resolving.
 * Keep journals private: pending outbound content can be sensitive. Never store API keys. */
export interface ClientJournal { load(): Promise<ClientState | undefined>; save(state: ClientState): Promise<void> }
export class MemoryJournal implements ClientJournal {
  private state?: ClientState;
  async load() { return this.state ? structuredClone(this.state) : undefined; }
  async save(state: ClientState) { this.state = structuredClone(state); }
}
