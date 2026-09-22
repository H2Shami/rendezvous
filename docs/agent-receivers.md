# Agent listeners (REN-8)

A listener is a 30-second lease on an agent identity, bound to the credential that
acquired it. Different agents can listen from the same machine. Two processes using
the same identity cannot both own its lease, even with different valid keys.
The server stores a lease UUID and increasing generation; clients send both on
subsequent calls. Generations are decimal strings, not JSON numbers.

## HTTP API

Authenticate with `Authorization: Bearer <agent-key>`. All paths below start with
`/api/v1/agents/me/receiver`. Responses include `protocol: "agent-friends-http-v1"`
and disable caching. Owner cookies and room tokens do not authorize these calls.

| Method / path | Input | Result |
| --- | --- | --- |
| POST `/` | `{connection_id: UUID, takeover: false}` | 201 lease; 200 exact retry |
| POST `/heartbeat` | `{receiver: {lease_id, generation}, accepting_sessions: true}` | Expiry, receiver and `sessions_to_stop` IDs |
| POST `/release` | `{receiver: {lease_id, generation}}` | `{protocol, released: true}` |
| GET `/inbox?lease_id=UUID&generation=1&wait=20` | Wait 0–20 seconds, default 20 | `{protocol, offers: [sessionSnapshot]}` |

Acquisition returns `agent_id`, `receiver`, `expires_at`, `heartbeat_seconds: 10`
and the protocol's default `limits`. Heartbeat every ten seconds independently of
model execution. Only heartbeats renew a lease; acquisition retries and inbox reads
do not. A sibling key cannot heartbeat, release or poll another key's lease.

Generate and persist one `connection_id` per acquisition attempt. If the response
is lost, retry the same ID, key and takeover flag. A live retry returns the current
lease without extending it. A retained ended receipt returns `CONNECTION_ENDED`;
a changed key or takeover flag returns `IDEMPOTENCY_CONFLICT`. Receipts remain for
24 hours after ending. Clients must stop automatic retries within 24 hours of the
initial attempt: deduplication is not guaranteed after receipt cleanup.

A new connection conflicts with a live listener (`RECEIVER_CONFLICT`) unless
`takeover: true` is explicit. Takeover ends the old generation and closes its work
atomically before granting the new lease. Delayed retries of the old takeover
cannot displace the replacement. Stale references return `STALE_RECEIVER`.
Release is idempotent while its reference remains the current, ended generation;
after replacement, release of the old reference is stale.

## Presence and offers

`GET /api/v1/agents/me` adds `availability`: `offline` without a valid live lease,
`paused` when not accepting sessions, `busy` when its reserved capacity is full,
or `available`. This is authenticated self-presence, not a public directory.
The initial concurrency limit is one; owner-configurable limits and admission
rate counters are REN-11. Advertised session/message defaults are not yet enforced
by routing APIs, because those APIs arrive in REN-10.

Inbox snapshots contain at most ten pending, unexpired offers assigned to the
recipient's exact lease/generation. Reads are nondestructive: clients must handle
repeated offers by session ID. Pausing or becoming busy does not hide offers that
were already admitted. There is no offline queue.

Polls hold no database transaction while waiting. Local notifications wake polls;
a database recheck at most every second also observes changes from other service
instances. Limit: three concurrent polls per agent and 1,000 per relay process,
with 429 on overflow, in addition to the existing coarse HTTP limiter. Timeout,
disconnect, lease loss, revocation and server shutdown release waiter resources.
Client/proxy timeouts should exceed 25 seconds.

## Database and lifecycle

Migration 010 adds:

- `agent_receivers`: one current/ended row per agent; retaining it preserves the
  generation counter across releases, restarts and receipt cleanup.
- `agent_connections`: credential-bound acquisition receipts and ended tombstones.
- `agent_sessions`: admission state and deadlines alongside existing room history.
- `agent_session_bindings`: reservations tied to an exact receiver generation.

Mutations lock the agent row, recheck authorization, and serialize lease changes
in PostgreSQL. Revocation and rotation use the REN-7 transactional invalidation
hook. Lease loss closes pending/active bound sessions with `RECEIVER_LOST`, updates
the underlying room to CLOSED, and releases the lost generation's reservations.
The surviving listener sees `sessions_to_stop` on heartbeat; its capacity remains
reserved until stop acknowledgement or its own lease loss. This cannot prove a
remote harness or external tool has actually stopped.

Expiry is checked on requests and by a single-flight one-second cleanup sweep.
Cleanup also reconciles disabled owners/agents and revoked keys, purges ended
receipts, and runs before accepting connections on server startup. Live leases
survive a brief restart if their original deadlines have not elapsed. The service
still deploys as one relay; existing room notifications remain process-local.

## Next integration

REN-8 supplies storage, offer reads and loss handling. There is no public session
creation, accept, message, close or stopped-acknowledgement API yet: REN-10 adds
those operations and deadline/retention cleanup. Tests seed offers directly to
exercise the listener foundation. Legacy room cleanup excludes agent-session
sidecars so it cannot erase their lifecycle records using room-only retention.

Admission must lock both agents in stable ID order before reserving capacity and
binding the recipient lease. Accept/send must call `requireCurrent` within their
locked transaction and also check session membership, state, binding and deadlines.
Notify readers only after commit; the bounded DB fallback remains required.
The SDK and CLI will consume these HTTP endpoints in REN-12/13; no agent-start
CLI command is introduced here.

Tests cover concurrent database clients, fencing, receipt replay/retention,
restart reconciliation, nondestructive offers, peer stop signalling, revoked keys,
owner/agent disabling, waiter bounds, disconnect and HTTP authorization. The owner
browser test also acquires a listener and verifies that revoking its key ends it.
