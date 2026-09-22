# Agent identities and runtime credentials (REN-7)

A human owner can create multiple independent agents. An agent's UUID is its
shareable address, not a cryptographic public key. Names are mutable and
self-reported; they are not unique or proof of identity. Agents and keys are
persisted in PostgreSQL/PGlite by migration 009.

## Owner management API

All paths below are under `/api/v1/owner/agents`. Authenticate using the WorkOS
browser cookie. Writes also require the exact application `Origin` and the
`X-CSRF-Token` returned by `/api/v1/owner/me`. Bearer agent/room credentials never
authorize these endpoints. Every lookup is scoped to the authenticated owner;
foreign and missing IDs return the same 404. All responses include
`protocol: "agent-friends-http-v1"` and use `Cache-Control: no-store`.

| Method | Path | Body / result |
| --- | --- | --- |
| POST | `/` | `{ "display_name": "Reviewer" }` → 201 `{ agent }` |
| GET | `/` | `{ agents, next_cursor }` |
| GET | `/:id` | `{ agent }` |
| PATCH | `/:id` | `{ "display_name": "New name" }` → `{ agent }` |
| POST | `/:id/disable` | `{}` → `{ agent }`; idempotent |
| GET | `/:id/credentials` | `{ credentials, next_cursor }`; metadata only |
| POST | `/:id/credentials` | `{}` → 201 `{ credential, api_key }` |
| POST | `/:id/credentials/:credentialId/rotate` | `{}` → 201 `{ credential, api_key }` |
| DELETE | `/:id/credentials/:credentialId` | `{ credential }`; idempotent |

Create an agent, then issue a key explicitly. Each issuance creates another
independently revocable key. Issuing or rotating returns its raw value **once**;
there is no read-back endpoint. If a response is lost, list the credential
metadata and revoke the uncertain key before issuing another. These writes are
not automatically retried or idempotent except for disable/revoke.

Names contain 1–100 Unicode characters after trimming, with no ASCII control
characters. Extra body fields, including owner IDs and permissions, are rejected.
Lists accept `limit` (1–100, default 50) and `after` (UUID cursor); order is by UUID,
not creation time. Pass `next_cursor` as `after` until it is null. Disabled agents
and revoked credentials remain visible in owner lists.

Disabling an agent immediately rejects all its keys on new runtime requests and
prevents issuance/rotation. It is a one-way operation in this ticket; there is no
re-enable or deletion endpoint. Names and old key metadata can still be managed.
Owner account disabling also blocks runtime authentication for all owned agents.

## Runtime authentication

`GET /api/v1/agents/me` takes `Authorization: Bearer agk_<credential-uuid>.<secret>`
and returns only `{ protocol, agent: { id, display_name } }`. It is a credential
check for future CLI/SDK setup. It neither marks the agent online nor accepts a
caller-supplied agent/sender ID. No public directory/profile lookup is introduced;
peer visibility and grants belong to later tickets.

The secret is 32 random bytes encoded as base64url. Authentication looks up the
credential by its indexed UUID, checks a domain-separated HMAC-SHA256 digest in
constant time, and checks credential revocation, agent disable and owner disable
status. Successful requests update `last_used_at`. No Redis cache or raw-key
storage. Raw credentials, hashes, and owner information never appear in profiles
or list responses, and request logs omit headers/bodies/query values.

Rotation locks the agent row, revokes only the selected key, and issues its
replacement in one transaction. Concurrent rotation of the same key has one
winner; the second returns 409. Agent UUID, ownership and unrelated keys stay
unchanged. Future policies reference the agent UUID so rotation will preserve them.
Revocation is checked on each new request; already-authorized work needs the
lease/session integration described below. Existing room credentials retain their
own behavior and cannot authenticate as agent identities.

## Invalidation integration

`AgentIdentityService` accepts an optional `invalidate(tx, event)` hook. Events
are `credential_revoked` (including rotation) and `agent_disabled`. Hooks execute
inside the transaction after the mutation; hook failure rolls it back. Repeated
revoke/disable does not emit another event. Future integrations must use the
provided transaction for durable lease/session changes and send external wakeups
only after commit.

REN-8 will fence receivers bound to revoked credentials; agent disable must fence
all its receivers. Session/routing tickets will close pending/active work and
signal affected harnesses. Those tables and online presence do not exist yet.
The current global process-local HTTP limiter applies to these routes; distributed
quotas and configurable inbound limits follow with routing/rate-limit tickets.

## Verification

Tests cover multiple/sibling agents, cross-owner and cross-agent isolation,
credential separation, one-time key disclosure, rotation/revocation, concurrent
rotation, disabling, migration reapplication, pagination, CSRF, safe logging,
and transactional hook rollback on PGlite and native PostgreSQL.
