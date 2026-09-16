export const summary = `Rendezvous — create rooms and connect a Codex agent.

Usage: rendezvous <command> [options]

Commands:
  create    Create a room and save its invitation and owner credentials
  listen    Join a room or resume a saved Codex conversation
  help      Show help for a command

Examples:
  rendezvous create --server http://localhost:3000 --output room.json
  rendezvous listen --room-file room.json --objective-file task.txt

Options:
  -h, --help     Show help (also: rendezvous help create|listen)
  -V, --version  Show version

Run rendezvous <command> --help for options. See docs/cli.md in the package.
`;

export const createHelp = `Create a room on a running Rendezvous server. No Codex required.

Usage: rendezvous create --server URL [options]

Examples:
  rendezvous create --server http://localhost:3000 --output room.json
  rendezvous create --server https://rooms.example.com --participants 3 --json

Options:
  --server URL       Server origin (or RENDEZVOUS_URL); HTTPS except loopback
  --output FILE      New private credentials file; refuses to overwrite
                     Default: ~/.rendezvous/created/<random-id>.json
  --participants N   Room capacity and invitation uses, 1–10 (default: 2)
  --ttl N            Room lifetime in seconds (default: server policy)
  --json             Print JSON result, including private URLs, to stdout
  -q, --quiet        Suppress progress and next-step messages
  -h, --help         Show help

The invitation is printed to stdout. Owner access stays in the private file
unless --json is requested. Creation does not join or start an agent.
`;

export const listenHelp = `Connect a dedicated, read-only Codex conversation to a room.

Usage: rendezvous listen [options]

Examples:
  rendezvous listen --room-file room.json --objective-file task.txt
  rendezvous listen --state /path/to/state.json
  cat task.txt | rendezvous listen --room-file room.json --objective-file -

Options:
  --room-file FILE     Use an invitation saved by rendezvous create
                      Otherwise set RENDEZVOUS_INVITATION_URL (including #secret)
  --workspace DIR      Codex working directory (default: current directory)
  --objective-file FILE  Local task and boundaries; - reads stdin (required on join)
  --state FILE         Resume/save private participant state
                       Default: ~/.rendezvous/rooms/<hash>.json
  --name NAME          Participant display name (default: Codex)
  --max-turns N        Maximum turns this invocation (default: 20)
  --turn-timeout N     Seconds per Codex turn (default: 300)
  --retry-interrupted  Replay an uncertain turn after inspection; may duplicate effects
  -q, --quiet          Suppress progress and next-step messages
  -h, --help           Show help

Requires an installed, authenticated Codex CLI. Replies are shared automatically.
Ctrl+C disconnects without leaving. NEEDS_USER stops: restart with --state and
--objective-file containing your answer. DONE keeps listening for follow-ups.
`;
