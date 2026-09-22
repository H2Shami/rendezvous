import { AGENT_FRIENDS_PROTOCOL, type AcquireReceiverResponse, type AgentProfileResponse, type HeartbeatResponse, type InboxResponse, type SessionSnapshot, type SessionResponse, type MessageResponse, type MessagePage, type ProtocolErrorResponse } from '../agents/protocol.js';
import { AgentClientError, check } from './errors.js';
type ObjectValue = Record<string, unknown>;
export function object(value: unknown): asserts value is ObjectValue { check(!!value && typeof value === 'object' && !Array.isArray(value)); }
export function uuid(value: unknown): asserts value is string { check(typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)); }
function text(value: unknown) { check(typeof value === 'string'); }
function number(value: unknown, min = 0) { check(Number.isSafeInteger(value) && (value as number) >= min); }
function date(value: unknown) { check(typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value))); }
function nullable(value: unknown, validate: (v: unknown) => void) { if (value !== null) validate(value); }
export function envelope(value: unknown): asserts value is ObjectValue {
  object(value);
  if (value.protocol !== AGENT_FRIENDS_PROTOCOL) throw new AgentClientError('UNSUPPORTED_PROTOCOL', 'Server does not speak agent-friends-http-v1.');
}
export function reference(value: unknown) {
  object(value); uuid(value.lease_id);
  check(typeof value.generation === 'string' && /^[1-9][0-9]{0,18}$/.test(value.generation) && BigInt(value.generation) <= 9223372036854775807n);
}
function limits(value: unknown, agent = false) {
  object(value);
  for (const key of ['max_message_bytes', 'idle_timeout_seconds', 'max_session_seconds', 'message_budget', ...(agent ? ['inbound_sessions_per_hour','max_concurrent_sessions','messages_per_minute'] : [])]) number(value[key], 1);
}
export function snapshot(value: unknown): asserts value is SessionSnapshot {
  object(value); uuid(value.id); uuid(value.initiator_agent_id); uuid(value.recipient_agent_id);
  check(value.initiator_agent_id !== value.recipient_agent_id);
  check(['pending','active','closed','expired'].includes(value.state as string)); number(value.version, 1);
  for (const key of ['created_at','offer_expires_at','expires_at']) date(value[key]);
  nullable(value.idle_expires_at, date); nullable(value.closed_at, date);
  nullable(value.close_reason, v => check(['COMPLETED','REJECTED','RECEIVER_LOST','ACCESS_REVOKED','OFFER_TIMEOUT','IDLE_TIMEOUT','LIFETIME_EXCEEDED','MESSAGE_BUDGET'].includes(v as string)));
  limits(value.limits);
}
export function profile(value: unknown): AgentProfileResponse {
  envelope(value); object(value.agent); uuid(value.agent.id); text(value.agent.display_name);
  check(['offline','paused','busy','available'].includes(value.availability as string)); return value as unknown as AgentProfileResponse;
}
export function acquired(value: unknown): AcquireReceiverResponse {
  envelope(value); uuid(value.agent_id); reference(value.receiver); date(value.expires_at); number(value.heartbeat_seconds, 1); limits(value.limits, true);
  return value as unknown as AcquireReceiverResponse;
}
export function heartbeat(value: unknown): HeartbeatResponse {
  envelope(value); reference(value.receiver); date(value.expires_at); check(Array.isArray(value.sessions_to_stop)); value.sessions_to_stop.forEach(uuid);
  return value as unknown as HeartbeatResponse;
}
export function inbox(value: unknown): InboxResponse {
  envelope(value); check(Array.isArray(value.offers)); value.offers.forEach(snapshot); return value as unknown as InboxResponse;
}
export function session(value: unknown): SessionResponse { envelope(value); snapshot(value.session); return value as unknown as SessionResponse; }
function message(value: unknown, receipt = false) {
  object(value); uuid(value.id); number(value.sequence, 1); date(value.created_at);
  check(value.sender_type === 'agent' || value.sender_type === 'human');
  if (value.sender_type === 'agent') { uuid(value.sender_agent_id); uuid(value.client_message_id); }
  else check(value.sender_agent_id === null && value.client_message_id === null);
  if (receipt && value.payload_expired === true) check(value.content === undefined);
  else text(value.content);
}
export function sent(value: unknown): MessageResponse { envelope(value); message(value.message, true); return value as unknown as MessageResponse; }
export function messages(value: unknown): MessagePage {
  envelope(value); snapshot(value.session); number(value.cursor); check(Array.isArray(value.messages) && value.messages.length <= 100);
  let previous = 0;
  for (const item of value.messages) { message(item); const m = item as ObjectValue;
    if (m.sender_type === 'agent') check([value.session.initiator_agent_id, value.session.recipient_agent_id].includes(m.sender_agent_id as string), 'Message sender is outside the session.');
    check((m.sequence as number) > previous); previous = m.sequence as number; }
  check(!previous || value.cursor === previous); return value as unknown as MessagePage;
}
export function success(field: 'released' | 'acknowledged') { return (value: unknown) => { envelope(value); check(value[field] === true); return value; }; }
export function error(value: unknown): ProtocolErrorResponse {
  envelope(value); object(value.error); check(typeof value.error.code === 'string' && /^[A-Z][A-Z0-9_]{0,80}$/.test(value.error.code)); text(value.error.message); uuid(value.request_id);
  if (value.error.retry_after_seconds !== undefined) number(value.error.retry_after_seconds);
  return value as unknown as ProtocolErrorResponse;
}
