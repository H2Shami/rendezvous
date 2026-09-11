import express from 'express';
import { createServer } from 'node:http';
import { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { requestLogging, safeOrigin, safePath } from '../src/logging.js';

// Development/test equivalent of Caddyfile. No message logic or buffering here.
export function createGateway(apiTarget: string, frontendTarget: string, logger: (entry: Record<string, unknown>) => void = entry => console.log(JSON.stringify(entry))) {
  const app = express(); app.disable('x-powered-by');
  const backendPath = (path: string) => /^\/(api(?:\/|$)|join(?:\/|$)|protocol(?:\/|$)|\.well-known(?:\/|$)|health$|style\.css$)/.test(path);
  const emit = (event: string, fields: Record<string, unknown>) => logger({ timestamp: new Date().toISOString(), component: 'proxy', event, ...fields });
  app.use((req, res, next) => requestLogging((event, fields) => emit(event, { ...fields,
    upstream: backendPath(req.path) ? 'server' : 'web',
  }))(req, res, next));
  app.use((req, res, next) => { req.headers['x-request-id'] = res.locals.request_id; next(); });
  const upstreamEvents = (upstream: string, target: string) => ({
    error: (error: Error, req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse | import('node:net').Socket) => {
      emit('proxy.error', { request_id: req.headers['x-request-id'], path: safePath(req.url || ''), upstream, target: safeOrigin(target),
        error_code: error.message === 'Upstream server did not upgrade the connection' ? 'UPGRADE_REJECTED' : ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'].includes((error as NodeJS.ErrnoException).code || '') ? (error as NodeJS.ErrnoException).code : 'UPSTREAM_ERROR',
        ...(error.message === 'Upstream server did not upgrade the connection' ? { hint: 'Check Next.js allowedDevOrigins and run dev:web for hot reload.' } : {}) });
      if ('writeHead' in res && !res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json', 'X-Request-ID': String(req.headers['x-request-id']) });
        res.end(JSON.stringify({ error: { code: 'UPSTREAM_UNAVAILABLE', message: `${upstream} upstream unavailable. Check the backend launcher and frontend process.` }, request_id: req.headers['x-request-id'] }));
      }
    },
  });
  app.use(createProxyMiddleware({
    target: apiTarget, pathFilter: backendPath,
    proxyTimeout: 75000, timeout: 80000,
    on: upstreamEvents('server', apiTarget),
    // Do not replace Origin: Express must validate the actual browser origin.
  }));
  const frontend = createProxyMiddleware({ target: frontendTarget, pathFilter: path => !backendPath(path), on: upstreamEvents('web', frontendTarget) });
  app.use(frontend);
  const server = createServer(app);
  // Next's development HMR only; agent communication remains plain HTTP.
  server.on('upgrade', (req, socket, head) => {
    // Upgrade requests bypass Express request middleware.
    req.headers['x-request-id'] = randomUUID();
    if (req.url?.startsWith('/_next/') && socket instanceof Socket) frontend.upgrade(req, socket, head);
    else socket.destroy();
  });
  return server;
}
