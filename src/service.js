import { EventEmitter } from 'node:events';
import { one } from './db.js';
import { ProtocolError, exactFields, hash, integer, jsonBytes, messageBytes, proofBytes, publicKey, requireThat, secret, uuid, verifyBytes } from './protocol.js';
import { RateLimiter } from './security.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeParticipant = p => ({ id: p.id, public_key: p.public_key, metadata: p.metadata_json,
  joined_at: p.joined_at, last_seen_at: p.last_seen_at, revoked_at: p.revoked_at, last_sequence: p.last_sequence });
export class Service extends EventEmitter {
  constructor(db, auth, config = {}) {
    super(); this.db = db; this.auth = auth;
    this.config = { ttlSeconds: 86400, maxTtlSeconds: 604800, messageBudget: 10000, messagesPerMinute: 60,
      sessionsPerHour: 10, joinsPerHour: 30, retentionSeconds: 86400, ...config };
    this.clock = config.clock || Date.now; this.rate = new RateLimiter(this.clock);
    this.metrics = {}; this.logger = config.logger || (event => console.log(JSON.stringify(event)));
  }
  now() { return new Date(this.clock()); }
  async event(db, event, sessionId, participantId) {
    await db.query('INSERT INTO security_events(event,session_id,participant_id) VALUES($1,$2,$3)', [event, sessionId, participantId || null]);
  }
  log(event, fields = {}) { this.metrics[event] = (this.metrics[event] || 0) + 1; this.logger({ event, ...fields }); }
  limit(key, n, ms) { try { this.rate.take(key, n, ms); } catch (e) { this.log('rate_limit.triggered'); throw e; } }
  async session(db, id, lock = false) {
    requireThat(uuidPattern.test(id), 'NOT_FOUND', 'Session not found.', 404);
    const s = await one(db, `SELECT * FROM sessions WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id]);
    requireThat(s, 'NOT_FOUND', 'Session not found.', 404);
    requireThat(new Date(s.expires_at) > this.now(), 'SESSION_EXPIRED', 'Session expired.', 410);
    return s;
  }
  writable(s) { requireThat(s.status !== 'CLOSED', 'SESSION_CLOSED', 'Session is closed; history remains readable until expiry.', 409); }
  async owner(db, id, token, lock = false) {
    const s = await this.session(db, id, lock);
    requireThat(this.auth.matches(token, s.owner_hash), 'UNAUTHORIZED', 'Owner credential required.', 401); return s;
  }
  async participant(db, id, token, lock = false) {
    const claims = this.auth.decode(token);
    requireThat(claims.session === id, 'WRONG_SESSION', 'Credential belongs to another session.', 403);
    const s = await this.session(db, id, lock);
    const p = await one(db, 'SELECT * FROM participants WHERE id=$1 AND session_id=$2', [claims.sub, id]);
    requireThat(p && !p.revoked_at, 'PARTICIPANT_REVOKED', 'Participant is absent or revoked.', 403);
    return { s, p, claims };
  }
  async reader(db, id, token) {
    const s = await this.session(db, id);
    if (this.auth.matches(token, s.owner_hash)) return { s };
    return this.participant(db, id, token);
  }
  async create(body, ip) {
    exactFields(body, ['ttl_seconds', 'max_participants', 'invite_max_uses']);
    this.limit(`create:${ip}`, this.config.sessionsPerHour, 3600000);
    const max = integer(body.max_participants ?? 2, 1, 10, 'max_participants');
    const uses = integer(body.invite_max_uses ?? max, 1, max, 'invite_max_uses');
    const ttl = integer(body.ttl_seconds ?? this.config.ttlSeconds, 1, this.config.maxTtlSeconds, 'ttl_seconds');
    const id = uuid(), owner = secret(), invite = secret(), inviteId = uuid();
    const expires = new Date(this.clock() + ttl * 1000);
    await this.db.transaction(async tx => {
      await tx.query('INSERT INTO sessions(id,owner_hash,expires_at,max_participants,message_budget) VALUES($1,$2,$3,$4,$5)', [id, this.auth.digest(owner), expires, max, this.config.messageBudget]);
      await tx.query('INSERT INTO invites(id,session_id,secret_hash,max_uses,expires_at) VALUES($1,$2,$3,$4,$5)', [inviteId, id, this.auth.digest(invite), uses, expires]);
      await this.event(tx, 'session.created', id);
    });
    this.log('session.created', { session_id: id });
    return { session_id: id, owner_token: owner, invite_token: invite, invite_id: inviteId, expires_at: expires };
  }
  async challenge(id, ip) {
    this.limit(`challenge:${ip}`, 120, 60000);
    await this.session(this.db, id);
    const nonce = secret(), expires = new Date(this.clock() + 120000);
    await this.db.query('INSERT INTO challenges(nonce,session_id,expires_at) VALUES($1,$2,$3)', [nonce, id, expires]);
    return { server_nonce: nonce, expires_at: expires };
  }
  async consumeChallenge(tx, id, nonce) {
    requireThat(typeof nonce === 'string' && nonce.length === 43, 'INVALID_CHALLENGE', 'A fresh server challenge is required.');
    const c = await one(tx, 'DELETE FROM challenges WHERE nonce=$1 AND session_id=$2 RETURNING *', [nonce, id]);
    requireThat(c && new Date(c.expires_at) > this.now(), 'INVALID_CHALLENGE', 'Challenge expired or already used.', 401);
  }
  validateProof(body, id, purpose, key) {
    requireThat(body.session_id === id, 'WRONG_SESSION', 'Proof must identify this session.');
    requireThat(typeof body.client_nonce === 'string' && /^[A-Za-z0-9_-]{43}$/.test(body.client_nonce), 'INVALID_REQUEST', 'client_nonce must be 32 random bytes encoded as base64url.');
    verifyBytes(proofBytes(purpose, body), body.signature, key);
  }
  async join(id, body, ip) {
    exactFields(body, ['session_id', 'invite_token', 'public_key', 'client_nonce', 'server_nonce', 'metadata', 'signature']);
    this.limit(`join:${ip}`, this.config.joinsPerHour, 3600000);
    requireThat(typeof body.invite_token === 'string' && body.invite_token.length === 43, 'INVALID_INVITE', 'Invalid invite.', 403);
    requireThat(body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) && jsonBytes(body.metadata).length <= 2048, 'INVALID_METADATA', 'metadata must be an object of at most 2 KB.');
    const key = publicKey(body.public_key); this.validateProof(body, id, 'join', key);
    const result = await this.db.transaction(async tx => {
      const s = await this.session(tx, id, true); this.writable(s);
      await this.consumeChallenge(tx, id, body.server_nonce);
      const invites = (await tx.query('SELECT * FROM invites WHERE session_id=$1', [id])).rows;
      const invite = invites.find(i => this.auth.matches(body.invite_token, i.secret_hash));
      requireThat(invite && !invite.revoked_at && new Date(invite.expires_at) > this.now(), 'INVALID_INVITE', 'Invite is invalid, expired, or revoked.', 403);
      let p = await one(tx, 'SELECT * FROM participants WHERE session_id=$1 AND public_key=$2', [id, body.public_key]);
      if (p) { requireThat(!p.revoked_at, 'PARTICIPANT_REVOKED', 'Participant revoked.', 403); return { s, p }; }
      requireThat(invite.use_count < invite.max_uses, 'INVITE_EXHAUSTED', 'Invite has no uses left.', 403);
      // Revocation does not recover a slot: limits bound total identities admitted.
      const count = await one(tx, 'SELECT count(*)::integer AS count FROM participants WHERE session_id=$1', [id]);
      requireThat(count.count < s.max_participants, 'SESSION_FULL', 'Session membership limit reached.', 409);
      p = await one(tx, 'INSERT INTO participants(id,session_id,public_key,metadata_json) VALUES($1,$2,$3,$4) RETURNING *', [uuid(), id, body.public_key, JSON.stringify(body.metadata)]);
      await tx.query('UPDATE invites SET use_count=use_count+1 WHERE id=$1', [invite.id]);
      await tx.query("UPDATE sessions SET status='ACTIVE' WHERE id=$1", [id]);
      await this.event(tx, 'participant.joined', id, p.id); await this.event(tx, 'invite.used', id, p.id);
      return { s, p };
    });
    this.log('participant.joined', { session_id: id, participant_id: result.p.id });
    return this.credentials(result);
  }
  credentials({ s, p }) {
    return { session_id: s.id, participant_id: p.id, next_sequence: p.last_sequence + 1, ...this.auth.issue(p, s) };
  }
  async renew(id, body, ip) {
    exactFields(body, ['session_id', 'participant_id', 'client_nonce', 'server_nonce', 'signature']);
    this.limit(`renew:${ip}`, 120, 60000);
    requireThat(uuidPattern.test(body.participant_id), 'UNAUTHORIZED', 'Invalid participant.', 401);
    return this.db.transaction(async tx => {
      const s = await this.session(tx, id, true);
      const p = await one(tx, 'SELECT * FROM participants WHERE id=$1 AND session_id=$2', [body.participant_id, id]);
      requireThat(p && !p.revoked_at, 'PARTICIPANT_REVOKED', 'Participant is absent or revoked.', 403);
      this.validateProof(body, id, 'renew', publicKey(p.public_key));
      await this.consumeChallenge(tx, id, body.server_nonce);
      return this.credentials({ s, p });
    });
  }
  async send(id, token, m) {
    exactFields(m, ['id', 'session_id', 'sender_id', 'sequence', 'created_at', 'type', 'content_type', 'payload', 'signature']);
    requireThat(jsonBytes(m).length <= 65536, 'MESSAGE_TOO_LARGE', 'Signed envelope exceeds 64 KB.', 413);
    requireThat(uuidPattern.test(m.id), 'INVALID_REQUEST', 'Message id must be a UUIDv4.');
    integer(m.sequence, 1, 2147483646, 'sequence');
    requireThat(typeof m.created_at === 'string' && Number.isFinite(Date.parse(m.created_at)), 'INVALID_REQUEST', 'created_at must be an ISO timestamp.');
    requireThat(typeof m.type === 'string' && /^[a-z][a-z0-9_.-]{0,63}$/.test(m.type) && m.content_type === 'application/json' && Object.hasOwn(m, 'payload'), 'INVALID_REQUEST', 'Provide a type, application/json content_type, and JSON payload.');
    const accepted = await this.db.transaction(async tx => {
      const { s, p } = await this.participant(tx, id, token, true);
      requireThat(m.session_id === id && m.sender_id === p.id, 'WRONG_SENDER', 'Envelope session/sender does not match authentication.', 403);
      this.limit(`message:${p.id}`, this.config.messagesPerMinute, 60000);
      verifyBytes(messageBytes(m), m.signature, publicKey(p.public_key));
      const digest = hash(jsonBytes(m));
      const previous = await one(tx, 'SELECT * FROM messages WHERE id=$1', [m.id]);
      if (previous) {
        requireThat(previous.session_id === id && previous.envelope_hash === digest, 'MESSAGE_ID_CONFLICT', 'Message ID already exists with different content.', 409);
        return { message_id: m.id, offset: previous.message_offset, duplicate: true };
      }
      this.writable(s);
      requireThat(Math.abs(this.clock() - Date.parse(m.created_at)) <= 300000, 'STALE_TIMESTAMP', 'New messages must be within five minutes of server time.');
      requireThat(m.sequence === p.last_sequence + 1, 'SEQUENCE_CONFLICT', `Expected sequence ${p.last_sequence + 1}.`, 409);
      requireThat(s.next_message_offset <= s.message_budget, 'MESSAGE_BUDGET_EXCEEDED', 'Session message budget reached.', 429);
      await tx.query('INSERT INTO messages(id,session_id,sender_participant_id,message_offset,sequence,envelope,envelope_hash) VALUES($1,$2,$3,$4,$5,$6,$7)', [m.id, id, p.id, s.next_message_offset, m.sequence, JSON.stringify(m), digest]);
      await tx.query('UPDATE sessions SET next_message_offset=next_message_offset+1 WHERE id=$1', [id]);
      await tx.query('UPDATE participants SET last_sequence=$2,last_seen_at=$3 WHERE id=$1', [p.id, m.sequence, this.now()]);
      await this.event(tx, 'message.accepted', id, p.id);
      return { message_id: m.id, offset: s.next_message_offset, duplicate: false };
    }).catch(err => {
      // Different sessions have different row locks but share the global ID index.
      if (err.code === '23505') throw new ProtocolError('MESSAGE_ID_CONFLICT', 'Message ID already exists.', 409);
      throw err;
    });
    if (!accepted.duplicate) { this.log('message.accepted', { session_id: id }); this.emit('message', id); }
    return accepted;
  }
  async history(id, token, after = 0, limit = 100) {
    integer(after, 0, 2147483647, 'after'); integer(limit, 1, 100, 'limit');
    await this.reader(this.db, id, token);
    const rows = (await this.db.query('SELECT message_offset,envelope,received_at FROM messages WHERE session_id=$1 AND message_offset>$2 ORDER BY message_offset LIMIT $3', [id, after, limit + 1])).rows;
    const messages = rows.slice(0, limit).map(r => ({ offset: r.message_offset, message: r.envelope, received_at: r.received_at }));
    return { messages, next_cursor: messages.at(-1)?.offset ?? after, has_more: rows.length > limit };
  }
  async inspect(id, token) {
    const { s, p } = await this.reader(this.db, id, token);
    const participants = (await this.db.query('SELECT * FROM participants WHERE session_id=$1 ORDER BY joined_at,id', [id])).rows.map(safeParticipant);
    const result = { session_id: id, status: s.status, created_at: s.created_at, expires_at: s.expires_at, max_participants: s.max_participants, message_count: s.next_message_offset - 1, message_budget: s.message_budget, participants };
    if (!p) result.invites = (await this.db.query('SELECT id,max_uses,use_count,expires_at,revoked_at FROM invites WHERE session_id=$1 ORDER BY created_at', [id])).rows;
    return result;
  }
  async close(id, token) {
    await this.db.transaction(async tx => {
      await this.owner(tx, id, token, true);
      await tx.query("UPDATE sessions SET status='CLOSED' WHERE id=$1", [id]);
      await this.event(tx, 'session.closed', id);
    });
    this.log('session.closed', { session_id: id }); this.emit('closed', id);
    return { status: 'CLOSED' };
  }
  async invite(id, token, body) {
    exactFields(body, ['max_uses', 'ttl_seconds']);
    return this.db.transaction(async tx => {
      const s = await this.owner(tx, id, token, true); this.writable(s);
      const count = await one(tx, 'SELECT count(*)::integer AS count FROM invites WHERE session_id=$1', [id]);
      requireThat(count.count < 100, 'INVITE_LIMIT', 'Maximum 100 invites per session.', 429);
      const uses = integer(body.max_uses ?? 1, 1, s.max_participants, 'max_uses');
      const ttl = integer(body.ttl_seconds ?? this.config.ttlSeconds, 1, this.config.maxTtlSeconds, 'ttl_seconds');
      const expires = new Date(Math.min(this.clock() + ttl * 1000, new Date(s.expires_at).getTime()));
      const inviteId = uuid(), raw = secret();
      await tx.query('INSERT INTO invites(id,session_id,secret_hash,max_uses,expires_at) VALUES($1,$2,$3,$4,$5)', [inviteId, id, this.auth.digest(raw), uses, expires]);
      await this.event(tx, 'invite.created', id);
      return { invite_id: inviteId, invite_token: raw, expires_at: expires };
    });
  }
  async revoke(id, token, target, kind) {
    requireThat(uuidPattern.test(target), 'NOT_FOUND', 'Resource not found.', 404);
    const table = kind === 'invite' ? 'invites' : 'participants';
    await this.db.transaction(async tx => {
      await this.owner(tx, id, token, true);
      const row = await one(tx, `UPDATE ${table} SET revoked_at=$3 WHERE id=$1 AND session_id=$2 RETURNING id`, [target, id, this.now()]);
      requireThat(row, 'NOT_FOUND', 'Resource not found.', 404);
      await this.event(tx, `${kind}.revoked`, id, kind === 'participant' ? target : null);
    });
    this.log(`${kind}.revoked`, { session_id: id });
    if (kind === 'participant') this.emit('revoked', id, target);
    return { revoked: true };
  }
  async cleanup() {
    await this.db.query('DELETE FROM challenges WHERE expires_at<$1', [this.now()]);
    await this.db.query('DELETE FROM sessions WHERE expires_at<$1', [new Date(this.clock() - this.config.retentionSeconds * 1000)]);
    await this.db.query('DELETE FROM security_events WHERE created_at<$1', [new Date(this.clock() - (this.config.retentionSeconds + this.config.maxTtlSeconds) * 1000)]);
    this.rate.sweep();
  }
}
