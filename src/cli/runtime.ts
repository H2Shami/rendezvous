import { harnessProgress, type EventSink } from './agent-events.js';
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentLabels, type Agent } from "./config.js";

export interface TurnResult {
  message: string | null;
  status: "ACTIVE" | "DONE" | "NEEDS_USER";
}
export interface RuntimeAdapter {
  run(
    prompt: string,
    threadId: string | undefined,
    signal: AbortSignal,
    onThread: (id: string) => Promise<void>,
    onEvent?: EventSink,
  ): Promise<TurnResult>;
}

export const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["message", "status"],
  properties: {
    message: { type: ["string", "null"] },
    status: { type: "string", enum: ["ACTIVE", "DONE", "NEEDS_USER"] },
  },
};

export function parseTurnResult(value: string): TurnResult {
  const result = JSON.parse(value) as TurnResult;
  if (
    !result ||
    !["ACTIVE", "DONE", "NEEDS_USER"].includes(result.status) ||
    (result.message !== null &&
      (typeof result.message !== "string" ||
        !result.message.trim() ||
        Buffer.byteLength(result.message) > 32768))
  )
    throw new Error("Invalid runtime response.");
  return result;
}

export function codexArguments(schema: string, threadId?: string) {
  return [
    "exec",
    "--sandbox",
    "read-only",
    "-c",
    'approval_policy="never"',
    ...(threadId ? ["resume", threadId] : []),
    "--json",
    "--output-schema",
    schema,
    "-",
  ];
}

// Credentials for the transport stay in the parent; never put prompts/secrets in argv.
function runtimeEnvironment(agent: Agent) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/^(RENDEZVOUS_|CODEX_THREAD_ID$|CLAUDECODE$|CLAUDE_CODE_SESSION_ID$|NODE_OPTIONS$)/.test(
          name,
        ),
    ),
  );
  if (agent === "opencode") {
    const permission = {
      "*": "deny",
      read: "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
    };
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      permission,
      agent: { rendezvous: { mode: "primary", permission } },
    });
    env.OPENCODE_DISABLE_AUTOUPDATE = "true";
  }
  return env;
}

export function agentArguments(
  agent: Agent,
  schema: string,
  threadId?: string,
): string[] {
  if (agent === "codex") return codexArguments(schema, threadId);
  if (agent === "claude")
    return [
      "--print",
      "--verbose",
      "--output-format",
      "stream-json",
      "--json-schema",
      JSON.stringify(outputSchema),
      "--permission-mode",
      "dontAsk",
      "--tools",
      "Read,Glob,Grep",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      ...(threadId ? ["--resume", threadId] : []),
    ];
  if (agent === "cursor")
    return [
      "--print",
      "--mode",
      "ask",
      "--output-format",
      "stream-json",
      ...(threadId ? ["--resume", threadId] : []),
    ];
  return [
    "run",
    "--format",
    "json",
    "--agent",
    "rendezvous",
    ...(threadId ? ["--session", threadId] : []),
  ];
}

export function findAgentExecutable(agent: Agent): string {
  const candidates = agent === "cursor" ? ["agent", "cursor-agent"] : [agent];
  for (const executable of candidates) {
    const check = spawnSync(executable, ["--version"], {
      timeout: 10000,
      stdio: "ignore",
    });
    if (!check.error && check.status === 0) return executable;
  }
  throw new Error(
    `Cannot run ${agentLabels[agent]}. Install and authenticate its CLI, then try again (expected ${candidates.join(" or ")} on PATH).`,
  );
}

export class CodexRuntime implements RuntimeAdapter {
  constructor(
    private workspace: string,
    private timeoutMs = 300_000,
    private executable = "codex",
    private agent: Agent = "codex",
  ) {}

  async run(
    prompt: string,
    threadId: string | undefined,
    signal: AbortSignal,
    onThread: (id: string) => Promise<void>,
    onEvent?: EventSink,
  ): Promise<TurnResult> {
    signal.throwIfAborted();
    const directory = await mkdtemp(join(tmpdir(), "rendezvous-codex-"));
    const schema = join(directory, "response.json");
    try {
      await writeFile(schema, JSON.stringify(outputSchema), { mode: 0o600 });
      return await this.execute(schema, prompt, threadId, signal, onThread, onEvent);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async execute(
    schema: string,
    prompt: string,
    threadId: string | undefined,
    signal: AbortSignal,
    onThread: (id: string) => Promise<void>,
    onEvent?: EventSink,
  ): Promise<TurnResult> {
    const child = spawn(
      this.executable,
      agentArguments(this.agent, schema, threadId),
      {
        cwd: this.workspace,
        env: runtimeEnvironment(this.agent),
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        shell: false,
      },
    );
    let killed = false;
    let escalation: NodeJS.Timeout | undefined;
    const kill = (hard = false) => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32")
          child.kill(hard ? "SIGKILL" : "SIGTERM");
        else process.kill(-child.pid, hard ? "SIGKILL" : "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const stop = () => {
      if (killed) return;
      killed = true;
      kill();
      escalation = setTimeout(() => kill(true), 2000);
    };
    const timeout = setTimeout(stop, this.timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    // Retain only bounded diagnostic lines; the display sink redacts them separately.
    let diagnostics = 0;
    const stderr = createInterface({ input: child.stderr });
    stderr.on('line', line => {
      if (diagnostics++ < 32) { try { onEvent?.({ kind: 'diagnostic', text: line.slice(0, 4096) }); } catch {} }
    });
    child.stdin.on("error", () => {});
    const completion = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    // Attach a handler immediately, including spawn errors before stdout is consumed.
    void completion.catch(() => {});
    child.stdin.end(prompt);
    let finalText = "";
    let completed = false;
    let failed = false;
    let foundThread = threadId;
    try {
      for await (const line of createInterface({ input: child.stdout })) {
        if (line.length > 2_000_000)
          throw new Error("Runtime event too large.");
        const event = JSON.parse(line);
        for (const progress of harnessProgress(this.agent, event)) {
          try { onEvent?.(progress); } catch { /* Observer failures never alter execution. */ }
        }
        if (this.agent !== "codex") {
          const id =
            this.agent === "opencode" ? event.sessionID : event.session_id;
          if (typeof id === "string") {
            if (foundThread && id !== foundThread)
              throw new Error("Runtime resumed the wrong thread.");
            if (!foundThread) {
              foundThread = id;
              await onThread(id);
            }
          }
          if (event.type === "error" || event.is_error === true) failed = true;
          if (this.agent === "opencode") {
            if (event.type === "text" && typeof event.part?.text === "string")
              finalText = event.part.text;
            if (event.type === "step_finish" && event.part?.reason === "stop")
              completed = true;
          } else if (event.type === "result") {
            completed = event.subtype === "success" && event.is_error !== true;
            finalText = event.structured_output
              ? JSON.stringify(event.structured_output)
              : event.result;
          }
          continue;
        }
        if (
          event.type === "thread.started" &&
          typeof event.thread_id === "string"
        ) {
          if (threadId && event.thread_id !== threadId)
            throw new Error("Runtime resumed the wrong thread.");
          foundThread = event.thread_id;
          await onThread(event.thread_id);
        }
        if (
          event.type === "item.completed" &&
          event.item?.type === "agent_message"
        )
          finalText = event.item.text;
        if (event.type === "turn.completed") completed = true;
        if (event.type === "turn.failed" || event.type === "error")
          failed = true;
      }
      const code = await completion;
      if (killed)
        throw new Error(
          "Runtime interrupted or turn time limit reached; inspect before retrying.",
        );
      if (code !== 0 || failed || !completed || !foundThread) {
        throw new Error(
          `${agentLabels[this.agent]} turn failed (exit ${code ?? "unknown"}). Check the agent login/configuration separately.`,
        );
      }
      return parseTurnResult(finalText);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        kill(true);
        await completion.catch(() => {});
      }
      stderr.close();
      clearTimeout(timeout);
      clearTimeout(escalation);
      signal.removeEventListener("abort", stop);
    }
  }
}

export function createRuntime(
  agent: Agent,
  workspace: string,
  timeout: number,
  executable: string,
): RuntimeAdapter {
  return new CodexRuntime(workspace, timeout, executable, agent);
}
