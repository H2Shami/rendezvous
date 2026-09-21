import * as oidc from 'openid-client';

export interface LoginChecks { state: string; verifier: string; nonce: string }
export interface IdentityProvider {
  authorize(checks: LoginChecks, provider?: string): Promise<string>;
  exchange(callback: URL, checks: LoginChecks): Promise<{ issuer: string; subject: string }>;
  logoutUrl(): string;
}
export interface OwnerAuthConfig { issuer: string; clientId: string; logoutEndpoint: string; publicOrigin: string }
export function ownerAuthConfig(env: NodeJS.ProcessEnv, publicOrigin: string): OwnerAuthConfig | undefined {
  const values = [env.OWNER_OIDC_ISSUER, env.OWNER_OIDC_CLIENT_ID, env.OWNER_OIDC_LOGOUT_URL];
  if (values.every(v => !v)) return undefined;
  if (values.some(v => !v)) throw new Error('Set all OWNER_OIDC_ISSUER, OWNER_OIDC_CLIENT_ID and OWNER_OIDC_LOGOUT_URL values.');
  for (const value of [values[0]!, values[2]!]) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      throw new Error('Owner identity provider URLs must be HTTPS without credentials, query, or fragment.');
  }
  const origin = new URL(publicOrigin);
  if (origin.origin !== publicOrigin || (origin.protocol !== 'https:' &&
      !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))))
    throw new Error('Owner public origin must be HTTPS (HTTP allowed on loopback).');
  return { issuer: values[0]!, clientId: values[1]!, logoutEndpoint: values[2]!, publicOrigin };
}

/** Cognito public app client: authorization code + S256 PKCE, no client secret.
 * Configuration is injected for deterministic local provider conformance tests. */
export class OidcProvider implements IdentityProvider {
  private configuration?: Promise<oidc.Configuration>;
  constructor(private settings: OwnerAuthConfig, private discover = () => oidc.discovery(
    new URL(settings.issuer), settings.clientId, undefined, oidc.None(), { timeout: 10 },
  )) {}
  private config() {
    return this.configuration ??= this.discover().then(config => {
      oidc.enableNonRepudiationChecks(config);
      return config;
    }).catch(error => { this.configuration = undefined; throw error; });
  }
  async authorize(checks: LoginChecks, provider?: string) {
    return oidc.buildAuthorizationUrl(await this.config(), {
      redirect_uri: `${this.settings.publicOrigin}/api/v1/owner/callback`,
      response_type: 'code', scope: 'openid email', state: checks.state,
      nonce: checks.nonce, code_challenge_method: 'S256',
      code_challenge: await oidc.calculatePKCECodeChallenge(checks.verifier),
      ...(provider === 'google' ? { identity_provider: 'Google' } : {}),
    }).href;
  }
  async exchange(callback: URL, checks: LoginChecks) {
    const tokens = await oidc.authorizationCodeGrant(await this.config(), callback, {
      expectedState: checks.state, expectedNonce: checks.nonce,
      pkceCodeVerifier: checks.verifier, idTokenExpected: true,
    });
    const claims = tokens.claims()!;
    return { issuer: claims.iss, subject: claims.sub };
  }
  logoutUrl() {
    const url = new URL(this.settings.logoutEndpoint);
    url.searchParams.set('client_id', this.settings.clientId);
    url.searchParams.set('logout_uri', `${this.settings.publicOrigin}/account`);
    return url.href;
  }
}
