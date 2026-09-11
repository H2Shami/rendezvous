import express, { type ErrorRequestHandler } from 'express';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { HttpError, requireThat } from './validation.js';
import { parseJSON } from './json.js';
import { discovery, endpoints, htmlInstructions } from './instructions.js';
import type { Service } from './service.js';
import { requestLogging, safeOrigin } from './logging.js';

const root = new URL('../', import.meta.url);
export function createApplication(service: Service, config: { publicUrl?: string; trustProxy?: string | boolean } = {}) {
  const app = express(); app.disable('x-powered-by');
  let base = config.publicUrl || 'http://127.0.0.1:3000';
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);
  const token = (req: express.Request) => req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
  app.use(requestLogging((event, fields) => service.log(event, fields)));
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' });
    if (base.startsWith('https:')) res.set('Strict-Transport-Security', 'max-age=31536000');
    try {
      requireThat(!/[?&](token|invite_token|participant_token|credential|owner_token)=/i.test(req.url), 'QUERY_CREDENTIAL_FORBIDDEN', 'Put invite secrets in the URL fragment and tokens in Authorization headers.');
      if (req.headers.origin && req.headers.origin !== new URL(base).origin) {
        service.log('origin.rejected', { received_origin: safeOrigin(req.headers.origin), expected_origin: new URL(base).origin });
        throw new HttpError('ORIGIN_FORBIDDEN', 'Browser origin does not match PUBLIC_URL. Open the public routing URL or correct server configuration.', 403);
      }
      service.limit(`http:${req.ip}`, 600, 60000); next();
    } catch (error) { next(error); }
  });
  app.use(express.raw({ type: 'application/json', limit: 65536 }));
  app.use((req, _res, next) => {
    try { if (Buffer.isBuffer(req.body)) req.body = parseJSON(req.body); next(); } catch (error) { next(error); }
  });
  app.get('/health', async (_req, res) => { await service.db.query('SELECT 1'); res.json({ status: 'ok' }); });
  app.get('/.well-known/agent-rendezvous', (_req, res) => res.json({ protocol: 'rendezvous-http-v1', documentation: `${base}/protocol/v1`, create_endpoint: `${base}/api/v1/sessions` }));
  app.get('/protocol/v1', async (_req, res) => res.type('text/plain').send(await readFile(new URL('docs/protocol.md', root), 'utf8')));
  app.get('/join/:id', async (req, res) => {
    const s = await service.session(service.db, req.params.id, false, true);
    const d = discovery(base, s, service);
    service.log('instructions.opened', { session_id: s.id, format: req.accepts(['text', 'html', 'json']) });
    res.vary('Accept');
    if (req.accepts(['text', 'html', 'json']) === 'json') return void res.json(d);
    if (req.accepts(['text', 'html', 'json']) === 'html') return void res.type('html').send(htmlInstructions(d.instructions));
    res.type('text/plain').send(d.instructions);
  });
  app.use(express.static(new URL('public', root).pathname, { etag: false, maxAge: 0 }));
  const api = '/api/v1/sessions';
  app.post(api, async (req, res) => {
    const result = await service.create(req.body, req.ip || 'unknown');
    res.status(201).json({ ...result, invite_url: `${base}/join/${result.session_id}#${result.invite_token}`, owner_url: `${base}/#${result.session_id}.${result.owner_token}` });
  });
  app.get(`${api}/:id`, async (req, res) => res.json(await service.inspect(req.params.id, token(req))));
  app.post(`${api}/:id/join`, async (req, res) => res.status(201).json({ ...await service.join(req.params.id, req.body, req.ip || 'unknown'), endpoints: endpoints(base, req.params.id) }));
  app.post(`${api}/:id/messages`, async (req, res) => res.status(201).json(await service.send(req.params.id, token(req), req.body)));
  app.get(`${api}/:id/messages`, async (req, res, next) => {
    const controller = new AbortController();
    const disconnect = () => controller.abort();
    res.once('close', disconnect);
    try {
      requireThat(Object.keys(req.query).every(k => ['after', 'wait'].includes(k)), 'INVALID_REQUEST', 'Only after and wait query parameters are supported.');
      requireThat([req.query.after, req.query.wait].every(v => v === undefined || (typeof v === 'string' && /^\d+$/.test(v))), 'INVALID_REQUEST', 'after and wait must be integers.');
      const result = await service.messages(req.params.id, token(req), Number(req.query.after ?? 0), Number(req.query.wait ?? 60), controller.signal);
      if (!controller.signal.aborted) res.json(result);
    } catch (error) { if (!controller.signal.aborted) next(error); }
    finally { res.off('close', disconnect); }
  });
  app.post(`${api}/:id/leave`, async (req, res) => res.json(await service.leave(req.params.id, token(req))));
  // Existing owner controls remain for the creation/sharing UI.
  app.post(`${api}/:id/close`, async (req, res) => res.json(await service.close(req.params.id, token(req))));
  app.post(`${api}/:id/invites`, async (req, res) => {
    const result = await service.invite(req.params.id, token(req), req.body);
    res.status(201).json({ ...result, invite_url: `${base}/join/${req.params.id}#${result.invite_token}` });
  });
  app.delete(`${api}/:id/invites/:target`, async (req, res) => res.json(await service.revoke(req.params.id, token(req), req.params.target, 'invite')));
  app.delete(`${api}/:id/participants/:target`, async (req, res) => res.json(await service.revoke(req.params.id, token(req), req.params.target, 'participant')));
  app.use((_req, _res, next) => next(new HttpError('NOT_FOUND', 'Endpoint not found.', 404)));
  const errors: ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) return next(error);
    let err: HttpError;
    if (error.type === 'entity.too.large') err = new HttpError('REQUEST_TOO_LARGE', 'Request exceeds 64 KB.', 413);
    else if (error instanceof HttpError) err = error;
    else if (error instanceof SyntaxError) err = new HttpError('INVALID_JSON', 'Malformed JSON.');
    else {
      // Raw exception messages can contain SQL parameters or credentials.
      service.log('server.error', { error_type: error instanceof TypeError ? 'TypeError' : error instanceof Error ? 'Error' : 'Unknown',
        error_code: typeof error?.code === 'string' && /^(?:[0-9A-Z]{5}|E[A-Z_]{2,30})$/.test(error.code) ? error.code : undefined });
      err = new HttpError('INTERNAL_ERROR', 'Internal server error.', 500);
    }
    res.locals.error_code = err.code;
    service.log('request.rejected', { code: err.code });
    if (err.status === 429) res.set('Retry-After', '60');
    res.status(err.status).json({ error: { code: err.code, message: err.message }, request_id: res.locals.request_id });
  };
  app.use(errors);
  const server = createServer({ requestTimeout: 15000, headersTimeout: 10000 }, app);
  const cleanup = setInterval(() => void service.cleanup().catch(() => service.log('cleanup.failed')), 60000); cleanup.unref();
  return { app, server,
    listen: (port = 3000, host = '127.0.0.1') => new Promise<import('node:net').AddressInfo>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject); const address = server.address() as import('node:net').AddressInfo;
        if (!config.publicUrl) base = `http://127.0.0.1:${address.port}`;
        resolve(address);
      });
    }),
    close: async () => {
      clearInterval(cleanup); server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
