import { Router, type Request } from 'express';
import type { OwnerService } from './service.js';
import { LOGIN_MS, OWNER_SESSION_MS } from './service.js';
import type { IdentityProvider } from './provider.js';
import { HttpError, requireThat } from '../validation.js';

export function ownerRoutes(service: OwnerService, provider: IdentityProvider | undefined, origin: string) {
  const router = Router();
  const secure = new URL(origin).protocol === 'https:';
  const sessionName = secure ? '__Host-rv-owner' : 'rv-owner';
  const loginName = secure ? '__Host-rv-login' : 'rv-login';
  const options = { httpOnly: true, secure, sameSite: 'lax' as const, path: '/' };
  // Reject duplicate cookies instead of guessing which one a proxy/browser meant.
  const cookie = (req: Request, name: string) => {
    const values = (req.headers.cookie || '').split(';').map(v => v.trim()).filter(v => v.startsWith(`${name}=`));
    return values.length === 1 ? values[0].slice(name.length + 1) : '';
  };
  const enabled = () => requireThat(provider, 'AUTH_NOT_CONFIGURED', 'Account sign-in is not available yet.', 503);
  const sameOrigin = (req: Request) => requireThat(req.headers.origin === origin,
    'CSRF_INVALID', 'Request must originate from this application.', 403);
  const authenticated = async (req: Request) => {
    // Never interpret bearer tokens, caller-supplied owner IDs or room cookies as login.
    const token = cookie(req, sessionName);
    return { token, owner: await service.authenticate(token) };
  };
  router.get('/config', (_req, res) => res.json({ enabled: Boolean(provider) }));
  router.get('/login', async (req, res) => {
    enabled();
    requireThat(!req.headers.origin || req.headers.origin === origin, 'CSRF_INVALID', 'Invalid sign-in origin.', 403);
    const attempt = await service.beginLogin();
    let destination: string;
    try { destination = await provider!.authorize(attempt); }
    catch { throw new HttpError('AUTH_UNAVAILABLE', 'Sign-in is temporarily unavailable. Please try again.', 503); }
    res.cookie(loginName, attempt.browser, { ...options, maxAge: LOGIN_MS });
    res.redirect(303, destination);
  });
  router.get('/callback', async (req, res) => {
    enabled();
    const browser = cookie(req, loginName);
    res.clearCookie(loginName, options);
    try {
      const callback = new URL(`${origin}/api/v1/owner/callback`);
      // Reconstruct using the configured public origin, never Host/forwarded headers.
      callback.search = new URL(req.originalUrl, origin).search;
      requireThat(callback.searchParams.getAll('state').length === 1, 'LOGIN_INVALID', 'Invalid callback.', 400);
      const state = callback.searchParams.get('state')!;
      const checks = await service.consumeLogin(state, browser);
      const identity = await provider!.exchange(callback, { state, ...checks });
      const session = await service.establish(identity.issuer, identity.subject, cookie(req, sessionName));
      res.cookie(sessionName, session.token, { ...options, maxAge: OWNER_SESSION_MS });
      res.redirect(303, `${origin}/account`);
    } catch {
      // Provider errors can contain codes, tokens, and identity claims. Never log/reflect them.
      res.redirect(303, `${origin}/account?error=sign_in_failed`);
    }
  });
  router.get('/me', async (req, res) => {
    const { token, owner } = await authenticated(req);
    res.json({ owner: { id: owner.id }, expires_at: owner.expires_at, csrf_token: service.csrf(token) });
  });
  router.post('/logout', async (req, res) => {
    sameOrigin(req);
    const { token } = await authenticated(req);
    service.checkCsrf(token, req.get('X-CSRF-Token') || '');
    await service.revoke(token);
    res.clearCookie(sessionName, options);
    res.clearCookie(loginName, options);
    res.json({ logout_url: provider?.logoutUrl() || `${origin}/account` });
  });
  // Foundation for future management routes: always authenticate before serving data,
  // constrain SQL by owner.id, and require same-origin + CSRF for every write.
  return router;
}
