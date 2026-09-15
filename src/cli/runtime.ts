import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TurnResult { message: string | null; status: 'ACTIVE' | 'DONE' | 'NEEDS_USER' }
export interface RuntimeAdapter {
  run(prompt: string, threadId: string | undefined, signal: AbortSignal,
    onThread: (id: string) => Promise<void>): Promise<TurnResult>;
}

const outputSchema = {
  type: 'object', additionalProperties: false, required: ['message', 'status'],
  properties: { message: { type: ['string', 'null'] }, status: { type: 'string', enum: ['ACTIVE', 'DONE', 'NEEDS_USER'] } },
};

export function parseTurnResult(value: string): TurnResult {
  const result = JSON.parse(value) as TurnResult;
  if (!result || !['ACTIVE', 'DONE', 'NEEDS_USER'].includes(result.status)
    || (result.message !== null && (typeof result.message !== 'string' || !result.message.trim()
      || Buffer.byteLength(result.message) > 32768))) throw new Error('Invalid runtime response.');
  return result;
}

export function codexArguments(schema: string, threadId?: string) {
  return ['exec', '--sandbox', 'read-only', '-c', 'approval_policy="never"',
    ...(threadId ? ['resume', threadId] : []), '--json', '--output-schema', schema, '-'];
}

// Credentials for the transport stay in the parent; never put prompts/secrets in argv.
function runtimeEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(RENDEZVOUS_|CODEX_THREAD_ID$|NODE_OPTIONS$)/.test(name)));
}

export class CodexRuntime implements RuntimeAdapter {
  constructor(private workspace: string, private timeoutMs = 300_000,
    private executable = 'codex') {}

  async run(prompt: string, threadId: string | undefined, signal: AbortSignal,
    onThread: (id: string) => Promise<void>): Promise<TurnResult> {
    signal.throwIfAborted();
    const directory = await mkdtemp(join(tmpdir(), 'rendezvous-codex-'));
    const schema = join(directory, 'response.json');
    try {
      await writeFile(schema, JSON.stringify(outputSchema), { mode: 0o600 });
      return await this.execute(schema, prompt, threadId, signal, onThread);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async execute(schema: string, prompt: string, threadId: string | undefined,
    signal: AbortSignal, onThread: (id: string) => Promise<void>): Promise<TurnResult> {
    const child = spawn(this.executable, codexArguments(schema, threadId), {
      cwd: this.workspace, env: runtimeEnvironment(), stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', shell: false,
    });
    let killed = false;
    let escalation: NodeJS.Timeout | undefined;
    const kill = (hard = false) => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(hard ? 'SIGKILL' : 'SIGTERM');
        else process.kill(-child.pid, hard ? 'SIGKILL' : 'SIGTERM');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    };
    const stop = () => {
      if (killed) return;
      killed = true; kill(); escalation = setTimeout(() => kill(true), 2000);
    };
    const timeout = setTimeout(stop, this.timeoutMs);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    // Drain diagnostics without echoing potentially private context or tool output.
    child.stderr.resume();
    child.stdin.on('error', () => {});
    const completion = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject); child.once('close', resolve);
    });
    // Attach a handler immediately, including spawn errors before stdout is consumed.
    void completion.catch(() => {});
    child.stdin.end(prompt);
    let finalText = '';
    let completed = false;
    let failed = false;
    let foundThread = threadId;
    try {
      for await (const line of createInterface({ input: child.stdout })) {
        if (line.length > 2_000_000) throw new Error('Runtime event too large.');
        const event = JSON.parse(line);
        if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
          if (threadId && event.thread_id !== threadId) throw new Error('Runtime resumed the wrong thread.');
          foundThread = event.thread_id; await onThread(event.thread_id);
        }
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') finalText = event.item.text;
        if (event.type === 'turn.completed') completed = true;
        if (event.type === 'turn.failed' || event.type === 'error') failed = true;
      }
      const code = await completion;
      if (killed) throw new Error('Runtime interrupted or turn time limit reached; inspect before retrying.');
      if (code !== 0 || failed || !completed || !foundThread) {
        throw new Error(`Codex turn failed (exit ${code ?? 'unknown'}). Check Codex login/configuration separately.`);
      }
      return parseTurnResult(finalText);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        kill(true); await completion.catch(() => {});
      }
      clearTimeout(timeout); clearTimeout(escalation);
      signal.removeEventListener('abort', stop);
    }
  }
}
