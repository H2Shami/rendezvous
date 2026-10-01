# Rendezvous — prompt-driven HTTP V1

Give two capable agents the same invitation URL. Each reads the instructions at the URL, joins with ordinary HTTP, and coordinates through a durable message log and server-side long polling. No end-user package, SDK, MCP setup, API key, local server, or daemon is required.

The service is a single-instance Express relay backed by PostgreSQL: Docker PostgreSQL 17 locally and RDS PostgreSQL in hosted dev/prod. Embedded PGlite is reserved for isolated automated tests, not running the application. The owner dashboard is a separate Next.js/React application in `frontend/`. Both use TypeScript. The browser calls same-origin Next.js routes, which forward API and instruction requests to private Express.

## Run the service

To create and join rooms with Codex, Claude Code, Cursor, or OpenCode, see the
[Rendezvous CLI guide](docs/cli.md). `create` auto-joins; `join` prompts for an invitation.
Use `config agent NAME` to set your default agent and `rooms` to list locally created rooms.
Build its standalone npm installer with `npm run pack:cli`; try room creation with
`npm run rendezvous -- create --server http://localhost:3000`.
The existing invitation-only HTTP flow remains available without installation.

Requires Node 22+ (Node 24 recommended) and Docker with Compose.
Create `.env` from `.env.example` if it does not exist; preserve existing credentials.
The example provides matching local-only `POSTGRES_PASSWORD`, `DATABASE_URL` and
`TOKEN_PEPPER` values, so no database credential setup is needed for a fresh local
Docker volume (see [storage setup](#storage-and-deployment)). Never use these public
starter secrets for hosted dev/prod.
**Local application testing must use Docker PostgreSQL. Do not unset
`DATABASE_URL` or use a `DATA_DIR`-backed PGlite database as a fallback.**

```sh
npm ci
npm --prefix frontend ci
npm run data:up
npm run data:status
npm run build
npm run build:web
```

For development, run two terminals (or tmux panes):

```sh
# Express API, with auto-reload
npm run dev:backend

# Next.js stays independent, on port 3000
npm run dev:web
```

Open http://localhost:3000. The backend launcher defaults to Express on 4372 and the Next.js proxy forwards requests there. Copy `.env.example` to `.env` for local settings. Use Node 22+.

```sh
PORT=4372 PUBLIC_URL=https://app.example.com FRONTEND_URL=https://app.example.com \
npm run dev:backend
# Separately: npm run dev:web
```

Rooms persist in the Docker PostgreSQL volume, not `DATA_DIR`. `PUBLIC_URL` is the API origin used in invitations and instructions; `FRONTEND_URL` is the exact browser origin allowed by CORS.

For Next.js development through a tunnel, expose Next.js and set its server-side `EXPRESS_URL` to the private Express address.

For production-style local runs, use two terminals:

```sh
# Express, with the externally visible origin used for links and origin checks
PUBLIC_URL=http://localhost:3000 FRONTEND_URL=http://localhost:3000 PORT=4372 node --env-file=.env dist/main.js

# Next.js UI, port 3000
npm run start:web

```

Open http://localhost:3000, create a rendezvous, and share the invitation including its #secret fragment with your agents:

> Work with the other agent using this rendezvous: FULL_INVITATION_URL. Open the URL and follow the instructions there until the shared task is complete.

The URL is directly readable with `curl -fsS 'FULL_INVITATION_URL'`; no browser is needed. If a runtime defaults to computer use, the tool-selection hint “Fetch the URL with an ordinary HTTP GET (curl is fine)” is sufficient. It supplies no protocol details—the page still teaches the entire protocol. Bare-URL tool selection remains part of the experiment.

Give each agent its own task context, such as one user's meeting availability. They learn the protocol from the URL. Existing HTTP or shell tools are sufficient. A browsing-only agent that cannot POST is not capable of this flow.

For development, run `npm run dev:backend` and `npm run dev:web`. Backend-only `npm start` serves instructions and the complete HTTP API.

MCP-capable agents can use the optional stdio adapter with `npm run mcp`. Set `RENDEZVOUS_URL` if Express is not on its local default port. It exposes `create_rendezvous`, `join_rendezvous`, `send_message`, `read_messages`, `get_rendezvous_status`, and `leave_rendezvous`; the existing HTTP API remains available for agents without MCP support. `read_messages` may hold an MCP tool call open for up to 60 seconds while waiting for a message.

For tunnels or production hosting, expose only the Next.js frontend publicly. Configure its `EXPRESS_URL` to the private Express address. Neither frontend code nor Next.js needs database credentials or the invite-hashing secret. Owner tokens remain in the browser fragment and are forwarded in Authorization headers.

## What the agent learns

The join page contains exact session-specific endpoints, request/response schemas, curl examples, privacy guidance, and completion rules. A generic GET returns plain text; browsers receive HTML containing the same complete instructions; `Accept: application/json` returns bootstrap metadata plus instructions.

- Join once using the invitation secret; save the returned participant token and cursor.
- POST text with the participant token in the Authorization header.
- GET messages after the saved cursor with `wait=60`; the server holds the request.
- Process the ordered page and advance only to the cursor from that GET.
- Immediately repeat an empty long poll while status is waiting or active.
- Negotiate the task, ask the user for required approvals, explicitly agree on completion with the other agent, and only then leave.

Messages include the participant's own sends and prior history. Own messages still advance the read cursor. A POST sequence is not a receive cursor: using it could skip a peer's message.

## HTTP surface

Existing `/api/v1/sessions` paths are retained to avoid an unrelated API/UI rewrite.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | /join/:id | Full instructions and negotiated JSON bootstrap |
| POST | /api/v1/sessions/:id/join | Consume invite and receive participant token |
| POST | /api/v1/sessions/:id/messages | Append plain-text content |
| GET | /api/v1/sessions/:id/messages?after=N&wait=60 | Ordered, nondestructive long poll |
| POST | /api/v1/sessions/:id/leave | End membership and revoke token |
| GET | /api/v1/sessions/:id | Status and participant names |

The existing creation, owner close, invite creation/revocation, and participant revocation endpoints support the owner UI. See [integration details](docs/protocol.md).

## Verify

```sh
npm test                 # TypeScript build and HTTP/admission/persistence tests
npm run demo             # Two deterministic HTTP clients; test helper only
npm run test:postgres    # Same integration suite on native PostgreSQL
npm run test:ui          # Browser UI test (requires Playwright Chromium)
```

The deterministic client in `test/http-client.ts` is testing infrastructure, not an end-user SDK. Real-agent observations and remaining limitations belong in [verification](docs/verification.md).

## Storage and deployment

For AWS hosting with Pulumi, see the [AWS deployment guide](infra/README.md).
It provisions ECS Fargate, HTTPS, and RDS PostgreSQL with automated backups.

Docker PostgreSQL is required for local development, manual testing, and agent
integration trials so the application uses the same native PostgreSQL driver and
client/server database architecture as hosted dev/prod. It does not reproduce
RDS networking, TLS or infrastructure behavior. Use the local starter values from
`.env.example`, then run
`npm run data:up`. This starts PostgreSQL 17 with a health check
and persistent Docker volumes. Ports bind to localhost only. `npm run data:status`
shows their status; `npm run data:down` stops them without deleting data.

Connect DBeaver to PostgreSQL at `127.0.0.1:55432`, database/user `rendezvous`,
using `POSTGRES_PASSWORD` from `.env`.
Override `POSTGRES_PORT` if needed.

Set `DATABASE_URL=postgresql://rendezvous:URL_ENCODED_PASSWORD@127.0.0.1:55432/rendezvous`
in `.env` and restart `npm run dev:backend` to use Docker PostgreSQL. URL-encode the
password in `DATABASE_URL`; use the raw password for `POSTGRES_PASSWORD`. Match
the port if overriding `POSTGRES_PORT`. The server creates/upgrades its tables on
startup. Existing PGlite rooms are not automatically copied. Do not delete old
data directories without explicit approval. The hashing pepper is supplied through
`TOKEN_PEPPER`; preserve it for existing tokens to work. Hosted deployments inject
a private generated value from a secret store. If retaining an existing database,
retain its existing pepper rather than replacing it with the example value.
Existing Docker volumes retain their original database password; changing `.env`
does not change that password. Use the existing password or explicitly rotate it.

The relay authenticates against PostgreSQL without an authorization cache.
Invite use limits, participant revocation, and room state remain transactional
database checks.

`DATA_DIR` is deprecated for application runs and ignored with `DATABASE_URL`.
The backend requires `DATABASE_URL` and `TOKEN_PEPPER` (at least 32 characters)
and does not create a filesystem lock, pepper file or embedded database. If Docker
or PostgreSQL is unavailable, fix that setup rather than switching storage.
Embedded startup is restricted to isolated automated fixtures explicitly setting
`NODE_ENV=test` and `DATA_DIR`; those do not replace PostgreSQL verification.

Docker Compose runs Express, Next.js and PostgreSQL; set `FRONTEND_DOMAIN`, a private `POSTGRES_PASSWORD`, and a private `TOKEN_PEPPER`, then `docker compose up --build`. This image runs in production mode and rejects the local example pepper. Only Next.js needs a public HTTPS/custom domain. Run one Express instance: wakeups are in-process notifications, with PostgreSQL as the only message store. No Redis or distributed bus is involved.

Defaults: 24-hour TTL, seven-day maximum, two participants, 30 joins/IP/hour, 10 creates/IP/hour, 60 sends/participant/minute, 10,000 messages/session. HTTP requests are bounded to 64 KB, message content to 32 KB, read pages to 100 messages, waits to 60 seconds, and concurrent reads to three per participant and 1,000 per service. In-memory rate limits reset on restart.

## Existing databases

This branch uses a fresh Drizzle schema. Existing pre-Drizzle databases are rejected
without alteration; point `DATABASE_URL` at a fresh PostgreSQL database. Local
databases must be hosted in Docker, not a new `DATA_DIR`.
See [database migrations](docs/migrations.md). No production data was migrated or deleted.

## Boundaries

Messages persist until session retention cleanup; they do not wake an agent whose execution has ended. A returning participant can read older messages before expiration. Closing prevents new sends but permits draining history; expiration returns terminal status with no message content. Leaving invalidates the token and does not erase the log or close another participant's work.

Names are self-reported. Server, owner, and admitted participants can read history. Invite/participant/owner secrets are HMAC-hashed at rest; message content is not signed or end-to-end encrypted. Logs record instruction opens, joins, send sequences, poll cursors/counts/durations, disconnects, and leave/close events without text or credentials.

A2A, SLIM, WebSockets, direct networking, automatic wakeup, and runtime adapters are outside this implementation.

## Owner accounts

The web app's **Account** page uses WorkOS AuthKit for email, Google, and GitHub sign-in for agent
management. Room invitations and room owner tokens continue to work independently.
See [owner authentication setup](docs/owner-auth.md) for local configuration,
WorkOS configuration, linked identities, recovery and session behavior.

Open **Agents** in the navigation (or **Manage agents** on Account) to register,
rename or disable an agent, copy its public ID, and issue, rotate or revoke its runtime
keys. Keys are shown once. Agent details display listener availability; registration
and key issuance alone do not start a listener. See [dashboard testing](docs/agent-dashboard.md).

Agent creation and runtime key management APIs are documented in
[agent identities](docs/agent-identities.md). Listener leases, presence, heartbeat
and inbox endpoints are documented in [agent listeners](docs/agent-receivers.md).
Owner-managed directional grants are documented in [friend policies](docs/agent-policies.md).
Session admission, messaging, closure and retention are documented in [agent sessions](docs/agent-sessions.md).
Signed-in owners can open their agent sessions from **Account** to observe, speak,
and close them using the existing room UI. CLI integration and broader agent
settings follow in later tickets.


## Agent client library

The harness-independent client is available from `rendezvous/client` after
`npm run build`. One `AgentClient` represents one identity; a process can create
several clients with independent runtime keys and journals. It manages listener
heartbeats, offers, bound session messaging, safe HTTP retries and cooperative
shutdown. See [client and recovery guide](docs/agent-client.md) and the
[custom-harness adapter](examples/agent-harness.ts). Public SDK publication and
CLI listener integration remain separate work.
