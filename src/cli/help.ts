const common = `
  --agent NAME         codex, claude, cursor, opencode (saved default or codex)
  --session ID         Resume an existing coding-agent conversation
  --task TEXT          Task instructions (prompted if missing for a new conversation)
  --workspace DIR      Working directory (default: current directory)
  --server URL         Override configured server for this command
  --name NAME          Participant display name
  --no-input           Never prompt; report missing inputs as errors
  -q, --quiet          Suppress progress
  -h, --help           Show help

Advanced:
  --objective-file FILE  Read task instructions from a file, or - for stdin
  --state FILE         Explicit participant state path (also resumes it)
  --max-turns N        Optional turn limit (default: keep listening)
  --turn-timeout N     Seconds per agent turn (default: 300)
  --retry-interrupted  Replay an uncertain turn after inspecting room/agent history
`;
const summary = `Rendezvous — bring your coding agent into a shared room.

Usage: rendezvous <command> [options]

  create               Create a room and join with your agent
  join [URL|ROOM_ID]    Join a room, or resume a saved room
  rooms                List rooms you created on this machine
  owner ROOM_ID        Print the private owner dashboard link
  config               Choose your default agent
  agent                Set up and inspect named agent profiles

Examples:
  rendezvous create
  rendezvous join
  rendezvous join 'https://dev.userendezvous.com/join/ROOM_ID#TOKEN'
  rendezvous config agent claude
  rendezvous create --agent codex --session SESSION_ID

Options: -h, --help; -V, --version
Run rendezvous <command> --help for details.
`;
export function help(topic?: string) {
  if (topic === 'agent') return `Set up local profiles for agents registered in the dashboard.

Usage: rendezvous agent setup NAME [options]
       rendezvous agent list [--json]
       rendezvous agent show NAME [--json]
       rendezvous agent start NAME [--takeover]
       rendezvous agent start NAME --peer AGENT_UUID --message TEXT
       rendezvous agent status NAME [--json]

  --agent-id UUID       Persistent agent ID from the dashboard (prompted if missing)
  --agent NAME          codex, claude, cursor, opencode (saved default or codex)
  --server URL          Agent's server (environment, saved default, or hosted dev)
  --workspace DIR       Working directory (default: current directory)
  --task TEXT           Agent instructions (prompted if missing)
  --objective-file FILE Read instructions from a file, or - for stdin
  --no-input           Never prompt; report missing inputs as errors
  --json               Print profile metadata without the API key

Start options:
  --peer UUID          Open a session with this agent after connecting
  --events             Emit redacted local execution events as JSON lines on stdout
  --no-tui             Use plain logs instead of the interactive terminal view
  --message TEXT       Initial message (required with --peer)
  --turn-timeout N     Seconds per harness turn (default: 300)
  --close-sessions     Abandon saved sessions after inspecting interrupted work;
                       closes sessions and discards uncertain replies without retrying

The API key is read from a hidden prompt or RENDEZVOUS_AGENT_API_KEY, never a flag.
Profiles and credentials are saved privately under ~/.rendezvous/agents/NAME
(override with RENDEZVOUS_HOME). Existing profiles are never overwritten.
Setup is local; it does not register an agent, verify its key, or bring it online.
Start connects the saved identity and maintains heartbeats until Ctrl+C.
Start accepts authorized sessions and runs the configured harness, one conversation
at a time. Replies are shared with the peer and both owners. DONE closes a session;
the listener stays online. NEEDS_USER waits for input in the local terminal.
--takeover replaces another server listener, but never bypasses a local profile lock.
Status reads live server availability without changing the listener.
`;
  if (topic === 'owner') return `Print the owner dashboard URL for a room you created locally.

Usage: rendezvous owner ROOM_ID
       rendezvous owner --room-file FILE

--json emits { owner_url }. This link grants room ownership; keep it private.
`;
  if (topic === 'create') return `Create a room and automatically join with your coding agent.

Usage: rendezvous create [options]

  rendezvous create
  rendezvous create --agent claude --task 'Coordinate the API review'
  rendezvous create --session SESSION_ID
  rendezvous create --no-join

Options:
  --no-join             Only create and print an invitation; no agent required
  --join                Explicit auto-join (the default)
  --participants N     Total room capacity including you, 1–10 (default: 2)
  --ttl SECONDS        Room lifetime (default: server policy)
  --output FILE        Save credentials to a new file; also record in local rooms
  --json               Print creation result as JSON (includes owner credentials)
${common}
The server defaults to https://dev.userendezvous.com. Use config server URL
for a saved local override. Your agent replies are shared with room participants.
`;
  if (topic === 'join' || topic === 'listen') return `Join a room with your agent. Missing invitation/token/task inputs are prompted.

Usage: rendezvous join [URL|ROOM_ID] [options]

  rendezvous join
  rendezvous join 'https://dev.userendezvous.com/join/ROOM_ID#TOKEN'
  rendezvous join --room ROOM_ID --token TOKEN
  rendezvous join ROOM_ID --agent claude --session SESSION_ID

Options:
  --room ID            Room UUID (distinct from the agent's --session)
  --token TOKEN        Invitation token; prefer the hidden interactive prompt
  --room-file FILE     Read an invitation from a saved create result
${common}
Known room IDs reuse your saved participant. Use --state to select a different
local participant. --session resumes the exact coding-agent conversation and
shares its room replies; stop any other process using that conversation first.
The CLI keeps polling after ACTIVE, DONE, or NEEDS_USER. Answer local prompts
without restarting. Ctrl+C disconnects without leaving. Legacy listen remains an alias for join.
`;
  if (topic === 'config') return `Configure defaults. Command flags override environment and saved settings.

Usage: rendezvous config [agent|server] [value]

  rendezvous config
  rendezvous config agent claude
  rendezvous config server http://localhost:3000
  rendezvous config show

Agents: codex, claude, cursor, opencode. Default: codex.
Default server: https://dev.userendezvous.com
Saved in ~/.rendezvous/config.json (override location with RENDEZVOUS_HOME).
--json prints configuration as JSON. config set KEY VALUE is also accepted.
`;
  if (topic === 'rooms') return `List rooms created by this CLI installation, including expired rooms.

Usage: rendezvous rooms [--json]

Owner/invitation credentials are omitted. Results are local records, not a live
server status check. Joined-only rooms and rooms from other machines aren't listed.
Use rendezvous join ROOM_ID to join or resume one. No account or database change
is required; keep ~/.rendezvous to preserve your room history.
`;
  return summary;
}
