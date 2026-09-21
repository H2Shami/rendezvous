# Owner account authentication (REN-6)

Owners sign in through Amazon Cognito hosted UI. One account can later own many
agents; these accounts do not replace existing room tokens or agent runtime keys.

## Setup

Use Node 22 or newer. The relay requires all three environment values to enable
sign-in: `OWNER_OIDC_ISSUER`, `OWNER_OIDC_CLIENT_ID`, and
`OWNER_OIDC_LOGOUT_URL`. Partial configuration fails startup. Without configuration,
rooms remain available and `/account` explains that sign-in is not enabled.

Create a Cognito user pool with email sign-in, automatic email verification,
self-service registration and verified-email password recovery. Create a public
app client (no secret) with authorization code flow, `openid email` scopes and
Cognito as the identity provider. Register exactly:

- Callback: `PUBLIC_URL/api/v1/owner/callback`
- Sign-out: `PUBLIC_URL/account`

Use the pool's discovery issuer, the app client ID and its hosted domain `/logout`
URL in the environment. Provider URLs must use HTTPS. `PUBLIC_URL` must be an
HTTPS origin; loopback HTTP is allowed for local development. Register localhost
callback/sign-out URLs on a separate development client for local testing; the
Pulumi production client registers only its stack's HTTPS domain.

Visit `/account` to sign in/create an account. Cognito sends verification emails;
“Forgot your password?” on its sign-in page handles recovery. Stable issuer/sub
mapping preserves the internal owner ID through password recovery. The app does
not store passwords, emails, provider access tokens, ID tokens or refresh tokens.

## Deployment

Pulumi opt-in (preview and deploy through the normal deployment process):

```sh
pulumi config set enableOwnerAuth true --stack dev
pulumi preview --stack dev
```

The stack provisions a protected Cognito Lite pool, classic hosted UI (version 1),
a public code-flow app client and unique hosted domain. It injects only nonsecret
provider configuration into the backend. Outputs `ownerPoolId`, `ownerClientId`
and `ownerAuthEnvironment` assist setup. No additional browser secrets or Cognito
IAM permissions are needed by the app. Do not disable the flag on a populated
stack without planning removal of the protected pool.

Cognito's built-in email delivery has service limits. For a broader rollout,
configure SES delivery and confirm quotas before relying on recovery mail. The
application infrastructure has not been deployed by this PR; the shared dev
auth pool below was provisioned separately. Real mailbox delivery is not yet
validated. Before launch, test signup, email confirmation, password reset, login and logout against
the deployed stack and confirm that user-pool/account recovery settings work.

## Shared development auth, local app and database

The default local setup shares only Cognito. Frontend/backend run on the developer's
machine; PostgreSQL/PGlite data stays local. Copy `.env.example` to `.env` on a new
checkout (do not overwrite an existing configuration). It includes the public dev
pool/client identifiers; they are not credentials and need no AWS console login.

```sh
npm ci
npm --prefix frontend ci
# Terminal 1, Node 22+:
npm run dev:backend
# Terminal 2:
npm run dev:web
```

Open **http://localhost:3000/account**, then sign in or create a development account.
Use localhost, not 127.0.0.1, for the browser URL: Cognito callback matching is exact.
Leave `NGROK_DOMAIN` unset. The localhost client permits only
`http://localhost:3000/api/v1/owner/callback` and `http://localhost:3000/account`.
Omitting `DATABASE_URL` selects local PGlite; a localhost Docker PostgreSQL URL also
works. Do not configure shared RDS or a shared database pepper for this setup.

Accounts exist in shared dev Cognito, but each local database independently maps
issuer/subject to an internal owner ID. Development accounts must not contain real
customer data. Using the same Cognito login on another local database does not
transfer agent records or local history.

The existing pool is `us-east-2_5EYdg33zR` in AWS account `693067573106`, region
`us-east-2`. Its historical AWS name is `rendezvous-local-auth`; it is tagged
`Environment=dev`, `Usage=shared-development`. The public localhost client ID is
`nig2tofm7fv8phbf7m1ebq2lg`. This pool/client was provisioned directly for development
and is **not managed by the application Pulumi stack**. Do not enable that stack's
Cognito creation expecting it to adopt this pool. A deployed dev app can get a
separate HTTPS app client on this pool when needed; production stays separate.

Administrators should import the pool/client/domain into a dedicated IaC stack
before changing their lifecycle. Keep deletion protection enabled. Removing this
pool breaks sign-in for all developers using the shared configuration.

## App-owned sessions and authorization

The backend uses `openid-client` with authorization code, S256 PKCE, state, nonce,
and ID-token signature/issuer/audience/expiry validation. A ten-minute one-use
login attempt binds state to an independent HttpOnly browser cookie. Only hashes
are stored; PKCE and nonce are derived with separate HMAC domains. Callback URLs
use configured PUBLIC_URL, never untrusted Host/forwarded headers.

A successful callback maps `(issuer, subject)` to `owners.id`, rotates any previous
browser session and issues an opaque random cookie with an absolute seven-day
expiry. The server stores only its domain-separated digest. Cookies are HttpOnly,
SameSite=Lax, path `/`, without Domain, and use Secure plus `__Host-` names on HTTPS.
Local HTTP cookies use unprefixed names. No auth data is kept in localStorage.

Endpoints under `/api/v1/owner`:

| Endpoint | Behavior |
| --- | --- |
| GET /config | Whether sign-in is configured |
| GET /login | Start browser-bound sign-in and redirect to Cognito |
| GET /callback | Consume the one-use attempt, validate provider response, issue cookie |
| GET /me | Authenticate cookie; return internal owner ID, expiry and CSRF token |
| POST /logout | Require exact Origin and CSRF header, revoke app session and clear cookies; return Cognito logout URL |

The frontend follows the logout URL to clear Cognito's hosted UI session. The
app session is already revoked even if that redirect fails. Logout does not
revoke room/agent credentials. Authorization requests include prompt=login; reauthentication behavior depends
on the provider UI configuration. There is no return-to parameter or arbitrary post-login redirect.

Future management routes must use `OwnerService.authenticate`, constrain every
resource query by `owner_id = principal.id` (or `requireOwnership` after loading),
and require exact same-origin plus the `X-CSRF-Token` from `/me` for writes. Never
use a submitted owner ID or bearer token as a user principal. No agent management
endpoints are introduced until REN-7; owner scoping is tested at the service
boundary now. Room owner tokens cannot read `/me`.

Set `owners.disabled_at` to disable an app account immediately; all management
sessions check it. Session revocation is immediate in Postgres. Disabling an
account only in Cognito does not automatically revoke our already issued app
sessions: operations must also disable/revoke the internal owner. Password reset
also does not revoke existing app sessions automatically. Future agent
revocation hooks are REN-7/8 work. Cleanup removes expired attempts and expired or
revoked app sessions; no sliding expiry.

Proxy response forwarding preserves individual Set-Cookie headers and callback
redirects. Logs record safe route names and codes, never query strings, OAuth codes,
cookies, provider errors, or token contents. Login starts have an IP budget.

## Verification

`test/owner-auth.test.ts` exercises durable principals, browser binding, one-use
attempts, session rotation/expiry/revocation, owner isolation, CSRF and cookie rules.
`test/owner-oidc.test.ts` runs the actual OIDC client against signed local tokens,
including bad signatures, issuer/audience, expiry, nonce, state and PKCE failures.
Browser/proxy tests verify the Next.js path with a deterministic identity provider;
real Cognito/email smoke checks remain deployment validation.

References: [Cognito authorization endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html),
[Cognito logout](https://docs.aws.amazon.com/cognito/latest/developerguide/logout-endpoint.html),
[account recovery](https://docs.aws.amazon.com/cognito/latest/developerguide/managing-users-passwords.html),
[openid-client](https://github.com/panva/openid-client).
