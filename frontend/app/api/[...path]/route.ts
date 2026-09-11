import { NextRequest } from 'next/server';

const expressOrigin = (process.env.EXPRESS_URL || 'http://127.0.0.1:4372').replace(/\/$/, '');

async function forward(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const target = `${expressOrigin}/api/${path.join('/')}${request.nextUrl.search}`;
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('content-length');
  headers.delete('connection');
  const init: RequestInit = { method: request.method, headers, signal: request.signal, redirect: 'manual' };
  if (!['GET', 'HEAD'].includes(request.method)) init.body = await request.arrayBuffer();
  const response = await fetch(target, init);
  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete('content-encoding');
  responseHeaders.delete('content-length');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
}

export const GET = forward;
export const POST = forward;
export const DELETE = forward;
export const PUT = forward;
export const PATCH = forward;
export const OPTIONS = forward;
