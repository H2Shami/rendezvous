# Agent Rendezvous — prompt-driven HTTP V1

Give two capable agents the same invitation URL. Each reads the instructions at the URL, joins with ordinary HTTP, and coordinates through a durable message log and server-side long polling. No end-user package, SDK, MCP setup, API key, local server, or daemon is required.

The service is a single-instance Express relay backed by PostgreSQL or embedded PGlite. The owner dashboard is a separate Next.js/React application in `frontend/`. Both use TypeScript. A reverse proxy exposes one public origin; API requests and long polls go directly to Express, not through Next.js functions.

## Run the service

Requires Node 22+ (Node 24 recommended).

```sh
npm ci
npm --prefix frontend ci
npm run build
npm run build:web
```

For development, run two terminals (or tmux panes):

```sh
# Express + routing proxy, with auto-reload and readable [server] / [proxy] logs
npm run dev:backend

# Next.js stays independent, on port 3001
npm run dev:web
```

Open http://127.0.0.1:8080. The backend launcher defaults to Express 3000 and proxy 8080, automatically wires API_TARGET and PUBLIC_URL, and stops both watchers/server processes on Ctrl-C without stopping Next.js. Use Node 22+. Custom ports and ngrok work with the same command:

```sh
PORT=4372 PROXY_PORT=4371 PUBLIC_URL=https://YOUR-DOMAIN.ngrok-free.app \
DATA_DIR=/path/to/existing/server-data npm run dev:backend
# Separately: ngrok http 4371
```

Do not run the individual Express/proxy processes at the same time as the combined launcher. Keep DATA_DIR unchanged to retain existing rooms. When ngrok changes its domain, restart the launcher with the new PUBLIC_URL. The launcher deliberately derives API_TARGET from PORT so these cannot drift apart.

For Next.js development through ngrok, set the same `PUBLIC_URL` in `frontend/.env.local` (gitignored) or run `PUBLIC_URL=https://YOUR-DOMAIN.ngrok-free.app npm run dev:web`. Next derives its exact `allowedDevOrigins` hostname from this value. Update it when the tunnel domain changes. This allows frontend hot reload through the proxy without broadly allowing other ngrok sites.

For production-style local runs, use three terminals:

```sh
# Express, with the externally visible origin used for links and origin checks
PUBLIC_URL=http://127.0.0.1:8080 PORT=3000 npm start

# Next.js UI, port 3001
npm run start:web

# Local routing proxy, port 8080 → Express 3000 / Next 3001
npm run dev:proxy
```

Open http://127.0.0.1:8080, create a rendezvous, and give both agents the full invitation including its #secret fragment:

> Work with the other agent using this rendezvous: FULL_INVITATION_URL. Open the URL and follow the instructions there until the shared task is complete.

The URL is directly readable with `curl -fsS 'FULL_INVITATION_URL'`; no browser is needed. If a runtime defaults to computer use, the tool-selection hint “Fetch the URL with an ordinary HTTP GET (curl is fine)” is sufficient. It supplies no protocol details—the page still teaches the entire protocol. Bare-URL tool selection remains part of the experiment.

Give each agent its own task context, such as one user's meeting availability. They learn the protocol from the URL. Existing HTTP or shell tools are sufficient. A browsing-only agent that cannot POST is not capable of this flow.

For development, replace the first two processes with `PUBLIC_URL=http://127.0.0.1:8080 npm run dev` and `npm run dev:web`. The proxy supports Next's development hot reload; this does not introduce an agent WebSocket transport. Backend-only `npm start` no longer serves the owner dashboard; it still serves instructions and the complete HTTP API.

For ngrok, forward to the routing proxy, not directly to Next or Express. Set Express `PUBLIC_URL` to the ngrok HTTPS origin. Set `PROXY_PORT`, `API_TARGET` and `FRONTEND_TARGET` on `npm run dev:proxy` if using different ports. Neither frontend code nor Next.js needs database credentials or the invite-hashing secret. Owner tokens remain in the browser fragment and are sent directly to Express in Authorization headers.

## What the agent learns

The join page contains exact session-specific endpoints, request/response schemas, curl examples, privacy guidance, and completion rules. A generic GET returns plain text; browsers receive HTML containing the same complete instructions; `Accept: application/json` returns bootstrap metadata plus instructions.

- Join once using the invitation secret; save the returned participant token and cursor.
- POST text with the participant token in the Authorization header.
- GET messages after the saved cursor with `wait=60`; the server holds the request.
- Process the ordered page and advance only to the cursor from that GET.
- Immediately repeat an empty long poll while status is waiting or active.
- Negotiate the task, ask the user for required approvals, and leave when finished.

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

Copy `.env.example` for settings. Without DATABASE_URL, persistent PGlite data and the server's token-hashing pepper live in DATA_DIR. Keep that directory private and durable. A second server using the same directory refuses startup. DATABASE_URL selects native PostgreSQL.

Docker Compose runs Express, Next.js, PostgreSQL and Caddy; set DOMAIN and POSTGRES_PASSWORD, then `docker compose up --build`. Caddy routes `/api/*`, `/join/*`, `/protocol/*`, `/.well-known/*`, `/health` and the instruction stylesheet directly to Express; other paths go to Next.js. The relay upstream response-header timeout is 75 seconds. Production URLs require HTTPS. Run one Express instance: wakeups are in-process notifications, with PostgreSQL as the only message store. No Redis or distributed bus is involved. The development proxy is tooling only; use Caddy for this production routing layout.

Defaults: 24-hour TTL, seven-day maximum, two participants, 30 joins/IP/hour, 10 creates/IP/hour, 60 sends/participant/minute, 10,000 messages/session. HTTP requests are bounded to 64 KB, message content to 32 KB, read pages to 100 messages, waits to 60 seconds, and concurrent reads to three per participant and 1,000 per service. In-memory rate limits reset on restart.

## Existing databases

Migrations adapt original message storage in place: plain text is extracted from old payloads, session ordering is retained, and obsolete signing/endpoint fields are removed. Structured legacy payloads become JSON text. Original signing-only participants are revoked because their credentials cannot authenticate here. Revoked/departed participants stay in history but do not occupy current admission slots. Already-issued random participant tokens remain usable until leave/revocation/expiry.

Back up an existing deployment before upgrade. No migration was run against your production data during development.

## Boundaries

Messages persist until session retention cleanup; they do not wake an agent whose execution has ended. A returning participant can read older messages before expiration. Closing prevents new sends but permits draining history; expiration returns terminal status with no message content. Leaving invalidates the token and does not erase the log or close another participant's work.

Names are self-reported. Server, owner, and admitted participants can read history. Invite/participant/owner secrets are HMAC-hashed at rest; message content is not signed or end-to-end encrypted. Logs record instruction opens, joins, send sequences, poll cursors/counts/durations, disconnects, and leave/close events without text or credentials.

A2A, SLIM, WebSockets, direct networking, automatic wakeup, and runtime adapters are outside this implementation.
