import { SessionEngine } from "./session-engine.js";
import { one, type Database, type Queryable } from "./db.js";
import {
  exactFields,
  integer,
  metadata,
  requireThat,
  secret,
  uuid,
} from "./validation.js";
import { RateLimiter, type Security } from "./security.js";
import { requestContext } from "./logging.js";
import type {
  Session,
  Participant,
  Invite,
  Message,
  MessagePage,
} from "./types.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeParticipant = (p: Participant) => ({
  id: p.id,
  display_name: p.display_name,
  metadata: p.metadata_json,
  joined_at: p.joined_at,
  left_at: p.left_at,
  last_seen_at: p.last_seen_at,
  revoked_at: p.revoked_at,
});
export interface ServiceConfig {
  ttlSeconds?: number;
  maxTtlSeconds?: number;
  sessionsPerHour?: number;
  joinsPerHour?: number;
  messagesPerMinute?: number;
  messageBudget?: number;
  retentionSeconds?: number;
  maxWaiters?: number;
  clock?: () => number;
  logger?: (event: Record<string, unknown>) => void;
}
export class Service {
  config;
  clock;
  rate;
  metrics: Record<string, number> = {};
  logger;
  readonly engine: SessionEngine;
  get waiters() { return this.engine.waiters; }

  constructor(
    public db: Database,
    public auth: Security,
    config: ServiceConfig = {},
  ) {
    this.config = {
      ttlSeconds: 86400,
      maxTtlSeconds: 604800,
      sessionsPerHour: 10,
      joinsPerHour: 30,
      messagesPerMinute: 60,
      messageBudget: 10000,
      retentionSeconds: 86400,
      maxWaiters: 1000,
      ...config,
    };
    this.engine = new SessionEngine(this.config.maxWaiters);
    this.clock = config.clock || Date.now;
    this.rate = new RateLimiter(this.clock);
    this.logger =
      config.logger || ((event) => console.log(JSON.stringify(event)));
  }

  now() {
    return new Date(this.clock());
  }

  status(s: Session): MessagePage["session_status"] {
    return new Date(s.expires_at).getTime() <= this.clock()
      ? "expired"
      : (s.status.toLowerCase() as MessagePage["session_status"]);
  }

  async event(
    db: Queryable,
    event: string,
    sessionId: string,
    participantId?: string,
  ) {
    await db.query(
      "INSERT INTO security_events(event,session_id,participant_id) VALUES($1,$2,$3)",
      [event, sessionId, participantId || null],
    );
  }
  log(event: string, fields: Record<string, unknown> = {}) {
    this.metrics[event] = (this.metrics[event] || 0) + 1;
    this.logger({
      timestamp: new Date().toISOString(),
      component: "relay",
      event,
      ...requestContext.getStore(),
      ...fields,
    });
  }
  limit(key: string, n: number, ms: number) {
    try {
      this.rate.take(key, n, ms);
    } catch (error) {
      this.log("rate_limit.triggered");
      throw error;
    }
  }

  async session(db: Queryable, id: string, lock = false, allowExpired = false) {
    requireThat(
      uuidPattern.test(id),
      "NOT_FOUND",
      "Rendezvous not found.",
      404,
    );
    const s = await one<Session>(
      db,
      `SELECT * FROM sessions WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM agent_sessions a WHERE a.id=sessions.id)${lock ? " FOR UPDATE" : ""}`,
      [id],
    );
    requireThat(s, "NOT_FOUND", "Rendezvous not found.", 404);
    requireThat(
      allowExpired || this.status(s) !== "expired",
      "SESSION_EXPIRED",
      "Rendezvous expired.",
      410,
    );
    return s;
  }
  writable(s: Session) {
    requireThat(
      s.status !== "CLOSED",
      "SESSION_CLOSED",
      "Rendezvous is closed.",
      409,
    );
  }
  async owner(db: Queryable, id: string, token: string, lock = false) {
    const s = await this.session(db, id, lock);
    requireThat(
      this.auth.matches(token, s.owner_hash),
      "UNAUTHORIZED",
      "Owner credential required.",
      401,
    );
    return s;
  }
  async participant(
    db: Queryable,
    id: string,
    token: string,
    lock = false,
    allowExpired = false,
  ) {
    const s = await this.session(db, id, lock, allowExpired);
    const p = await one<Participant>(
      db,
      "SELECT * FROM participants WHERE session_id=$1 AND credential_hash=$2",
      [id, this.auth.digest(token)],
    );
    requireThat(
      p && !p.revoked_at && !p.left_at,
      "UNAUTHORIZED",
      "Participant token is invalid, revoked, or has left.",
      403,
    );
    return { s, p };
  }
  async reader(
    db: Queryable,
    id: string,
    token: string,
    lock = false,
    allowExpired = false,
  ): Promise<{ s: Session; p?: Participant }> {
    const s = await this.session(db, id, lock, allowExpired);
    if (this.auth.matches(token, s.owner_hash)) return { s };
    return this.participant(db, id, token, false, allowExpired);
  }
  async create(body: unknown, ip: string) {
    exactFields(body, ["ttl_seconds", "max_participants", "invite_max_uses"]);
    this.limit(`create:${ip}`, this.config.sessionsPerHour, 3600000);
    const max = integer(body.max_participants ?? 2, 1, 10, "max_participants");
    const uses = integer(body.invite_max_uses ?? max, 1, max, "invite_max_uses");
    const ttl = integer(
      body.ttl_seconds ?? this.config.ttlSeconds,
      1,
      this.config.maxTtlSeconds,
      "ttl_seconds",
    );
    const id = uuid(),
      owner = secret(),
      invite = secret(),
      inviteId = uuid();
    const expires = new Date(this.clock() + ttl * 1000);
    await this.db.transaction(async (tx) => {
      await tx.query(
        "INSERT INTO sessions(id,owner_hash,expires_at,max_participants) VALUES($1,$2,$3,$4)",
        [id, this.auth.digest(owner), expires, max],
      );
      await tx.query(
        "INSERT INTO invites(id,session_id,secret_hash,max_uses,expires_at) VALUES($1,$2,$3,$4,$5)",
        [inviteId, id, this.auth.digest(invite), uses, expires],
      );
      await this.event(tx, "session.created", id);
    });
    this.log("session.created", { session_id: id });
    return {
      session_id: id,
      owner_token: owner,
      invite_token: invite,
      invite_id: inviteId,
      expires_at: expires,
    };
  }
  private async membershipStatus(tx: Queryable, id: string) {
    await tx.query(
      "UPDATE sessions SET status=CASE WHEN (SELECT count(*) FROM participants WHERE session_id=$1 AND revoked_at IS NULL AND left_at IS NULL)>=LEAST(max_participants,2) THEN 'ACTIVE' ELSE 'WAITING' END WHERE id=$1 AND status<>'CLOSED'",
      [id],
    );
  }
  async join(id: string, body: unknown, ip: string) {
    exactFields(body, ["invite_token", "display_name", "metadata"]);
    this.limit(`join:${ip}`, this.config.joinsPerHour, 3600000);
    requireThat(
      typeof body.invite_token === "string" &&
        /^[A-Za-z0-9_-]{43}$/.test(body.invite_token),
      "INVALID_INVITE",
      "Invalid invite.",
      403,
    );
    requireThat(
      body.display_name === undefined ||
        (typeof body.display_name === "string" &&
          body.display_name.length <= 100),
      "INVALID_REQUEST",
      "display_name must be a string of at most 100 characters.",
    );
    const info = metadata(body.metadata),
      token = secret();
    const result = await this.db.transaction(async (tx) => {
      const s = await this.session(tx, id, true);
      this.writable(s);
      const invite = await one<Invite>(
        tx,
        "SELECT * FROM invites WHERE session_id=$1 AND secret_hash=$2",
        [id, this.auth.digest(body.invite_token as string)],
      );
      requireThat(
        invite &&
          !invite.revoked_at &&
          new Date(invite.expires_at) > this.now(),
        "INVALID_INVITE",
        "Invite is invalid, expired, or revoked.",
        403,
      );
      requireThat(
        invite.use_count < invite.max_uses,
        "INVITE_EXHAUSTED",
        "Invite has no uses left.",
        403,
      );
      const count = await one<{ count: number }>(
        tx,
        "SELECT count(*)::integer AS count FROM participants WHERE session_id=$1 AND left_at IS NULL AND revoked_at IS NULL",
        [id],
      );
      requireThat(
        count.count < s.max_participants,
        "SESSION_FULL",
        "Rendezvous membership limit reached.",
        409,
      );
      const p = await one<Participant>(
        tx,
        "INSERT INTO participants(id,session_id,display_name,metadata_json,credential_hash,last_seen_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
        [
          uuid(),
          id,
          body.display_name ?? null,
          JSON.stringify(info),
          this.auth.digest(token),
          this.now(),
        ],
      );
      await tx.query("UPDATE invites SET use_count=use_count+1 WHERE id=$1", [
        invite.id,
      ]);
      await this.membershipStatus(tx, id);
      await this.event(tx, "participant.joined", id, p.id);
      await this.event(tx, "invite.used", id, p.id);
      return {
        rendezvous_id: id,
        participant_id: p.id,
        cursor: 0,
        status: this.status(await this.session(tx, id)),
        expires_at: s.expires_at,
      };
    });
    this.log("participant.joined", {
      session_id: id,
      participant_id: result.participant_id,
    });
    this.notify(id);
    return { ...result, participant_token: token };
  }
  notify(id: string) {
    this.engine.notify(id);
  }
  async send(id: string, token: string, body: unknown) {
    exactFields(body, ["content"]);
    requireThat(
      typeof body.content === "string" &&
        body.content.trim().length > 0 &&
        Buffer.byteLength(body.content) <= 32768,
      "INVALID_CONTENT",
      "content must be nonempty text of at most 32 KB.",
    );
    const message = await this.db.transaction(async (tx) => {
      const { s, p } = await this.reader(tx, id, token, true);
      this.writable(s);
      this.limit(
        `message:${p?.id || `owner:${id}`}`,
        this.config.messagesPerMinute,
        60000,
      );
      requireThat(
        s.next_sequence <= this.config.messageBudget,
        "MESSAGE_BUDGET_EXCEEDED",
        "Rendezvous message limit reached.",
        429,
      );
      const stored = await this.engine.append(tx, id, { participantId: p?.id, content: body.content as string, now: this.now() });
      const m = { ...stored, sender_id: p?.id ?? 'owner', content: body.content as string };
      if (p)
        await tx.query("UPDATE participants SET last_seen_at=$2 WHERE id=$1", [
          p.id,
          this.now(),
        ]);
      return m;
    });
    this.log("message.sent", {
      session_id: id,
      participant_id: message.sender_id,
      sequence: message.sequence,
    });
    this.notify(id);
    return message;
  }

  async messages(
    id: string,
    token: string,
    after: number,
    wait: number,
    signal?: AbortSignal,
  ): Promise<MessagePage> {
    integer(after, 0, 2147483646, "after");
    integer(wait, 0, 60, "wait");
    // Authenticate before allocating a waiter, then recheck on every wake.
    const initial = await this.reader(this.db, id, token, false, true);
    const roster = async (db: Queryable) =>
      (
        await db.query<MessagePage["participants"][number]>(
          "SELECT id,display_name,left_at,revoked_at FROM participants WHERE session_id=$1 ORDER BY joined_at,id",
          [id],
        )
      ).rows;
    const initialRoster = JSON.stringify(await roster(this.db));
    const key = initial.p?.id || `owner:${id}`;
    const started = Date.now();
    this.log('poll.started', { session_id: id, participant_id: initial.p?.id, after, wait });
    try {
      if (initial.p && this.status(initial.s) !== 'expired') await this.db.query('UPDATE participants SET last_seen_at=$2 WHERE id=$1', [initial.p.id, this.now()]);
      const page = await this.engine.poll(id, `room:${key}`, wait, () => this.db.transaction(async tx => {
        const { s } = await this.reader(tx, id, token, true, true), status = this.status(s);
        if (status === 'expired') return { value: { messages: [], participants: [], cursor: after, session_status: status } as MessagePage, ready: true };
        requireThat(after < s.next_sequence, 'INVALID_CURSOR', 'Cursor is ahead of the message log. Use the last GET response cursor.');
        const rows = (await this.engine.read(tx, id, after)).map(m => ({ id: m.id, sequence: m.sequence, sender_id: m.sender_participant_id ?? 'owner', content: m.content, created_at: m.created_at }));
        const participants = await roster(tx);
        return { value: { messages: rows, participants, cursor: rows.at(-1)?.sequence ?? after, session_status: status } as MessagePage,
          ready: rows.length > 0 || JSON.stringify(participants) !== initialRoster || status === 'closed', expiresIn: new Date(s.expires_at).getTime() - this.clock() };
      }), signal, 'TOO_MANY_POLLS');
      this.log(page.messages.length ? 'poll.delivered' : 'poll.empty', { session_id: id, participant_id: initial.p?.id, after, cursor: page.cursor, count: page.messages.length, status: page.session_status, duration_ms: Date.now() - started });
      return page;
    } finally {
      if (signal?.aborted) this.log('poll.disconnected', { session_id: id, participant_id: initial.p?.id, after });
    }
  }

  async leave(id: string, token: string) {
    await this.db.transaction(async (tx) => {
      const { p } = await this.participant(tx, id, token, true);
      await tx.query("UPDATE participants SET left_at=$2 WHERE id=$1", [
        p.id,
        this.now(),
      ]);
      await this.membershipStatus(tx, id);
      await this.event(tx, "participant.left", id, p.id);
    });
    this.log("participant.left", { session_id: id });
    this.notify(id);
    return { left: true };
  }

  async inspect(id: string, token: string) {
    const { s, p } = await this.reader(this.db, id, token, false, true);
    const expired = this.status(s) === "expired";
    const participants = expired
      ? []
      : (
          await this.db.query<Participant>(
            "SELECT * FROM participants WHERE session_id=$1 ORDER BY joined_at,id",
            [id],
          )
        ).rows.map(safeParticipant);
    const invites =
      p || expired
        ? undefined
        : (
            await this.db.query<Omit<Invite, "secret_hash">>(
              "SELECT id,max_uses,use_count,expires_at,revoked_at FROM invites WHERE session_id=$1 ORDER BY created_at",
              [id],
            )
          ).rows;
    return {
      session_id: id,
      status: this.status(s).toUpperCase(),
      created_at: s.created_at,
      expires_at: s.expires_at,
      max_participants: s.max_participants,
      message_count: s.next_sequence - 1,
      participants,
      invites,
    };
  }

  async close(id: string, token: string) {
    await this.db.transaction(async (tx) => {
      await this.owner(tx, id, token, true);
      await this.engine.close(tx, id);
      await this.event(tx, "session.closed", id);
    });
    this.log("session.closed", { session_id: id });
    this.notify(id);
    return { status: "CLOSED" };
  }

  async invite(id: string, token: string, body: unknown) {
    exactFields(body, ["max_uses", "ttl_seconds"]);
    return this.db.transaction(async (tx) => {
      const s = await this.owner(tx, id, token, true);
      this.writable(s);
      const count = await one<{ count: number }>(
        tx,
        "SELECT count(*)::integer AS count FROM invites WHERE session_id=$1",
        [id],
      );
      requireThat(
        count.count < 100,
        "INVITE_LIMIT",
        "Maximum 100 invites per rendezvous.",
        429,
      );
      const uses = integer(body.max_uses ?? s.max_participants, 1, s.max_participants, "max_uses");
      const ttl = integer(
        body.ttl_seconds ?? this.config.ttlSeconds,
        1,
        this.config.maxTtlSeconds,
        "ttl_seconds",
      );
      const expires = new Date(
        Math.min(this.clock() + ttl * 1000, new Date(s.expires_at).getTime()),
      );
      const inviteId = uuid(),
        raw = secret();
      await tx.query(
        "INSERT INTO invites(id,session_id,secret_hash,max_uses,expires_at) VALUES($1,$2,$3,$4,$5)",
        [inviteId, id, this.auth.digest(raw), uses, expires],
      );
      await this.event(tx, "invite.created", id);
      return { invite_id: inviteId, invite_token: raw, expires_at: expires };
    });
  }

  async revoke(
    id: string,
    token: string,
    target: string,
    kind: "invite" | "participant",
  ) {
    requireThat(
      uuidPattern.test(target),
      "NOT_FOUND",
      "Resource not found.",
      404,
    );
    const table = kind === "invite" ? "invites" : "participants";
    await this.db.transaction(async (tx) => {
      await this.owner(tx, id, token, true);
      const row = await one(
        tx,
        `UPDATE ${table} SET revoked_at=$3 WHERE id=$1 AND session_id=$2 RETURNING id`,
        [target, id, this.now()],
      );
      requireThat(row, "NOT_FOUND", "Resource not found.", 404);
      if (kind === "participant") await this.membershipStatus(tx, id);
      await this.event(
        tx,
        `${kind}.revoked`,
        id,
        kind === "participant" ? target : undefined,
      );
    });
    this.log(`${kind}.revoked`, { session_id: id });
    this.notify(id);
    return { revoked: true };
  }
  async cleanup() {
    await this.db.query("DELETE FROM sessions s WHERE expires_at<$1 AND NOT EXISTS (SELECT 1 FROM agent_sessions a WHERE a.id=s.id)", [
      new Date(this.clock() - this.config.retentionSeconds * 1000),
    ]);
    await this.db.query("DELETE FROM security_events WHERE created_at<$1", [
      new Date(
        this.clock() -
          (this.config.retentionSeconds + this.config.maxTtlSeconds) * 1000,
      ),
    ]);
    this.rate.sweep();
  }
}
