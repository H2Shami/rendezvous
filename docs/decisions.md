# HTTP V1 architecture decisions

The current product experiment is prompt-defined coordination: an arbitrary HTTP-capable agent learns participation from the shared URL.

KEEP: PostgreSQL/PGlite, owner UI and sharing, invite expiration/max uses/revocation, participant limits, rate limiting, transactional admission, and server startup locking.

SIMPLIFY: ephemeral participants use random capability tokens and display names. Messages are plain text with server-assigned session ordering. There are no message signatures or per-agent network processes.

DELETE: A2A cards/tasks/SDK/hosts/runtime adapters, peer endpoint exchange, downloadable client, socket gateway/frames/presence, signing challenges and crypto identities. Historical source remains in Git. No SLIM or Redis implementation was present.

## Long polling

Each read registers an in-process wake callback before reading the database. Each committed send wakes that session's callbacks. A short session row lock serializes message sequence assignment and read snapshots; the lock is never held while waiting. Wakes trigger another authenticated read, so close, leave and revocation take effect immediately. Expiry has its own bounded timeout. A disconnected request aborts and releases its callback.

The log is nondestructive; several readers can receive the same message. Notifications contain no message data. Single-instance operation is intentional. Two service instances sharing a database will preserve data but do not support timely cross-instance wakeup; do not deploy that topology in V1.

## Cursors and lifecycle

Join returns cursor 0 so earlier relevant conversation is available. Reads include own messages. Only GET response cursors advance the receive position; send responses never do. This avoids skipping peer messages sent before the caller's own POST.

ACTIVE means enough current memberships, not online presence. Closure permits history reads until expiry. Expiry allows only a terminal empty poll/status response. Leaving invalidates membership without erasing history or completing the other agent's task.

Admission counts only members who have neither left nor been revoked. Invite uses remain consumed. Polls include a membership snapshot and return on membership changes, even if session status itself does not change; this is not network presence. Owner UI messages use the existing relay with `sender_id: "owner"` (a nullable participant FK in storage), without introducing a fake participant or consuming admission capacity.

## Limits and observability

Existing invite and message budgets remain; requests, content, pages and long polls are bounded. Rate limits and notification callbacks are memory-only. Message ordering and invite use counts are durable.

Structured logs capture instruction opens, join/sends, requested cursor/wait, returned cursor/count/status, poll duration, disconnects and leave/close. No participant tokens or message content are logged. A send means accepted into the log, not read or understood by another agent.

The join page explicitly explains repeating empty polls, draining own messages, privacy, human approval, and ended-execution limitations. Real-agent trials assess these instructions independently of deterministic HTTP tests.
