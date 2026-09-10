import canonicalize from 'canonicalize';
import { createHash, createPublicKey, randomBytes, randomUUID, sign, verify } from 'node:crypto';

export const uuid = () => randomUUID();
export const secret = () => randomBytes(32).toString('base64url');
export class ProtocolError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
export function requireThat(condition, code, message, status = 400) {
  if (!condition) throw new ProtocolError(code, message, status);
}
export function jsonBytes(value) {
  // JCS requires I-JSON: reject lone surrogates and non-finite numbers.
  const check = (v, depth = 0) => {
    requireThat(depth <= 32, 'INVALID_JSON', 'JSON nesting exceeds 32 levels.');
    if (typeof v === 'string') requireThat(v.isWellFormed(), 'INVALID_JSON', 'Lone Unicode surrogates are forbidden.');
    else if (typeof v === 'number') requireThat(Number.isFinite(v), 'INVALID_JSON', 'Numbers must be finite.');
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { check(k, depth + 1); check(x, depth + 1); }
  };
  check(value);
  return Buffer.from(canonicalize(value));
}
export const hash = value => createHash('sha256').update(value).digest('base64url');
export function publicKey(encoded) {
  requireThat(typeof encoded === 'string' && /^[A-Za-z0-9_-]{59}$/.test(encoded), 'INVALID_PUBLIC_KEY', 'Use base64url DER SPKI Ed25519 public keys.');
  try {
    const key = createPublicKey({ key: Buffer.from(encoded, 'base64url'), format: 'der', type: 'spki' });
    requireThat(key.asymmetricKeyType === 'ed25519', 'INVALID_PUBLIC_KEY', 'Ed25519 is required.');
    requireThat(key.export({ type: 'spki', format: 'der' }).toString('base64url') === encoded, 'INVALID_PUBLIC_KEY', 'Use canonical base64url key encoding.');
    return key;
  } catch { throw new ProtocolError('INVALID_PUBLIC_KEY', 'Invalid Ed25519 public key.'); }
}
export function proofBytes(purpose, body) {
  const { signature, invite_token, ...fields } = body;
  return jsonBytes({ domain: `agent-rendezvous/v1/${purpose}`, ...fields,
    ...(invite_token === undefined ? {} : { invite_hash: hash(invite_token) }) });
}
export function messageBytes(m) {
  return jsonBytes({ domain: 'agent-rendezvous/v1/message', id: m.id, session_id: m.session_id,
    sender_id: m.sender_id, sequence: m.sequence, created_at: m.created_at, type: m.type,
    content_type: m.content_type, payload_hash: hash(jsonBytes(m.payload)) });
}
export const signBytes = (bytes, key) => sign(null, bytes, key).toString('base64url');
export function verifyBytes(bytes, signature, key) {
  requireThat(typeof signature === 'string' && /^[A-Za-z0-9_-]{86}$/.test(signature), 'INVALID_SIGNATURE', 'Invalid signature.', 401);
  requireThat(verify(null, bytes, key, Buffer.from(signature, 'base64url')), 'INVALID_SIGNATURE', 'Invalid signature.', 401);
}
export function integer(value, min, max, name) {
  requireThat(Number.isSafeInteger(value) && value >= min && value <= max, 'INVALID_REQUEST', `${name} must be an integer from ${min} to ${max}.`);
  return value;
}
export function exactFields(body, fields) {
  requireThat(body && typeof body === 'object' && !Array.isArray(body), 'INVALID_REQUEST', 'Expected a JSON object.');
  requireThat(Object.keys(body).every(k => fields.includes(k)), 'INVALID_REQUEST', 'Unknown fields.');
}
