import { createHash } from 'node:crypto';
import { WorkOS } from '@workos-inc/node';
import { decodeJwt } from 'jose';
import { requireThat } from '../validation.js';

export interface LoginChecks { state: string; verifier: string }
export type LoginScreen = 'sign-in' | 'sign-up';
export interface IdentityProvider {
  authorize(checks: LoginChecks, screen?: LoginScreen): Promise<string>;
  exchange(callback: URL, checks: LoginChecks): Promise<{ issuer: string; subject: string; sessionId?: string }>;
  logoutUrl(sessionId?: string | null): string;
}
export interface OwnerAuthConfig { apiKey: string; clientId: string; publicOrigin: string }
export function ownerAuthConfig(env: NodeJS.ProcessEnv, publicOrigin: string): OwnerAuthConfig | undefined {
  const values = [env.WORKOS_API_KEY, env.WORKOS_CLIENT_ID];
  if (values.every(v => !v)) return undefined;
  if (values.some(v => !v)) throw new Error('Set both WORKOS_API_KEY and WORKOS_CLIENT_ID.');
  if (!/^sk_[A-Za-z0-9_-]+$/.test(values[0]!) || !/^client_[A-Za-z0-9]+$/.test(values[1]!))
    throw new Error('Invalid WorkOS configuration. Use the API key and client ID from the same environment.');
  const origin = new URL(publicOrigin);
  if (origin.origin !== publicOrigin || (origin.protocol !== 'https:' &&
      !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))))
    throw new Error('Owner public origin must be HTTPS (HTTP allowed on loopback).');
  return { apiKey: values[0]!, clientId: values[1]!, publicOrigin };
}

/** All methods use hosted AuthKit; WorkOS links verified credentials to one user.
 * API tokens are used only during the server-to-server code exchange, never saved. */
export class WorkOSProvider implements IdentityProvider {
  private workos: WorkOS;
  constructor(private settings: OwnerAuthConfig, workos?: WorkOS) {
    this.workos = workos ?? new WorkOS(settings.apiKey, { clientId: settings.clientId, timeout: 10_000, maxRetries: 0 });
  }
  async authorize(checks: LoginChecks, screen: LoginScreen = 'sign-in') {
    return this.workos.userManagement.getAuthorizationUrl({
      clientId: this.settings.clientId, provider: 'authkit', screenHint: screen,
      redirectUri: `${this.settings.publicOrigin}/api/v1/owner/callback`,
      state: checks.state, codeChallengeMethod: 'S256',
      codeChallenge: createHash('sha256').update(checks.verifier).digest('base64url'),
    });
  }
  async exchange(callback: URL, checks: LoginChecks) {
    requireThat(callback.origin === this.settings.publicOrigin && callback.pathname === '/api/v1/owner/callback' &&
      !callback.searchParams.has('error') && callback.searchParams.getAll('state').length === 1 &&
      callback.searchParams.get('state') === checks.state && callback.searchParams.getAll('code').length === 1 &&
      Boolean(callback.searchParams.get('code')), 'LOGIN_INVALID', 'Invalid sign-in callback.');
    const result = await this.workos.userManagement.authenticateWithCode({
      clientId: this.settings.clientId, code: callback.searchParams.get('code')!, codeVerifier: checks.verifier,
    });
    requireThat(result.user.emailVerified === true && /^user_[A-Za-z0-9]+$/.test(result.user.id),
      'LOGIN_INVALID', 'A verified account is required.');
    // This token comes directly from WorkOS's authenticated HTTPS API, not the browser.
    // Authentication is the successful code exchange; decode only to retain its logout ID.
    const { sid } = decodeJwt(result.accessToken);
    requireThat(typeof sid === 'string' && /^session_[A-Za-z0-9]+$/.test(sid), 'LOGIN_INVALID', 'Invalid sign-in session.');
    return {
      // Internal identity namespace, not a JWT issuer: separates WorkOS environments.
      issuer: `https://api.workos.com/client/${this.settings.clientId}`,
      subject: result.user.id, sessionId: sid,
    };
  }
  logoutUrl(sessionId?: string | null) {
    return sessionId ? this.workos.userManagement.getLogoutUrl({ sessionId, returnTo: `${this.settings.publicOrigin}/account` })
      : `${this.settings.publicOrigin}/account`;
  }
}
