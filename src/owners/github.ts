import * as oauth from 'openid-client';
import type { IdentityProvider, LoginChecks } from './provider.js';

/** GitHub is OAuth, not OIDC. Stable numeric /user ID is the subject; never email. */
export class GitHubProvider implements IdentityProvider {
  private config: oauth.Configuration;
  constructor(clientId: string, clientSecret: string, private origin: string, private request: typeof fetch = fetch) {
    this.config = new oauth.Configuration({
      issuer: 'https://github.com',
      authorization_endpoint: 'https://github.com/login/oauth/authorize',
      token_endpoint: 'https://github.com/login/oauth/access_token',
    }, clientId, clientSecret, oauth.ClientSecretPost(clientSecret));
    this.config.timeout = 10;
    this.config[oauth.customFetch] = (url, options) => request(url, { ...options,
      body: options.body instanceof Uint8Array ? new Uint8Array(options.body) : options.body,
    });
  }
  async authorize(checks: LoginChecks) {
    return oauth.buildAuthorizationUrl(this.config, {
      redirect_uri: `${this.origin}/api/v1/owner/github/callback`,
      response_type: 'code', scope: 'read:user', state: checks.state,
      code_challenge_method: 'S256', code_challenge: await oauth.calculatePKCECodeChallenge(checks.verifier),
    }).href;
  }
  async exchange(callback: URL, checks: LoginChecks) {
    const tokens = await oauth.authorizationCodeGrant(this.config, callback, {
      expectedState: checks.state, pkceCodeVerifier: checks.verifier,
    });
    const response = await this.request('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Rendezvous' },
      signal: AbortSignal.timeout(10_000), redirect: 'error',
    });
    if (!response.ok) throw new Error('GitHub identity unavailable');
    const user = await response.json();
    if (!Number.isSafeInteger(user.id) || user.id <= 0) throw new Error('Invalid GitHub identity');
    return { issuer: 'https://github.com', subject: String(user.id) };
  }
  logoutUrl() { return `${this.origin}/account`; }
}
