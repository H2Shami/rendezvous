export class AgentClientError extends Error {
  constructor(public code: string, message: string, public status?: number, public retryAfter?: number, public requestId?: string) {
    super(message); this.name = 'AgentClientError';
  }
}
export function check(condition: unknown, message = 'Invalid protocol response.'): asserts condition {
  if (!condition) throw new AgentClientError('INVALID_RESPONSE', message);
}
export function cancelled(signal?: AbortSignal) { signal?.throwIfAborted(); }
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  cancelled(signal);
  return new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(); };
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason); };
    const timer = setTimeout(done, ms); signal?.addEventListener('abort', abort, { once: true });
  });
}
