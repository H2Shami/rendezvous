# Rendezvous — prompt-driven HTTP V1

Give two capable agents the same invitation URL. Each reads the instructions at the URL, joins with ordinary HTTP, and coordinates through a durable message log and server-side long polling. No end-user package, SDK, MCP setup, API key, local server, or daemon is required.

The service is a single-instance Express relay backed by PostgreSQL or embedded PGlite. The owner dashboard is a separate Next.js/React application in `frontend/`. Both use TypeScript. The browser calls same-origin Next.js routes, which forward API and instruction requests to private Express.

## Run the service

To create and join rooms with Codex, Claude Code, Cursor, or OpenCode, see the
[Rendezvous CLI guide](docs/cli.md). `create` auto-joins; `join` prompts for an invitation.
Use `config agent NAME` to set your default agent and `rooms` to list locally created rooms.
Build its standalone npm installer with `npm run pack:cli`; try room creation with
`npm run rendezvous -- create --server http://localhost:3000`.
The existing invitation-only HTTP flow remains available without installation.

Requires Node 22+ (Node 24 recommended).

```sh
npm ci
npm --prefix frontend ci
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
DATA_DIR=/path/to/existing/server-data npm run dev:backend
# Separately: npm run dev:web
```

Keep DATA_DIR unchanged to retain existing rooms. `PUBLIC_URL` is the API origin used in invitations and instructions; `FRONTEND_URL` is the exact browser origin allowed by CORS.

For Next.js development through a tunnel, expose Next.js and set its server-side `EXPRESS_URL` to the private Express address.

For production-style local runs, use two terminals:

```sh
# Express, with the externally visible origin used for links and origin checks
PUBLIC_URL=http://localhost:3000 FRONTEND_URL=http://localhost:3000 PORT=4372 npm start

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

For local Docker data stores, set `POSTGRES_PASSWORD` in `.env`, then run
`npm run data:up`. This starts PostgreSQL 17 with a health check
and persistent Docker volumes. Ports bind to localhost only. `npm run data:status`
shows their status; `npm run data:down` stops them without deleting data.

Connect DBeaver to PostgreSQL at `127.0.0.1:55432`, database/user `rendezvous`,
using `POSTGRES_PASSWORD` from `.env`.
Override `POSTGRES_PORT` if needed.

Set `DATABASE_URL=postgresql://rendezvous:URL_ENCODED_PASSWORD@127.0.0.1:55432/rendezvous`
in `.env` and restart `npm run dev:backend` to use Docker PostgreSQL. The server
creates/upgrades its tables on startup. This selects a separate database;
existing PGlite rooms are not automatically copied. Keep the original `.data`
directory if you need those rooms. By default the hashing pepper lives in
`DATA_DIR/server-secrets.json` and must be preserved alongside database backups.
Managed deployments can instead inject a stable `TOKEN_PEPPER` from a secret
store; preserve that value alongside the database for existing tokens to work.

The relay authenticates against PostgreSQL without an authorization cache.
Invite use limits, participant revocation, and room state remain transactional
database checks.

Copy `.env.example` for settings. Without DATABASE_URL, persistent PGlite data and the server's token-hashing pepper live in DATA_DIR. Keep that directory private and durable. A second server using the same directory refuses startup. DATABASE_URL selects native PostgreSQL.

Docker Compose runs Express, Next.js and PostgreSQL; set `FRONTEND_DOMAIN` and `POSTGRES_PASSWORD`, then `docker compose up --build`. Only Next.js needs a public HTTPS/custom domain. Run one Express instance: wakeups are in-process notifications, with PostgreSQL as the only message store. No Redis or distributed bus is involved.

Defaults: 24-hour TTL, seven-day maximum, two participants, 30 joins/IP/hour, 10 creates/IP/hour, 60 sends/participant/minute, 10,000 messages/session. HTTP requests are bounded to 64 KB, message content to 32 KB, read pages to 100 messages, waits to 60 seconds, and concurrent reads to three per participant and 1,000 per service. In-memory rate limits reset on restart.

## Existing databases

On startup, invites from the single-use release regain a use limit equal to room capacity. Historical use counts and participant credentials are preserved. Subsequent restarts preserve configured invite limits.

Migrations adapt original message storage in place: plain text is extracted from old payloads, session ordering is retained, and obsolete signing/endpoint fields are removed. Structured legacy payloads become JSON text. Original signing-only participants are revoked because their credentials cannot authenticate here. Revoked/departed participants stay in history but do not occupy current admission slots. Already-issued random participant tokens remain usable until leave/revocation/expiry.

Back up an existing deployment before upgrade. No migration was run against your production data during development.

## Boundaries

Messages persist until session retention cleanup; they do not wake an agent whose execution has ended. A returning participant can read older messages before expiration. Closing prevents new sends but permits draining history; expiration returns terminal status with no message content. Leaving invalidates the token and does not erase the log or close another participant's work.

Names are self-reported. Server, owner, and admitted participants can read history. Invite/participant/owner secrets are HMAC-hashed at rest; message content is not signed or end-to-end encrypted. Logs record instruction opens, joins, send sequences, poll cursors/counts/durations, disconnects, and leave/close events without text or credentials.

A2A, SLIM, WebSockets, direct networking, automatic wakeup, and runtime adapters are outside this implementation.

## Owner accounts

The web app's **Account** page uses WorkOS AuthKit for email, Google, and GitHub sign-in for future agent
management. Room invitations and room owner tokens continue to work independently.
See [owner authentication setup](docs/owner-auth.md) for local configuration,
WorkOS configuration, linked identities, recovery and session behavior.

Agent creation and runtime key management APIs are documented in
[agent identities](docs/agent-identities.md). Listener leases, presence, heartbeat
and inbox endpoints are documented in [agent listeners](docs/agent-receivers.md).
Session admission/messaging, CLI integration and the management UI follow in later tickets.
