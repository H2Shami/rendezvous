import { Router, type Request } from 'express';
import type { OwnerService } from './service.js';
import { LOGIN_MS, OWNER_SESSION_MS } from './service.js';
import type { IdentityProvider } from './provider.js';
import type { EmailAuth } from './email.js';
import { HttpError, requireThat, exactFields } from '../validation.js';

export function ownerRoutes(service: OwnerService, provider: IdentityProvider | undefined, origin: string, extra: { email?: EmailAuth; github?: IdentityProvider; google?: boolean; limit?: (key: string, count: number, ms: number) => void; digest?: (value: string) => string } = {}) {
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
  const sameOrigin = (req: Request) => requireThat(req.headers.origin === origin,
    'CSRF_INVALID', 'Request must originate from this application.', 403);
  const authenticated = async (req: Request) => {
    // Never interpret bearer tokens, caller-supplied owner IDs or room cookies as login.
    const token = cookie(req, sessionName);
    return { token, owner: await service.authenticate(token) };
  };
  router.get('/config', (_req, res) => res.json({ enabled: Boolean(provider || extra.github || extra.email),
    email: Boolean(extra.email), google: Boolean(provider && extra.google), github: Boolean(extra.github) }));
  for (const flow of ['cognito', 'github']) {
    const prefix = flow === 'github' ? '/github' : '';
    const identityProvider = flow === 'github' ? extra.github : provider;
    router.get(`${prefix}/login`, async (req, res) => {
      requireThat(identityProvider, 'AUTH_NOT_CONFIGURED', 'This sign-in method is unavailable.', 503);
      requireThat(!req.headers.origin || req.headers.origin === origin, 'CSRF_INVALID', 'Invalid sign-in origin.', 403);
      const selected = req.query.provider;
      requireThat(selected === undefined || (flow === 'cognito' && selected === 'google' && extra.google),
        'INVALID_PROVIDER', 'This sign-in method is unavailable.');
      const attempt = await service.beginLogin(flow);
      let destination: string;
      try { destination = await identityProvider.authorize(attempt, selected as string | undefined); }
      catch { throw new HttpError('AUTH_UNAVAILABLE', 'Sign-in is temporarily unavailable. Please try again.', 503); }
      res.cookie(loginName, attempt.browser, { ...options, maxAge: LOGIN_MS });
      res.redirect(303, destination);
    });
    router.get(`${prefix}/callback`, async (req, res) => {
      requireThat(identityProvider, 'AUTH_NOT_CONFIGURED', 'This sign-in method is unavailable.', 503);
      const browser = cookie(req, loginName);
      res.clearCookie(loginName, options);
      try {
        const callback = new URL(`${origin}/api/v1/owner${prefix}/callback`);
        // Only configured origin and route may determine the OAuth redirect URI.
        callback.search = new URL(req.originalUrl, origin).search;
        requireThat(callback.searchParams.getAll('state').length === 1, 'LOGIN_INVALID', 'Invalid callback.', 400);
        const state = callback.searchParams.get('state')!;
        const checks = await service.consumeLogin(state, browser, flow);
        const identity = await identityProvider.exchange(callback, { state, ...checks });
        const session = await service.establish(identity.issuer, identity.subject, cookie(req, sessionName));
        res.cookie(sessionName, session.token, { ...options, maxAge: OWNER_SESSION_MS });
        res.redirect(303, `${origin}/account`);
      } catch {
        res.redirect(303, `${origin}/account?error=sign_in_failed`);
      }
    });
  }
  for (const action of ['login', 'signup', 'confirm', 'resend', 'forgot', 'reset'] as const) {
    router.post(`/email/${action}`, async (req, res) => {
      sameOrigin(req);
      requireThat(extra.email, 'AUTH_NOT_CONFIGURED', 'Email sign-in is unavailable.', 503);
      requireThat(req.is('application/json'), 'INVALID_REQUEST', 'Expected JSON.');
      exactFields(req.body, ['email', 'password', 'code']);
      const { email, password, code } = req.body;
      requireThat(typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
        'INVALID_REQUEST', 'Enter a valid email address.');
      if (['login', 'signup', 'reset'].includes(action)) requireThat(typeof password === 'string' && password.length > 0 && password.length <= 256,
        'INVALID_REQUEST', 'Enter a password of at most 256 characters.');
      if (['confirm', 'reset'].includes(action)) requireThat(typeof code === 'string' && /^\d{6}$/.test(code),
        'INVALID_REQUEST', 'Enter the six-digit code from your email.');
      const address = email.trim().toLowerCase();
      // Existing process-local limiter: normalize + HMAC so no email is retained in keys.
      const key = extra.digest?.(`owner-email:${address}`);
      if (key) {
        extra.limit?.(`owner-email:${key}`, 30, 3600000);
        if (['signup', 'resend', 'forgot'].includes(action)) extra.limit?.(`owner-delivery:${key}`, 5, 3600000);
      }
      if (action === 'login') {
        const identity = await extra.email.login(address, password as string);
        const session = await service.establish(identity.issuer, identity.subject, cookie(req, sessionName));
        res.cookie(sessionName, session.token, { ...options, maxAge: OWNER_SESSION_MS });
      } else if (action === 'signup') await extra.email.signup(address, password as string);
      else if (action === 'confirm') await extra.email.confirm(address, code as string);
      else if (action === 'resend') await extra.email.resend(address);
      else if (action === 'forgot') await extra.email.forgot(address);
      else await extra.email.reset(address, code as string, password as string);
      res.json({ ok: true });
    });
  }
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
