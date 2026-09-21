import { createHash } from 'node:crypto';
import { WorkOS, type User } from '@workos-inc/node';
import { decodeJwt } from 'jose';
import { HttpError, requireThat } from '../validation.js';

export interface LoginChecks { state: string; verifier: string }
export type LoginScreen = 'sign-in' | 'sign-up';
export interface OwnerIdentity {
  issuer: string; subject: string; sessionId: string; expiresAt: Date; sealedSession?: string;
}
export interface IdentityProvider {
  authorize(checks: LoginChecks, screen?: LoginScreen): Promise<string>;
  exchange(callback: URL, checks: LoginChecks): Promise<OwnerIdentity & { sealedSession: string }>;
  authenticate(cookie: string): Promise<OwnerIdentity>;
  logout(sessionId: string): Promise<string>;
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

/** WorkOS owns the browser session; its SDK seals, validates and refreshes tokens. */
export class WorkOSProvider implements IdentityProvider {
  private workos: WorkOS;
  constructor(private settings: OwnerAuthConfig, private cookiePassword: string, workos?: WorkOS) {
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
      session: { sealSession: true, cookiePassword: this.cookiePassword },
    });
    requireThat(result.sealedSession, 'LOGIN_INVALID', 'Invalid sign-in session.');
    return { ...this.identity(result.user, result.accessToken), sealedSession: result.sealedSession };
  }
  private identity(user: User, accessToken: string): OwnerIdentity {
    // Only SDK-verified tokens or authenticated code/refresh responses reach here.
    const { sid, sub, exp } = decodeJwt(accessToken);
    requireThat(user.emailVerified && /^user_[A-Za-z0-9]+$/.test(user.id) && sub === user.id &&
      typeof sid === 'string' && /^session_[A-Za-z0-9]+$/.test(sid) && typeof exp === 'number',
      'OWNER_UNAUTHORIZED', 'Sign in to continue.', 401);
    return {
      // Internal identity namespace, not a JWT issuer: separates WorkOS environments.
      issuer: `https://api.workos.com/client/${this.settings.clientId}`,
      subject: user.id, sessionId: sid, expiresAt: new Date(exp * 1000),
    };
  }
  async authenticate(cookie: string): Promise<OwnerIdentity> {
    try {
      const session = this.workos.userManagement.loadSealedSession({ sessionData: cookie, cookiePassword: this.cookiePassword });
      const result = await session.authenticate();
      if (result.authenticated) return this.identity(result.user, result.accessToken);
      requireThat(result.reason === 'invalid_jwt', 'OWNER_UNAUTHORIZED', 'Sign in to continue.', 401);
      const refreshed = await session.refresh();
      if (!refreshed.authenticated && refreshed.retryable)
        throw new HttpError('AUTH_UNAVAILABLE', 'Sign-in is temporarily unavailable. Please try again.', 503);
      requireThat(refreshed.authenticated && refreshed.session && refreshed.sealedSession,
        'OWNER_UNAUTHORIZED', 'Sign in to continue.', 401);
      return { ...this.identity(refreshed.session.user, refreshed.session.accessToken), sealedSession: refreshed.sealedSession };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      // Never expose provider errors, tokens or decrypted cookie contents.
      throw new HttpError('AUTH_UNAVAILABLE', 'Sign-in is temporarily unavailable. Please try again.', 503);
    }
  }
  async logout(sessionId: string) {
    try { await this.workos.userManagement.revokeSession({ sessionId }); }
    catch { throw new HttpError('AUTH_UNAVAILABLE', 'Unable to sign out. Please try again.', 503); }
    return this.workos.userManagement.getLogoutUrl({ sessionId, returnTo: `${this.settings.publicOrigin}/account` });
  }
}
