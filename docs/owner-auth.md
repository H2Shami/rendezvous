# Owner account authentication (REN-6)

WorkOS AuthKit handles email/password, Google, GitHub, verification, recovery and
identity linking. Rendezvous maps the resulting stable WorkOS user ID to a local
owner UUID and uses WorkOS-managed browser sessions. One owner can later own many
agents; these accounts do not replace agent runtime keys or room capabilities.

## Local and hosted development

Use Node 22+. Create/select the Rendezvous project in WorkOS and use its **staging**
environment for both local development and the hosted dev app. Keep production in
a separate WorkOS production environment. In the backend's ignored `.env`, set:

```dotenv
WORKOS_API_KEY=sk_test_REPLACE_ME
WORKOS_CLIENT_ID=client_REPLACE_ME
PUBLIC_URL=http://localhost:3000
FRONTEND_URL=http://localhost:3000
```

Both WorkOS values must come from the same environment. Never use NEXT_PUBLIC_
for the API key, commit it, put it in frontend configuration, or paste it into
chat. With neither value, rooms still work but account sign-in is disabled.
Partial/invalid configuration fails startup. Restart `npm run dev:backend` after
changing `.env`; source watching does not reload environment variables.

Register both WorkOS application redirect URIs:

- `http://localhost:3000/api/v1/owner/callback`
- `https://dev.userendezvous.com/api/v1/owner/callback`

Configure the application's sign-in endpoint for each deployment as
`ORIGIN/api/v1/owner/login` where WorkOS requests it, and allow the matching logout
return destinations `http://localhost:3000/account` and
`https://dev.userendezvous.com/account`. Use exact URLs, without wildcards.

Enable email/password, Google, and GitHub in WorkOS AuthKit authentication
settings. If using your own Google/GitHub OAuth apps, copy the **WorkOS-provided
callback URI** into each provider's settings and put those client IDs/secrets in
WorkOS. Neither the old Cognito `/oauth2/idpresponse` URL nor Rendezvous's old
`/github/callback` route is used. WorkOS's staging shared OAuth credentials may be
used where offered. Configure branding in WorkOS so the hosted login, signup and
recovery pages match Rendezvous.

`/account` links to hosted AuthKit. It owns the password, email code, recovery and
social-provider interaction; those credentials never pass through our frontend
forms or API endpoints. The local frontend/backend and database remain local.
Share staging secrets only with trusted developers. A shared WorkOS identity does
not share local database contents or transfer agents between local and hosted dev.

## Identity linking and migration

WorkOS verifies email ownership and links supported credentials to a single User.
Our backend accepts only a verified WorkOS user and uses its `user_*` ID as the
subject. We do not select or merge owners by email. The internal issuer namespace
`https://api.workos.com/client/CLIENT_ID` separates environments; it is a database
namespace, not a JWT issuer. Keep client ID stable within an environment.

Migration 006 creates owners and temporary login attempts. Since REN-6 has not
been merged/deployed, fresh installations no longer create `owner_sessions`.
Migration 008 drops that ephemeral table on databases that ran earlier PR
revisions, switches attempts to WorkOS, and deletes unfinished legacy attempts.
Existing owner rows and their IDs/data remain intact. All earlier opaque browser
cookies require sign-in again; an existing WorkOS owner keeps its owner UUID.
Cognito/direct-GitHub users receive a new WorkOS-backed owner rather than an
automatic email-based ownership transfer. Before migrating accounts with real
agents/data, implement an explicit verified ownership transfer.

The previous shared dev Cognito pool `us-east-2_5EYdg33zR` was provisioned manually,
not by Pulumi. This change leaves that cloud resource intact. Old OWNER_OIDC_*,
OWNER_GOOGLE_ENABLED and direct GITHUB_CLIENT_* environment values are ignored.
They can be removed after verifying the migration; retire unused cloud resources
and credentials separately.

## Session and authorization model

The official WorkOS Node SDK builds hosted authorization requests with state and
S256 PKCE. A ten-minute, single-use DB attempt binds that state to an independent
HttpOnly browser cookie. State and cookie values are hashed with separate HMAC
domains; the PKCE verifier is derived from the browser secret. Callbacks use the
configured PUBLIC_URL, never caller-controlled Host headers. The backend consumes
the attempt atomically and exchanges the code directly with WorkOS using the
backend API key and verifier. No automatic retries of the code exchange.

The WorkOS Node SDK seals access/refresh tokens and user information into an
encrypted, authenticated HttpOnly cookie. The encryption password is derived with
a domain-separated HMAC from the existing persistent TOKEN_PEPPER (or local server
secret) and WorkOS client ID. No new deployment secret is required. Replicas must
share TOKEN_PEPPER; rotating it invalidates cookies as well as existing capability
hashes. Never rotate it merely to sign out a user.

On each authenticated request the SDK unseals the cookie and verifies the JWT
signature and expiration. Expired/invalid JWTs trigger SDK refresh; a successful
refresh replaces the browser cookie. Terminal refresh failures return 401;
transient failures return a sanitized 503 and preserve the cookie for retry.
Only verified users whose token subject matches the sealed user ID are accepted.
Rendezvous then checks its owner record and disabled_at. Neither access/refresh
tokens nor user profiles are stored in our database or returned by `/me`.

Cookies are HttpOnly, SameSite=Lax, path `/`, without Domain, and use Secure plus
__Host names on HTTPS. HTTP is supported only for loopback development. Cookie
retention is 14 days, renewed on refresh; WorkOS controls the actual session
lifetime and inactivity policy. `/me` reports the current access-token expiry,
not an independent app-session lifetime. No auth tokens are kept in localStorage
or sessionStorage. CSRF tokens are bound to the stable WorkOS session ID so token
refresh does not invalidate an open page's CSRF token.

| Endpoint under `/api/v1/owner` | Behavior |
| --- | --- |
| GET /config | Whether WorkOS is configured; no credentials |
| GET /login | Start bound AuthKit sign-in; optional screen=sign-up |
| GET /callback | Consume attempt, exchange code, set SDK-sealed cookie |
| GET /me | Return internal owner ID, expiry and CSRF token |
| POST /logout | Exact Origin + CSRF; revoke WorkOS session, clear cookies, return hosted logout URL |

Old `/email/*` and `/github/*` endpoints are retired. The Next proxy preserves each
Set-Cookie header. Login starts retain the existing 30/hour per-IP process-local
limit; WorkOS handles hosted credential and email-delivery protections. Rate
limits reset on process restart and are not shared across replicas yet.

Future management routes must first authenticate through the WorkOS provider,
resolve/check the local owner with OwnerService, scope every query by that owner
ID, and enforce same-origin + CSRF for writes. Submitted
owner IDs, agent keys and room tokens never authenticate as account principals.
Agent CRUD is REN-7; the signed-in page remains an account confirmation for now.

## Logout and revocation boundaries

Logout calls the WorkOS revocation API, clears cookies only after success, and
returns a hosted logout URL to end the provider's browser session too. A WorkOS
outage returns 503 so the user can retry; it does not claim successful revocation.
Browser logout does not revoke agent or room credentials.

Already-issued access tokens remain valid until their expiration, even after
WorkOS revocation. Subsequent refresh is denied. Configure a short access-token
lifetime in WorkOS to bound this window; there is no independent seven-day app
session anymore. Setting `owners.disabled_at` denies app access immediately on
every request. Cleanup only removes expired login attempts.

## Deployment

Per Pulumi stack, set enableOwnerAuth=true, workosClientId and secret workosApiKey.
Use the interactive `pulumi config set --secret workosApiKey` prompt so the secret
is absent from command history. AWS Secrets Manager stores the key and injects it
only into the backend task; the client ID is nonsecret backend configuration.
WorkOS, not Pulumi/Cognito, owns identity-provider settings. No database sharing is
introduced. Preview and deploy separately after registering the stack's URLs.
Production must use its own WorkOS environment and HTTPS callbacks.

The supplied WorkOS staging key has been validated and both local/hosted-dev
callback URLs registered. Real local GitHub sign-in, authenticated reload and the
logout API have been verified. The final hosted logout redirect currently reports
`app-homepage-url-not-found`: configure the staging Logout URIs/default return URL
in the WorkOS dashboard, then repeat logout. Google and cross-provider linking
still need live staging verification. No hosted application deployment is
included. Do not delete the old Cognito pool as part of this deployment.

## Verification

Tests exercise the real WorkOS SDK with a controlled HTTP transport: AuthKit URL,
PKCE, state, code exchange, verified-user checks, safe logout, and linked methods
mapping to one owner. Session tests exercise real SDK cookie encryption, JWT
signatures, refresh,
revocation at refresh, transient failures, CSRF, disabled/cross-owner checks,
migration and retired endpoints. Browser tests verify
login/logout, refreshed-cookie forwarding and independent browser contexts through
Next's production proxy. Provider UI email delivery and actual cross-provider linking need a live staging test.

References: [WorkOS Node SDK](https://workos.com/docs/sdks/node),
[identity linking](https://workos.com/docs/authkit/identity-linking),
[environments](https://workos.com/docs/authkit/environments),
[authorization URL](https://workos.com/docs/reference/authkit/authentication/get-authorization-url),
[logout](https://workos.com/docs/reference/authkit/logout).
