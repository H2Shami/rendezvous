# Owner account authentication (REN-6)

WorkOS AuthKit handles email/password, Google, GitHub, verification, recovery and
identity linking. Rendezvous maps the resulting stable WorkOS user ID to a local
owner UUID and issues a revocable app session. One owner can later own many
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

Migration 008 adds a non-credential provider session ID for WorkOS logout, changes
login attempts to the WorkOS flow, and revokes legacy Cognito/direct-GitHub app
sessions. Existing owner rows and their IDs/data are preserved. A WorkOS sign-in
creates a new owner rather than silently attaching to an old test account.
Existing test users must register/sign in through WorkOS; Cognito passwords and
sessions are not imported. Before migrating accounts that own real agents/data,
implement an explicit verified ownership transfer or controlled migration.

The previous shared dev Cognito pool `us-east-2_5EYdg33zR` was provisioned manually,
not by Pulumi. This change leaves that cloud resource intact. Old OWNER_OIDC_*,
OWNER_GOOGLE_ENABLED and direct GITHUB_CLIENT_* environment values are ignored.
They can be removed after verifying the migration; retire unused cloud resources
and credentials separately. Previously applied SQL migrations remain in the chain.

## Session and authorization model

The official WorkOS Node SDK builds hosted authorization requests with state and
S256 PKCE. A ten-minute, single-use DB attempt binds that state to an independent
HttpOnly browser cookie. State and cookie values are hashed with separate HMAC
domains; the PKCE verifier is derived from the browser secret. Callbacks use the
configured PUBLIC_URL, never caller-controlled Host headers. The backend consumes
the attempt atomically and exchanges the code directly with WorkOS using the
backend API key and verifier. No automatic retries of the code exchange.

The verified user from this authenticated server-to-server response is the
identity. The returned token is decoded only for its WorkOS session ID used at
logout; no caller-supplied token is accepted. Access/refresh/provider tokens and
user email are not persisted. The provider session ID cannot authenticate a user.

A successful login rotates the previous browser session and issues a random opaque
cookie with an absolute seven-day expiry. Only a domain-separated digest is stored
in Postgres. Cookies are HttpOnly, SameSite=Lax, path `/`, without Domain, and use
Secure plus __Host names on HTTPS. HTTP is supported only for loopback development.
No auth tokens are kept in localStorage or sessionStorage. `/me` never returns the
provider session ID, cookies or provider credentials.

| Endpoint under `/api/v1/owner` | Behavior |
| --- | --- |
| GET /config | Whether WorkOS is configured; no credentials |
| GET /login | Start bound AuthKit sign-in; optional screen=sign-up |
| GET /callback | Consume attempt, exchange code, issue app cookie |
| GET /me | Return internal owner ID, expiry and CSRF token |
| POST /logout | Exact Origin + CSRF; revoke app session, clear cookies, return WorkOS logout URL |

Old `/email/*` and `/github/*` endpoints are retired. The Next proxy preserves each
Set-Cookie header. Login starts retain the existing 30/hour per-IP process-local
limit; WorkOS handles hosted credential and email-delivery protections. Rate
limits reset on process restart and are not shared across replicas yet.

Future management routes must authenticate with OwnerService, scope every query
by the principal's owner ID, and enforce same-origin + CSRF for writes. Submitted
owner IDs, agent keys and room tokens never authenticate as account principals.
Agent CRUD is REN-7; the signed-in page remains an account confirmation for now.

## Logout and revocation boundaries

Logout immediately revokes the app session in Postgres, clears its cookies, and
redirects the browser to WorkOS logout with the saved session ID and configured
return URL. If the remote redirect fails, the app session is still revoked.
Browser logout does not revoke agent or room credentials.

Set `owners.disabled_at` or revoke local owner_sessions for immediate app-side
revocation. WorkOS logout/disable/password changes performed elsewhere do not yet
push revocation into our independent seven-day sessions. Webhook synchronization
or provider-managed session refresh is required before claiming that guarantee.
No sliding session expiry. Cleanup deletes expired attempts/sessions.

## Deployment

Per Pulumi stack, set enableOwnerAuth=true, workosClientId and secret workosApiKey.
Use the interactive `pulumi config set --secret workosApiKey` prompt so the secret
is absent from command history. AWS Secrets Manager stores the key and injects it
only into the backend task; the client ID is nonsecret backend configuration.
WorkOS, not Pulumi/Cognito, owns identity-provider settings. No database sharing is
introduced. Preview and deploy separately after registering the stack's URLs.
Production must use its own WorkOS environment and HTTPS callbacks.

The supplied WorkOS staging key has been validated and both local/hosted-dev
callback URLs registered. The local app reaches hosted AuthKit with email, Google
and GitHub available (staging uses WorkOS shared social credentials). Complete a
real staging sign-in and verify logout/branding settings before rollout. No hosted
application deployment is included in this change. Do not delete the old Cognito pool as part of this deployment.

## Verification

Tests exercise the real WorkOS SDK with a controlled HTTP transport: AuthKit URL,
PKCE, state, code exchange, verified-user checks, safe logout, and linked methods
mapping to one owner. Session tests cover expiry, revocation, CSRF, cross-owner
checks, durable restart, migration and retired endpoints. Browser tests verify
login/logout and independent cookies through Next's production proxy. Provider
UI email delivery and actual cross-provider linking need a live staging test.

References: [WorkOS Node SDK](https://workos.com/docs/sdks/node),
[identity linking](https://workos.com/docs/authkit/identity-linking),
[environments](https://workos.com/docs/authkit/environments),
[authorization URL](https://workos.com/docs/reference/authkit/authentication/get-authorization-url),
[logout](https://workos.com/docs/reference/authkit/logout).
