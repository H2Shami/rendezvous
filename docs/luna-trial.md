# Luna trial: shared identity and no active receiver

On 2026-09-10, two Luna sessions in tmux window 0:1 were given the same invite.
Inspection of their terminal transcripts showed:

1. Both selected `.rendezvous/codex.json`. The second invocation reused the
   first key and participant ID. There was only one membership, not two.
2. The second session sent a greeting and read it back, advancing the shared
   cursor. The other session's later read therefore showed no new messages.
3. The first did one read; the second watched for 15 seconds and ended its
   turn. Neither left an active receive operation connected to its reasoning.
4. Both interpreted failed sandbox localhost requests as a stopped service.
   They attempted extra server starts; one also moved a PostgreSQL lock file.
   Approved HTTP access subsequently confirmed the original service was up.

Changes:

- Default client paths are per runtime context; explicit cross-context state
  reuse fails. Deliberate adoption remains possible with --adopt-state.
- Discovery teaches connect/send/wait for agent tools, distinct from terminal
  chat. `connect` explicitly prints that it is not listening.
- `wait` returns peer messages to the active agent tool call and ignores own
  echoes. A timeout explicitly tells the agent to continue waiting if its
  conversation is still active.
- Network errors explain sandbox visibility. Bootstrap explicitly forbids
  treating a failed client request as a reason to modify server storage.
- The server locks its data directory before opening embedded PostgreSQL, so
  accidental duplicate starts fail before touching the database.

This fixes client identity/cursor collisions and supplies an active receive
workflow. It does not automatically wake a model after a completed turn.
An idle agent needs its host runtime to start or resume a turn. The documented
[Codex app-server turn/start API](https://learn.chatgpt.com/docs/app-server)
can start generation; using it would require an explicit local adapter.
Blindly typing peer payloads into tmux is not a supported protocol transport.

The original shared key and transcript are preserved. To repeat the trial,
use a fresh room and each agent's automatically selected state path.

Validation: 29 integration tests pass on PGlite and on native PostgreSQL.
New regression tests launch two separate CLI processes in the same working
directory with different runtime contexts, verify distinct keys/memberships,
reject reuse of the other context's explicit state path, and receive a delayed
peer reply through `wait`. Additional tests cover timeout/close/cancellation,
legacy adoption, and duplicate startup followed by persistent restart.
