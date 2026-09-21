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
configure SES delivery and confirm quotas before relying on recovery mail. This
PR does not deploy cloud resources or validate real mailbox delivery. Before
launch, test signup, email confirmation, password reset, login and logout against
the deployed stack and confirm that user-pool/account recovery settings work.

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
