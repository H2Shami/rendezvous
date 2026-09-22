import { Router, type Request, type Response } from 'express';
import type { OwnerService } from './service.js';
import { LOGIN_MS } from './service.js';
import type { IdentityProvider, LoginScreen } from './provider.js';
import type { AgentIdentityService } from '../agents/identity.js';
import { ownerAgentRoutes } from '../agents/routes.js';
import { HttpError, requireThat } from '../validation.js';

export function ownerRoutes(service: OwnerService, provider: IdentityProvider | undefined, origin: string, agents?: AgentIdentityService) {
  const router = Router();
  const secure = new URL(origin).protocol === 'https:';
  const sessionName = secure ? '__Host-rv-owner' : 'rv-owner';
  const loginName = secure ? '__Host-rv-login' : 'rv-login';
  const options = { httpOnly: true, secure, sameSite: 'lax' as const, path: '/' };
  // Cookie retention only; WorkOS controls session validity and refresh lifetime.
  const sessionOptions = { ...options, maxAge: 14 * 24 * 60 * 60 * 1000 };
  // Reject duplicate cookies instead of guessing which one a proxy/browser meant.
  const cookie = (req: Request, name: string) => {
    const values = (req.headers.cookie || '').split(';').map(v => v.trim()).filter(v => v.startsWith(`${name}=`));
    return values.length === 1 ? values[0].slice(name.length + 1) : '';
  };
  const sameOrigin = (req: Request) => requireThat(req.headers.origin === origin,
    'CSRF_INVALID', 'Request must originate from this application.', 403);
  const authenticated = async (req: Request, res: Response) => {
    // Never interpret bearer tokens, caller-supplied owner IDs or room cookies as login.
    const token = cookie(req, sessionName);
    requireThat(provider && token, 'OWNER_UNAUTHORIZED', 'Sign in to continue.', 401);
    const identity = await provider.authenticate(token);
    const owner = await service.authenticate(identity.issuer, identity.subject);
    if (identity.sealedSession) res.cookie(sessionName, identity.sealedSession, sessionOptions);
    return { identity, owner };
  };
  router.get('/config', (_req, res) => res.json({ enabled: Boolean(provider) }));
  router.get('/login', async (req, res) => {
    requireThat(provider, 'AUTH_NOT_CONFIGURED', 'Account sign-in is unavailable.', 503);
    requireThat(!req.headers.origin || req.headers.origin === origin, 'CSRF_INVALID', 'Invalid sign-in origin.', 403);
    const screen = req.query.screen ?? 'sign-in';
    requireThat(screen === 'sign-in' || screen === 'sign-up', 'INVALID_REQUEST', 'Invalid sign-in screen.');
    const attempt = await service.beginLogin();
    let destination: string;
    try { destination = await provider.authorize(attempt, screen as LoginScreen); }
    catch { throw new HttpError('AUTH_UNAVAILABLE', 'Sign-in is temporarily unavailable. Please try again.', 503); }
    res.cookie(loginName, attempt.browser, { ...options, maxAge: LOGIN_MS });
    res.redirect(303, destination);
  });
  router.get('/callback', async (req, res) => {
    requireThat(provider, 'AUTH_NOT_CONFIGURED', 'Account sign-in is unavailable.', 503);
    const browser = cookie(req, loginName);
    res.clearCookie(loginName, options);
    try {
      const callback = new URL(`${origin}/api/v1/owner/callback`);
      callback.search = new URL(req.originalUrl, origin).search;
      requireThat(callback.searchParams.getAll('state').length === 1, 'LOGIN_INVALID', 'Invalid callback.', 400);
      const state = callback.searchParams.get('state')!;
      const checks = await service.consumeLogin(state, browser);
      const identity = await provider.exchange(callback, { state, ...checks });
      await service.establish(identity.issuer, identity.subject);
      res.cookie(sessionName, identity.sealedSession, sessionOptions);
      res.redirect(303, `${origin}/account`);
    } catch {
      // SDK errors can contain codes, tokens and user data. Never reflect or log them.
      res.redirect(303, `${origin}/account?error=sign_in_failed`);
    }
  });
  router.get('/me', async (req, res) => {
    const { identity, owner } = await authenticated(req, res);
    res.json({ owner: { id: owner.id }, expires_at: identity.expiresAt, csrf_token: service.csrf(identity.sessionId) });
  });
  router.post('/logout', async (req, res) => {
    sameOrigin(req);
    const { identity } = await authenticated(req, res);
    service.checkCsrf(identity.sessionId, req.get('X-CSRF-Token') || '');
    const logoutUrl = await provider!.logout(identity.sessionId);
    res.clearCookie(sessionName, options);
    res.clearCookie(loginName, options);
    res.json({ logout_url: logoutUrl });
  });
  if (agents) router.use('/agents', async (req, res, next) => {
    const { identity, owner } = await authenticated(req, res);
    if (!['GET', 'HEAD'].includes(req.method)) {
      sameOrigin(req);
      service.checkCsrf(identity.sessionId, req.get('X-CSRF-Token') || '');
    }
    res.locals.ownerId = owner.id;
    next();
  }, ownerAgentRoutes(agents));
  // Foundation for future management routes: always authenticate before serving data,
  // constrain SQL by owner.id, and require same-origin + CSRF for every write.
  return router;
}
