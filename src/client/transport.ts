import { AgentClientError, cancelled, delay } from './errors.js';
import { error as errorResponse } from './validation.js';
export interface TransportOptions {
  fetch?: typeof fetch;
  maxAttempts?: number;
  retryBaseMs?: number;
  requestTimeoutMs?: number;
}
const retryStatuses = new Set([429, 500, 502, 503, 504]);
/** Transport retries keep the exact serialized body and credential for an operation. */
export class Transport {
  readonly origin: string;
  private fetcher: typeof fetch;
  private attempts: number;
  constructor(serverUrl: string, private options: TransportOptions = {}) {
    const url = new URL(serverUrl);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))))
      throw new AgentClientError('INVALID_CONFIG', 'serverUrl must be an HTTPS origin or a loopback HTTP origin.');
    this.origin = url.origin; this.fetcher = options.fetch ?? fetch; this.attempts = options.maxAttempts ?? 3;
    if (!Number.isInteger(this.attempts) || this.attempts < 1 || this.attempts > 10 || !Number.isFinite(options.retryBaseMs ?? 100) || (options.retryBaseMs ?? 100) < 0 || !Number.isInteger(options.requestTimeoutMs ?? 25000) || (options.requestTimeoutMs ?? 25000) <= 0 || (options.requestTimeoutMs ?? 25000) > 2147483647)
      throw new AgentClientError('INVALID_CONFIG', 'Invalid retry or timeout configuration.');
  }
  async request<T>(key: string, path: string, validate: (value: unknown) => T, options: { body?: unknown; signal?: AbortSignal; timeoutMs?: number; firstAttemptAt?: number } = {}): Promise<T> {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body), started = options.firstAttemptAt ?? Date.now();
    for (let attempt = 0; ; attempt++) {
      cancelled(options.signal);
      if (Date.now() - started >= 86400000) throw new AgentClientError('RETRY_EXPIRED', 'Operation is too old to retry automatically.');
      const timeout = AbortSignal.timeout(options.timeoutMs ?? this.options.requestTimeoutMs ?? 25000);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      let retryAfter: number | undefined;
      try {
        const response = await this.fetcher(`${this.origin}/api/v1${path}`, {
          method: body === undefined ? 'GET' : 'POST', redirect: 'error', cache: 'no-store', signal,
          headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body }),
        });
        cancelled(options.signal);
        const raw = await response.json().catch(() => { throw new AgentClientError('INVALID_RESPONSE', 'Server returned unreadable JSON.'); });
        if (response.ok) return validate(raw);
        const parsed = errorResponse(raw), header = response.headers.get('Retry-After');
        retryAfter = header === null ? parsed.error.retry_after_seconds : /^\d+$/.test(header) ? Number(header) : Math.max(0, Math.ceil((Date.parse(header) - Date.now()) / 1000));
        if (!Number.isFinite(retryAfter)) retryAfter = undefined;
        const failure = new AgentClientError(parsed.error.code, `Rendezvous request failed: ${parsed.error.code}.`, response.status, retryAfter, parsed.request_id);
        if (!retryStatuses.has(response.status) || attempt + 1 >= this.attempts) throw failure;
      } catch (e) {
        cancelled(options.signal);
        if (e instanceof AgentClientError) throw e;
        if (attempt + 1 >= this.attempts) throw new AgentClientError('NETWORK_ERROR', 'Request could not be confirmed. Retry the same operation.');
      }
      const backoff = Math.min(5000, (this.options.retryBaseMs ?? 100) * 2 ** attempt) * (0.5 + Math.random() * 0.5);
      const wait = Math.max(backoff, (retryAfter ?? 0) * 1000);
      if (Date.now() + wait - started >= 86400000) throw new AgentClientError('RETRY_EXPIRED', 'Retry delay would exceed the safe operation window.');
      await delay(wait, options.signal);
    }
  }
}
