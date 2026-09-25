/** One pending local instruction. Never fulfilled by a remote room message. */
export class LocalInput {
  private queued?: string;
  private waiter?: (value: string) => void;
  send(value: string) {
    if (this.waiter) { const resolve = this.waiter; this.waiter = undefined; resolve(value); }
    else { if (this.queued !== undefined) throw new Error('A local instruction is already queued.'); this.queued = value; }
  }
  next(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (this.queued !== undefined) { const value = this.queued; this.queued = undefined; return Promise.resolve(value); }
    return new Promise((resolve, reject) => {
      const abort = () => { this.waiter = undefined; reject(signal.reason); };
      this.waiter = value => { signal.removeEventListener('abort', abort); resolve(value); };
      signal.addEventListener('abort', abort, { once: true });
    });
  }
}
