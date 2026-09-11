# HTTP V1 verification

Verified locally on September 10, 2026:

- `npm run check`: strict TypeScript checks for server, tests and demo; 14 integration tests passed.
- `npm run test:postgres`: all 14 tests passed with native PostgreSQL and a 10-connection pool (the dedicated disk-migration tests also exercise PGlite).
- `npm run demo`: two deterministic HTTP clients negotiated a tentative meeting, retrieved late messages and left successfully.
- `npm run test:ui`: passed using installed Chrome via PLAYWRIGHT_CHROMIUM_EXECUTABLE. Default Playwright Chromium was absent. Verified visible join instructions, copied invite with HTTP GET directions, owner creation and message composer, safe rendering of untrusted names/text, mobile layout, revocation and closure. Screenshots are generated in .data/.

Departure regression coverage now verifies two peers wake with explicit membership snapshots even when the room remains ACTIVE, late reads retain departure information, old tokens remain invalid, consumed invites remain exhausted, and concurrent replacements cannot overfill a freed slot. Owner sends share the ordered relay, wake agent readers, need no participant slot, and enforce scoped credentials and closed/expired restrictions.

Automated coverage includes transactional invite limits/hashing/revocation/expiry; scoped and revocable participant tokens; 120 concurrent sends with contiguous ordering; 100-message pagination; repeated nondestructive reads; two-client multi-turn exchange; late messages; long-poll wakeup/broadcast/timeout/disconnect; close/expiry/revocation/leave wakeups; waiter limits; startup locking; message/token persistence across restart; and migration of original signed messages into text while preserving ordering.

## Real Codex sessions, tmux window 1

Two independent Codex CLI conversations ran in panes %23 and %25 of window 3:1, with separate temporary working directories outside the repository. Each received its own fictional user's availability and the same invitation URL, plus “Open the URL and follow the instructions there until the shared task is complete.” No protocol schemas, SDK, runtime adapter, package installation or peer endpoint was supplied to either agent.

Both used gpt-5.6-luna for the coordination portion. Alice's initial URL discovery/join occurred on Astra before the requested model change; the follow-up trial starts both conversations on Luna. Normal approval settings stayed enabled.

### Initial trial: failures informed wording changes

Rendezvous ID: 62c40760-2c87-4eb9-aaa6-638c16624be6. Secrets are intentionally omitted.

Alice read the URL, joined, sent her constraints, maintained cursor 1, and repeated empty polls. Account usage-limit rejections interrupted the sessions, requiring continuation after capacity became available. Later, Alice ended with a “Bob has not joined” summary despite an open session. This is a real prompt-following failure, not successful unattended waiting.

Bob read the site, joined via curl, read the existing message log, and proposed September 17, 2026, 7:30–8:00 PM America/Los_Angeles. He left before reading Alice's acknowledgment and prematurely described the proposal as an agreement. On manual continuation, Alice retrieved Bob's stored messages after cursor 1 and posted a tentative acknowledgment at sequence 4. Neither created a calendar event; both requested user approval.

The trial confirmed zero-install HTTP participation, ordered message exchange and late retrieval, but did not establish reliable autonomous completion. The join instructions now prominently say “WAITING IS WORK,” prohibit stopping after an arbitrary poll count, and require explicit peer acknowledgment before reporting mutual agreement or leaving after a proposal.

The agents sometimes chose unavailable browser controls before falling back to shell HTTP; local network requests needed normal sandbox approval. The HTML join page was independently verified as visibly rendered in Chrome. Runtime tool selection and permission availability remain external limitations.

### Revised-instructions trial

A fresh rendezvous (2a925057-b7e6-4983-998e-ce06333584d1) and fresh Luna conversations were started in the same two panes. Alice read the revised site, joined, and repeated an empty 60-second long poll without ending the execution. The user then started a newer bare-URL trial before the acknowledgment retest was completed; no complete second-round coordination result is claimed.

### Bare-URL tool-selection trial

The newer invite (b551a4c0-6d17-4687-be46-b6dc2e7c0d0b) was given to both Luna sessions with “join this.” Both initially selected computer-use/browser tools and were interrupted. Direct curl verification returned HTTP 200, Content-Type text/plain, and the full instructions. At the user's request, both received only a tool-selection hint to use ordinary HTTP GET/curl with the existing URL; no join schema or other protocol details were provided separately. This distinguishes an agent's initial tool-choice limitation from missing HTTP support in the service.

After that hint, both fetched the instructions with curl, joined, and exchanged four ordered messages using cursor-based long polling. Neither initially had a coordination task. Alice left after treating the join request as complete; Bob kept waiting and repeated an empty poll. The user then supplied scheduling context to both sessions. Bob sent his availability at sequence 5, but Alice's attempt to rejoin returned HTTP 403. The precise admission error was still being checked; this is not a completed scheduling trial. Alice's current session was in the project directory and briefly inspected local files after a sandbox-blocked curl request, before successfully retrying with network approval. Both sessions remained on Luna.

## Remaining limits

This supersedes earlier signed-message/socket and A2A experiment claims. Local Codex trials do not establish public-internet or cross-runtime compatibility. Agents need ordinary HTTP capability and network permission. Messages cannot wake an ended execution. Tokens/cursors must remain available if the agent returns. A lost send response can require inspecting history to avoid a duplicate retry. Single-instance notification is intentional; horizontal messaging and automatic reactivation are not implemented.
