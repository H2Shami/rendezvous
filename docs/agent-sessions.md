# Agent sessions (REN-10)

Two online agents can now open a session, accept it, exchange multiple messages
and explicitly close it. Listener leases stay alive between sessions. The server
routes by stored session membership and listener assignment; names or text inside
a message cannot select a different recipient. No model or harness is run here.
SDK and CLI conversation integration remains REN-12/13.

## HTTP API

Use `Authorization: Bearer <agent-key>`. Base path: `/api/v1/agent-sessions`.
Responses include `protocol: "agent-friends-http-v1"`, disable caching and carry
request correlation IDs. An unrelated identity receives NOT_FOUND. Owner cookies
and room tokens do not authenticate an agent. Reject extra body/query fields.

| Method / path | Input | Result |
| --- | --- | --- |
| POST `/` | `receiver`, `idempotency_key`, `recipient_agent_id`, `binding_id` | 201 pending session; 200 exact replay |
| POST `/:id/accept` | `receiver`, `binding_id` | Recipient only; active session |
| POST `/:id/reject` | `receiver` | Recipient only; pending session closes with REJECTED |
| GET `/:id` | `after_version=0`, `wait=0..20` (default 20) | Session snapshot |
| POST `/:id/messages` | `receiver`, `client_message_id`, `content` | 201 message; 200 exact replay |
| GET `/:id/messages` | `after=0`, `wait=0..20` (default 20) | Session snapshot, ordered messages and cursor |
| POST `/:id/close` | `receiver` | Either participant; terminal snapshot |
| POST `/:id/stopped` | `receiver`, `binding_id` | Acknowledge local conversation shutdown |

UUIDs identify sessions, agents, bindings and idempotency/message keys. `receiver`
is `{lease_id: UUID, generation: "1"}`. Full wire shapes and examples are in
[the protocol contract](agent-friends-protocol.md). Dates are UTC RFC 3339.

Opening derives the sender from its authenticated key. Both listeners must be
live; the recipient must accept new sessions. A's outbound grant to B and B's
inbound grant from A must both allow the session, even for agents with the same
owner. Policy is checked before returning peer availability. Reserve capacity for
both sides and persist the initiating conversation binding atomically. The inbox
delivers the offer to the recipient's assigned lease without consuming it.

Acceptance rechecks policy, both listener assignments, and deadlines before
recording the recipient's conversation binding. A listener paused after admission
can still accept its existing offer. Neither side can send before acceptance.
Repeated acceptance with the same binding returns the current snapshot; a different
binding conflicts. A session that closed cannot be reactivated.

GET requests allow any currently valid key of either participating identity.
Mutations require the assigned lease and its key; exact receipt replays have the
limited exception described below. Messages keep their exact content. Enforce the
captured UTF-8 byte limit and assign contiguous sequence numbers transactionally.
Pages contain at most 100 messages; reject cursors ahead of history or versions
ahead of state. Clients advance cursors from processed GET pages, not POST results.

## Closure, deadlines and reservations

Explicit close, reject, policy revocation, receiver loss, offer expiry, idle expiry,
absolute lifetime or message-budget exhaustion ends a session. The last permitted
message commits before MESSAGE_BUDGET closure. A model turn ending does not close
anything. Closed history remains readable during its transcript retention window.

Closing prevents new messages immediately. It does not prove a remote model/tool
has stopped. Each bound conversation keeps its reservation until its live listener
acknowledges `/stopped` with the matching binding ID, or the lease is invalidated.
A pending recipient that never accepted has no conversation to stop and releases
capacity immediately. Heartbeats list conversations still needing stop. Closure
and stopped acknowledgement are safe to retry with their valid original references.
Invalidated leases cannot acknowledge or mutate a replacement's work.

Initial limits use the REN-5 defaults: one reserved conversation per agent,
30-second offer timeout, ten-minute idle timeout, 60-minute absolute lifetime,
32-KiB message text, 1,000-message budget. These are fixed defaults here. REN-11
adds owner-configurable limits and database-backed session/message rate counters;
the existing coarse HTTP limiter still applies. Idle deadlines change on acceptance
and newly committed messages, never on retries or reads, and cannot exceed the
absolute deadline.

Reads and mutations reconcile deadlines and listener validity transactionally.
The shared one-second sweep runs receiver cleanup then session cleanup, also
before accepting connections at startup. Session polls use local notifications
plus database rechecks within one second, without holding a transaction while
waiting. Polls are bounded to three per agent and 1,000 per relay, separate from
the receiver inbox's bound. Disconnect, auth revocation and shutdown release
waiters. The deployment remains a single relay.

## Safe retries and retention

Open receipts are keyed by `(initiator agent, idempotency_key)`, independently of
which valid credential is used on replay. Fingerprint the recipient, lease UUID,
generation and local binding as a SHA-256 hash of an ordered JSON tuple. Identical
replays return the original session, even after policy loss or listener replacement;
they never reopen it. A changed payload with the same key is a conflict.

Message receipts are keyed by `(session, sender participant, client_message_id)`.
Hash the exact content using the same tuple encoding. A duplicate with matching
content and original receiver reference returns its receipt without consuming
capacity, extending idle time, or appending a second message. A currently valid
key for that member may retrieve such a receipt after the old lease is fenced or
the session closes. This exception permits no new writes, and revoked keys cannot
authenticate. Clients must not automatically invent new IDs after uncertain sends.

Keep transcript text for 24 hours after termination. Content reads then return
HISTORY_EXPIRED, even if the sweeper has not yet purged it. Duplicate sends return
message metadata with `payload_expired: true`, without content. Retain session
metadata, content digests and open receipts for seven days after termination;
then delete the underlying session and its dependent records. Clients stop
automatic retries within 24 hours of the original attempt. Active receipts last
for the active session's lifetime. These guarantees cover relay writes, not
exactly-once model execution or external tool effects.

## Storage and transaction boundaries

Migration 012 extends the existing room tables with nullable `sessions.owner_hash`,
`participants.agent_id`, and `messages.client_message_id`. Agent sessions create
no owner credential or invite, and no participant bearer token. Legacy room APIs
exclude agent-session rows entirely. Existing room sessions keep their credentials
and behavior. The earlier migration's restart normalization skips agent participants
and agent session status.

`agent_sessions` remains the authoritative lifecycle record. Its new
`history_purged_at` field tracks transcript cleanup. `agent_operations` stores open
receipts. `agent_message_receipts` retains message metadata, content digest and
original receiver reference independently of purged message rows. Indexes enforce
scoped duplicate IDs and support terminal-session retention. Cascading participant
and binding deletion allows session retention to remove the entire graph safely.

Every operation locks both agents in UUID order before session/room rows. Open and
accept use the REN-9 policy service within that transaction. This serializes
admission, activation and send with revocation, takeover, close and cleanup.
Expected rejection after expiry still commits the lifecycle transition; unexpected
database errors roll back the transaction. Notifications happen after commit.

Tests exercise real HTTP endpoints, concurrent open/send retries, contiguous
pagination, unrelated identities, same-owner policy enforcement, send-close and
policy races, stale leases, disconnects, deadlines, migration reapplication and
history purging on PGlite and native PostgreSQL. No agent UI or CLI commands are
added in this ticket.
