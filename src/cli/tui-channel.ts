import { randomUUID } from 'node:crypto';
import type { AgentControls } from './agent-controls.js';
import type { ExecutionEvent } from './agent-events.js';

/** Private parent/child IPC: CLI handlers stay authoritative in graphical mode. */
export const tuiChild = process.env.RENDEZVOUS_TUI_CHILD === '1' && typeof process.send === 'function';
export function sendTui(message: unknown): Promise<void> {
  return new Promise(resolve => {
    if (!tuiChild || !process.connected) return resolve();
    process.send!(message as object, () => resolve());
  });
}
export const tuiEvent = (event: Readonly<ExecutionEvent>) => sendTui({ type: 'event', event });

export async function askTui(label: string, hint: string, signal: AbortSignal, options: { secret?: boolean; defaultValue?: string }) {
  signal.throwIfAborted();
  const id = randomUUID();
  process.channel?.ref();
  return new Promise<string>((resolve, reject) => {
    const cleanup = () => { process.removeListener('message', receive); process.removeListener('disconnect', cancel); signal.removeEventListener('abort', cancel); process.channel?.unref(); void sendTui({ type: 'prompt_done', id }); };
    const cancel = () => { cleanup(); reject(signal.reason ?? new Error('Terminal disconnected.')); };
    const receive = (message: any) => {
      if (message?.type !== 'answer' || message.id !== id || typeof message.value !== 'string') return;
      const answer = message.value.trim() || options.defaultValue || '';
      if (!answer) return;
      cleanup(); resolve(answer);
    };
    process.on('message', receive); process.once('disconnect', cancel); signal.addEventListener('abort', cancel, { once: true });
    void sendTui({ type: 'prompt', id, label, hint, secret: !!options.secret, defaultValue: options.defaultValue });
  });
}

export function attachTuiControls(controls?: AgentControls) {
  if (!tuiChild) return;
  if (controlHandler) process.removeListener('message', controlHandler);
  controlHandler = undefined;
  void sendTui({ type: 'controls', available: !!controls });
  if (!controls) return;
  controlHandler = (message: any) => {
    if (message?.type !== 'control' || typeof message.id !== 'string') return;
    if (message.action === 'peers' && controls.peers) {
      void controls.peers(message.after).then(result => sendTui({ type: 'peers_result', id: message.id, ...result }),
        error => sendTui({ type: 'peers_result', id: message.id, error: error instanceof Error ? error.message : 'Could not load friends.', code: (error as { code?: string })?.code }));
      return;
    }
    const action = message.action === 'steer' && typeof message.sessionId === 'string' && typeof message.message === 'string' && controls.steer
      ? () => controls.steer!(message.sessionId, message.message)
      : message.action === 'chat' && typeof message.message === 'string' && controls.chat
      ? () => controls.chat!(message.message)
      : message.action === 'open' && typeof message.peer === 'string' && typeof message.message === 'string'
      ? () => controls.open(message.peer, message.message)
      : message.action === 'close' && typeof message.sessionId === 'string' ? () => controls.close(message.sessionId) : undefined;
    if (action) void action().then(() => sendTui({ type: 'control_result', id: message.id, action: message.action, ok: true }),
      error => sendTui({ type: 'control_result', id: message.id, ok: false, error: error instanceof Error ? error.message : 'Command failed.' }));
  };
  process.on('message', controlHandler); process.channel?.unref();
}
let controlHandler: ((message: any) => void) | undefined;
