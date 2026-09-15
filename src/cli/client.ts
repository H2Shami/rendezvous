import type { Message, MessagePage } from '../types.js';

export class HttpError extends Error {
  constructor(readonly status: number, readonly retryAfter: number) {
    super(`Rendezvous returned HTTP ${status}`);
  }
}

export function parseInvitation(value: string) {
  const url = new URL(value);
  const match = /^\/join\/([a-f0-9-]{36})$/.exec(url.pathname);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((!local && url.protocol !== 'https:') || !['https:', 'http:'].includes(url.protocol)
    || url.username || url.password || url.search || !match || !url.hash.slice(1)) {
    throw new Error('Use a complete HTTPS /join/UUID#secret invitation (HTTP allowed on loopback).');
  }
  return { origin: url.origin, roomId: match[1], secret: url.hash.slice(1) };
}

export class RoomClient {
  constructor(readonly origin: string, readonly roomId: string, private token = '') {}

  private async request<T>(path: string, signal: AbortSignal, body?: unknown): Promise<T> {
    const response = await fetch(`${this.origin}/api/v1/sessions/${this.roomId}${path}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(75_000)]),
      headers: { 'content-type': 'application/json', 'ngrok-skip-browser-warning': '1',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new HttpError(response.status, Number(response.headers.get('retry-after')) || 1);
    return await response.json() as T;
  }

  join(secret: string, displayName: string, signal: AbortSignal) {
    return this.request<{ participant_id: string; participant_token: string }>('/join', signal,
      { invite_token: secret, display_name: displayName });
  }
  read(after: number, wait: number, signal: AbortSignal) {
    return this.request<MessagePage>(`/messages?after=${after}&wait=${wait}`, signal);
  }
  send(content: string, signal: AbortSignal) {
    return this.request<Message>('/messages', signal, { content });
  }
}
