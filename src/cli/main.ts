#!/usr/bin/env node
import { rendezvousBanner, statusLine } from './ui.js';
import { parseArgs } from "node:util";
import {
  readFile,
  realpath,
  mkdir,
  open,
  stat,
  readdir,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { addAbortSignal } from "node:stream";
import {
  parseInvitation,
  RoomClient,
  createRoom,
  serverOrigin,
} from "./client.js";
import { loadState, lockState, saveState, type BridgeState } from "./state.js";
import { createRuntime, findAgentExecutable } from "./runtime.js";
import { listen } from "./bridge.js";
import {
  AGENTS,
  agentName,
  agentLabels,
  dataHome,
  ownedRooms,
  readConfig,
  rememberRoom,
  setConfig,
  type Agent,
} from "./config.js";
import { Prompts, UsageError } from "./prompts.js";
import { help } from "./help.js";
import { createProfile, listProfiles, profileName, readProfile } from './profiles.js';
import { agentErrorMessage, agentStatus, startAgent } from './agent-listener.js';
import { AgentClientError } from '../client/index.js';

export const DEFAULT_SERVER = "https://dev.userendezvous.com";
const invocation =
  process.env.npm_lifecycle_event === "rendezvous"
    ? "npm run rendezvous --"
    : "rendezvous";
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function integer(
  value: string | undefined,
  fallback: number,
  flag: string,
  max = 86400,
) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < 1 || n > max)
    throw new UsageError(`${flag} must be an integer from 1 to ${max}.`);
  return n;
}
async function objectiveFile(path: string, signal: AbortSignal) {
  if (path !== "-") return readFile(resolve(path), "utf8");
  if (process.stdin.isTTY)
    throw new UsageError("--objective-file - requires piped input.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of addAbortSignal(signal, process.stdin)) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 32768) throw new UsageError("Task input exceeds 32768 bytes.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function findSavedState(roomId: string, origin?: string) {
  const directory = join(dataHome(), "rooms");
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const matches: string[] = [];
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    const path = join(directory, file);
    const state = await loadState(path);
    if (state?.roomId === roomId && (!origin || origin === state.origin))
      matches.push(path);
  }
  if (matches.length > 1)
    throw new UsageError(
      "More than one saved participant matches this room. Choose --state FILE.",
    );
  return matches[0];
}

async function main() {
  const args = process.argv.slice(2);
  const topic = args[0] === "help" ? args[1] : args[0];
  if (
    !args.length ||
    args.includes("-h") ||
    args.includes("--help") ||
    args[0] === "help"
  ) {
    console.log(help(topic).replaceAll("rendezvous ", `${invocation} `).replace("Rendezvous — bring", `${rendezvousBanner(process.stdout)}\n\nBring`));
    return;
  }
  if (args.length === 1 && ["--version", "-V"].includes(args[0])) {
    console.log(
      JSON.parse(
        await readFile(new URL("../../package.json", import.meta.url), "utf8"),
      ).version,
    );
    return;
  }
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        server: { type: "string" },
        output: { type: "string" },
        participants: { type: "string" },
        ttl: { type: "string" },
        "no-join": { type: "boolean" },
        join: { type: "boolean" },
        agent: { type: "string" },
        "agent-id": { type: "string" },
        takeover: { type: "boolean" },
        events: { type: "boolean" },
        "close-sessions": { type: "boolean" },
        peer: { type: "string" },
        message: { type: "string" },
        session: { type: "string" },
        task: { type: "string" },
        "objective-file": { type: "string" },
        workspace: { type: "string" },
        room: { type: "string" },
        token: { type: "string" },
        "room-file": { type: "string" },
        state: { type: "string" },
        name: { type: "string" },
        "max-turns": { type: "string" },
        "turn-timeout": { type: "string" },
        "retry-interrupted": { type: "boolean" },
        quiet: { type: "boolean", short: "q" },
        json: { type: "boolean" },
        "no-input": { type: "boolean" },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { values: v, positionals } = parsed;
  const [rawCommand, ...rest] = positionals;
  const command = rawCommand === "listen" ? "join" : rawCommand;
  const shared = [
    "agent",
    "session",
    "task",
    "objective-file",
    "workspace",
    "state",
    "name",
    "max-turns",
    "turn-timeout",
    "retry-interrupted",
    "no-input",
    "quiet",
  ];
  const allowed: Record<string, string[]> = {
    create: [
      ...shared,
      "server",
      "output",
      "participants",
      "ttl",
      "no-join",
      "join",
      "json",
    ],
    join: [...shared, "server", "room", "token", "room-file"],
    rooms: ["json"],
    owner: ["room-file", "json"],
    config: ["json", "no-input"],
    agent: ["agent-id", "agent", "server", "workspace", "task", "objective-file", "json", "no-input", "takeover", "close-sessions", "peer", "message", "turn-timeout", "events"],
  };
  if (!allowed[command])
    throw new UsageError(
      "Unknown command. Choose create, join, rooms, owner, config, or agent.",
    );
  for (const key of Object.keys(v))
    if (!allowed[command].includes(key))
      throw new UsageError(`--${key} is not an option for ${command}.`);
  if (
    ((command === "create" || command === "rooms") && rest.length) ||
    (["join", "owner"].includes(command) && rest.length > 1)
  ) {
    throw new UsageError(
      `Unexpected positional arguments. When using npm, include the separator: npm run rendezvous -- ${command} [options].`,
    );
  }
  if (v.join && v["no-join"])
    throw new UsageError("Choose either --join or --no-join.");
  if (v.task !== undefined && v["objective-file"])
    throw new UsageError("Choose --task or --objective-file.");
  if (v.room && rest.length)
    throw new UsageError(
      "Supply the room once: as an argument or with --room.",
    );
  if (v["room-file"] && (v.room || rest.length || v.token))
    throw new UsageError(
      "--room-file cannot be combined with a room argument or --token.",
    );
  if (v.session && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(v.session))
    throw new UsageError(
      "--session must be an explicit agent session ID, not a flag or session name.",
    );
  if (v.name && v.name.length > 100)
    throw new UsageError("--name must be at most 100 characters.");
  const config = await readConfig();
  const controller = new AbortController();
  const stop = () => {
    process.exitCode = 130;
    controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const prompts = new Prompts(controller.signal, !v["no-input"] && !v.json);
  const log = (message: string) => {
    if (!v.quiet) console.error(statusLine(message));
  };
  try {
    if (command === 'agent') {
      const [action, name] = rest;
      const actionFlags: Record<string, string[]> = {
        setup: ['agent-id', 'agent', 'server', 'workspace', 'task', 'objective-file', 'json', 'no-input'],
        list: ['json', 'no-input'], show: ['json', 'no-input'], status: ['json', 'no-input'],
        start: ['takeover', 'no-input', 'close-sessions', 'peer', 'message', 'turn-timeout', 'events'],
      };
      if (!actionFlags[action] || rest.length !== (action === 'list' ? 1 : 2))
        throw new UsageError('Use agent setup NAME, agent list, agent show NAME, agent status NAME, or agent start NAME.');
      if (Object.keys(v).some(key => !actionFlags[action].includes(key)))
        throw new UsageError(`Unsupported option for agent ${action}. See agent --help.`);
      if (action === 'list') {
        const profiles = await listProfiles();
        console.log(v.json ? JSON.stringify(profiles, null, 2) : profiles.map(p => `${p.name}: ${p.agent} · ${p.agentId} · ${p.origin}`).join('\n') || 'No saved agent profiles. Use agent setup NAME.');
        return;
      }
      profileName(name);
      if (action === 'start') {
        if ((v.peer === undefined) !== (v.message === undefined)) throw new UsageError('Use --peer AGENT_UUID and --message TEXT together.');
        if (v.peer && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v.peer)) throw new UsageError('--peer must be an agent UUID.');
        if (v.message !== undefined && (!v.message.trim() || Buffer.byteLength(v.message) > 32768)) throw new UsageError('--message must contain 1–32768 bytes.');
        await startAgent(name, { takeover: v.takeover, signal: controller.signal, log,
          events: v.events ? event => new Promise<void>(resolve => { process.stdout.write(JSON.stringify(event) + '\n', () => resolve()); }) : undefined,
          closeSessions: v['close-sessions'], peer: v.peer, message: v.message,
          turnTimeout: integer(v['turn-timeout'], 300, '--turn-timeout'),
          askUser: prompts.interactive ? async (sessionId, question, signal) => {
            if (question) log(`Session ${sessionId} needs your input: ${question.replace(/[\x00-\x1f\x7f]/g, ' ')}`);
            return new Prompts(signal).ask('Local answer', 'Only local input can resolve this request.');
          } : undefined,
        });
        return;
      }
      if (action === 'status') {
        const status = await agentStatus(name, controller.signal);
        console.log(v.json ? JSON.stringify(status, null, 2) : `${name}: ${status.availability}`);
        return;
      }
      if (action === 'show') {
        const profile = await readProfile(name);
        console.log(v.json ? JSON.stringify(profile, null, 2) : `Profile: ${profile.name}\nAgent ID: ${profile.agentId}\nServer: ${profile.origin}\nHarness: ${profile.agent}\nWorkspace: ${profile.workspace}\nInstructions: ${profile.instructions}`);
        return;
      }
      const agentId = v['agent-id'] ?? await prompts.ask('Agent ID', 'Copy the agent UUID from the dashboard or use --agent-id UUID.');
      const instructions = v.task ?? (v['objective-file'] ? await objectiveFile(v['objective-file'], controller.signal) :
        await prompts.ask('Agent instructions', 'Use --task TEXT or --objective-file FILE.'));
      const apiKey = process.env.RENDEZVOUS_AGENT_API_KEY || await prompts.ask('Agent API key',
        'Provide RENDEZVOUS_AGENT_API_KEY for noninteractive setup.', { secret: true });
      controller.signal.throwIfAborted();
      const profile = await createProfile({ name, agentId, instructions, agent: agentName(v.agent ?? config.agent ?? 'codex'),
        origin: serverOrigin(v.server ?? (process.env.RENDEZVOUS_URL || config.server || DEFAULT_SERVER)),
        workspace: v.workspace ?? process.cwd() }, apiKey);
      console.log(v.json ? JSON.stringify(profile, null, 2) : `Saved agent profile ${name}. Inspect it with ${invocation} agent show ${name}.`);
      return;
    }
    if (command === 'create' || command === 'join') log(rendezvousBanner());
    if (command === 'owner') {
      let owner: string;
      if (v['room-file']) {
        const room = JSON.parse(await readFile(resolve(v['room-file']), 'utf8'));
        owner = room?.owner_url;
      } else {
        if (!rest[0]) throw new UsageError('Use owner ROOM_ID or owner --room-file FILE.');
        const matches = (await ownedRooms()).filter(room => room.session_id === rest[0]);
        if (matches.length !== 1) throw new UsageError('No unique local owner record. Use --room-file FILE from room creation.');
        owner = matches[0].owner_url;
      }
      if (typeof owner !== 'string' || !owner.startsWith('http') || !new URL(owner).hash) throw new UsageError('No owner link in this room file.');
      console.log(v.json ? JSON.stringify({ owner_url: owner }) : owner);
      return;
    }
    if (command === "config") {
      let parts = rest[0] === "set" ? rest.slice(1) : rest;
      if (parts.length > 2)
        throw new UsageError(
          "Use config [agent|server] [value], or config show.",
        );
      if (parts[0] === "show" || (!parts.length && !prompts.interactive)) {
        if (parts.length > 1)
          throw new UsageError("config show does not take a value.");
        const effective = {
          agent: config.agent ?? "codex",
          server: config.server ?? DEFAULT_SERVER,
        };
        console.log(
          v.json
            ? JSON.stringify(effective, null, 2)
            : `Agent: ${effective.agent}\nServer: ${effective.server}`,
        );
        return;
      }
      if (!parts.length) {
        const selected = await prompts.ask(
          `Default agent (${AGENTS.join(", ")})`,
          "Use config agent NAME.",
          { defaultValue: config.agent ?? "codex" },
        );
        await setConfig("agent", selected);
        console.log(`Default agent: ${selected}`);
        return;
      }
      const key = parts[0] === "default-agent" ? "agent" : parts[0];
      if (key !== "agent" && key !== "server")
        throw new UsageError(
          "Config keys: agent, server. Use config show to see both.",
        );
      const value =
        parts[1] ??
        (await prompts.ask(`Default ${key}`, `Use config ${key} VALUE.`, {
          defaultValue:
            config[key] ?? (key === "agent" ? "codex" : DEFAULT_SERVER),
        }));
      try {
        await setConfig(key, value);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code) throw error;
        throw new UsageError((error as Error).message);
      }
      console.log(
        v.json ? JSON.stringify({ [key]: value }) : `Default ${key}: ${value}`,
      );
      return;
    }
    if (command === "rooms") {
      const rows = (await ownedRooms()).map((room) => ({
        room: room.session_id,
        server: new URL(room.invite_url).origin,
        expires_at: room.expires_at,
        expired: Date.parse(room.expires_at) <= Date.now(),
        room_file: room.room_file,
      }));
      if (v.json) console.log(JSON.stringify(rows, null, 2));
      else if (!rows.length)
        console.log(
          `No rooms created on this machine yet. Run ${invocation} create.`,
        );
      else
        console.log(
          [
            "ROOM                                 SERVER                         EXPIRES",
            ...rows.map(
              (r) =>
                `${r.room} ${r.server} ${r.expires_at}${r.expired ? " (expired)" : ""}`,
            ),
          ].join("\n"),
        );
      return;
    }
    const maxTurns = integer(v["max-turns"], Infinity, "--max-turns");
    const timeout = integer(v["turn-timeout"], 300, "--turn-timeout") * 1000;
    const participants = integer(v.participants, 2, "--participants", 10);
    const ttl =
      v.ttl === undefined ? undefined : integer(v.ttl, 86400, "--ttl", 604800);
    let origin: string;
    try {
      origin = serverOrigin(
        v.server ??
          (process.env.RENDEZVOUS_URL || undefined) ??
          config.server ??
          DEFAULT_SERVER,
      );
    } catch (error) {
      throw new UsageError((error as Error).message);
    }
    let invitation: ReturnType<typeof parseInvitation> | undefined;
    let requestedRoom: string | undefined;
    let statePath = v.state ? resolve(v.state) : undefined;
    if (command === "join") {
      let target: string | undefined = rest[0] ?? v.room;
      if (v["room-file"]) {
        const room = JSON.parse(
          await readFile(resolve(v["room-file"]), "utf8"),
        );
        if (typeof room?.invite_url !== "string")
          throw new UsageError(
            "Invalid --room-file. Use a file saved by create.",
          );
        target = room.invite_url;
      }
      target ??= statePath ? undefined : process.env.RENDEZVOUS_INVITATION_URL;
      if (!target && !statePath)
        target = await prompts.ask(
          "Invitation URL or room ID",
          "Pass join URL or join --room ID --token TOKEN.",
          { secret: true },
        );
      if (target) {
        if (target.startsWith("http://") || target.startsWith("https://")) {
          if (v.token)
            throw new UsageError(
              "A combined invitation URL already includes its token.",
            );
          invitation = parseInvitation(target);
        } else {
          if (!/^[a-f0-9-]{36}$/.test(target))
            throw new UsageError(
              "Expected a room UUID or full invitation URL.",
            );
          requestedRoom = target;
          statePath ??= await findSavedState(
            target,
            v.server ? origin : undefined,
          );
          if (!statePath || !(await loadState(statePath))) {
            const known = (await ownedRooms()).filter(
              (r) =>
                r.session_id === target &&
                (!v.server || new URL(r.invite_url).origin === origin),
            );
            if (known.length > 1)
              throw new UsageError(
                "Room ID matches multiple servers. Specify --server.",
              );
            if (known[0] && !v.token)
              invitation = parseInvitation(known[0].invite_url);
            else {
              const token =
                v.token ??
                (process.env.RENDEZVOUS_TOKEN || undefined) ??
                (await prompts.ask(
                  "Invitation token",
                  "Pass --token TOKEN or a combined invitation URL.",
                  { secret: true },
                ));
              invitation = parseInvitation(`${origin}/join/${target}#${token}`);
            }
          }
        }
      }
      if (invitation) {
        origin = invitation.origin;
        statePath ??= join(
          dataHome(),
          "rooms",
          `${digest(`${origin}/${invitation.roomId}`)}.json`,
        );
      }
    }
    delete process.env.RENDEZVOUS_INVITATION_URL;
    delete process.env.RENDEZVOUS_TOKEN;
    const release = statePath ? await lockState(statePath) : undefined;
    let laterRelease: (() => Promise<void>) | undefined;
    let sessionRelease: (() => Promise<void>) | undefined;
    let lockedSession: string | undefined;
    try {
      let state = statePath ? await loadState(statePath) : undefined;
      if (command === "create" && state)
        throw new UsageError(
          "--state already belongs to a room. Use join --state FILE or choose a new path.",
        );
      if (
        state &&
        invitation &&
        (state.origin !== invitation.origin ||
          state.roomId !== invitation.roomId)
      )
        throw new UsageError("State belongs to another room/server.");
      if (
        command === "join" &&
        state &&
        requestedRoom &&
        state.roomId !== requestedRoom
      )
        throw new UsageError("State belongs to another room.");
      if (state?.inFlight && !v["retry-interrupted"])
        throw new Error(
          "Previous turn was interrupted. Inspect room and agent history before using --retry-interrupted.",
        );
      if (command === "join" && !state && !invitation)
        throw new UsageError(
          "Saved participant not found. Join with an invitation URL.",
        );
      let selected: Agent;
      try {
        selected = agentName(
          v.agent ??
            state?.agent ??
            (state ? "codex" : config.agent) ??
            "codex",
        );
      } catch (error) {
        throw new UsageError((error as Error).message);
      }
      if (state && selected !== (state.agent ?? "codex"))
        throw new UsageError(
          "This room participant is bound to another agent. Use a separate --state path to join as a new participant.",
        );
      if (state?.threadId && v.session && v.session !== state.threadId)
        throw new UsageError(
          "This participant is bound to another agent session. Use a separate --state path.",
        );
      const autoJoin = command === "join" || !v["no-join"];
      let workspace = "",
        objective = "",
        executable = "";
      if (autoJoin) {
        workspace = await realpath(
          v.workspace ?? state?.workspace ?? process.cwd(),
        );
        if (!(await stat(workspace)).isDirectory())
          throw new UsageError("--workspace must be a directory.");
        if (state && state.workspace !== workspace)
          throw new UsageError(
            "Cannot change workspace for an existing room participant.",
          );
        objective = (
          v.task ??
          (v["objective-file"]
            ? await objectiveFile(v["objective-file"], controller.signal)
            : state?.objective) ??
          (v.session
            ? "Continue the existing task in this conversation and coordinate with the room. Share only information relevant to that task."
            : await prompts.ask(
                "What should your agent work on?",
                "Pass --task TEXT or --objective-file FILE.",
              ))
        ).trim();
        if (!objective || Buffer.byteLength(objective) > 32768)
          throw new UsageError(
            "Provide task/boundaries of 1–32768 bytes with --task or --objective-file.",
          );
        executable = findAgentExecutable(selected);
        const thread = v.session ?? state?.threadId;
        if (thread) {
          sessionRelease = await lockState(
            join(
              dataHome(),
              "agent-locks",
              `${digest(`${selected}/${thread}`)}.lock`,
            ),
          );
          lockedSession = thread;
          if (v.session && !state?.threadId)
            log(
              `Resuming ${agentLabels[selected]} session ${thread}. Room messages will enter this conversation and replies will be shared with room participants.`,
            );
        }
      }
      if (command === "create") {
        const output = resolve(
          v.output ?? join(dataHome(), "created", `${randomUUID()}.json`),
        );
        await mkdir(dirname(output), { recursive: true, mode: 0o700 });
        const file = await open(output, "wx", 0o600);
        try {
          log(`Creating room at ${origin}…`);
          const room = await createRoom(
            origin,
            participants,
            ttl,
            controller.signal,
          );
          await file.writeFile(JSON.stringify(room, null, 2) + "\n");
          await file.sync();
          if (dirname(output) !== resolve(dataHome(), "created"))
            await rememberRoom(room);
          console.log(
            v.json
              ? JSON.stringify({ ...room, room_file: output }, null, 2)
              : room.invite_url,
          );
          log(`Room: ${room.session_id}\nOwner: ${room.owner_url}\nPrivate room file: ${output}`);
          if (!autoJoin) {
            log(`Join when ready: ${invocation} join ${room.session_id}`);
            return;
          }
          invitation = parseInvitation(room.invite_url);
          if (!statePath) {
            statePath = join(
              dataHome(),
              "rooms",
              `${digest(`${origin}/${room.session_id}`)}.json`,
            );
            laterRelease = await lockState(statePath);
          }
        } catch (error) {
          console.error(
            `Creation was not retried. Check ${output} before creating another room; it may already exist.`,
          );
          throw error;
        } finally {
          await file.close();
        }
      }
      if (!statePath) throw new Error("Missing participant state path.");
      if (!state) {
        if (!invitation) throw new UsageError("Provide an invitation to join.");
        log(`Joining with ${agentLabels[selected]}…`);
        const joined = await new RoomClient(
          invitation.origin,
          invitation.roomId,
        ).join(
          invitation.secret,
          v.name ?? agentLabels[selected],
          controller.signal,
        );
        state = {
          version: 1,
          origin: invitation.origin,
          roomId: invitation.roomId,
          participantId: joined.participant_id,
          token: joined.participant_token,
          workspace,
          objective,
          agent: selected,
          threadId: v.session,
          cursor: 0,
          initialized: false,
        };
        await saveState(statePath, state);
      }
      state.agent = selected;
      if (v.task !== undefined || v["objective-file"]) {
        state.objective = objective;
        state.pendingUser = false;
        state.userInput = undefined;
        state.initialized = false;
      }
      if (v.session && !state.threadId) {
        state.threadId = v.session;
        state.initialized = false;
      }
      if (v["retry-interrupted"]) state.inFlight = false;
      await saveState(statePath, state);
      log(
        `Joined room ${state.roomId}\nAgent: ${agentLabels[selected]}\nWorkspace: ${workspace}\nPrivate state: ${statePath}\nResume: ${invocation} join --state ${quote(statePath)}\nCtrl+C to disconnect.`,
      );
      const current = state;
      await listen({
        state,
        client: new RoomClient(state.origin, state.roomId, state.token),
        runtime: createRuntime(selected, workspace, timeout, executable),
        signal: controller.signal,
        log,
        maxTurns,
        onNeedsUser: prompts.interactive ? async signal => {
          const answer = await new Prompts(signal).ask('Your reply', 'Provide your local instructions.');
          if (Buffer.byteLength(answer) > 32768) throw new UsageError('Local answer exceeds 32768 bytes.');
          return answer;
        } : undefined,
        save: async () => {
          if (current.threadId && current.threadId !== lockedSession) {
            sessionRelease = await lockState(
              join(
                dataHome(),
                "agent-locks",
                `${digest(`${selected}/${current.threadId}`)}.lock`,
              ),
            );
            lockedSession = current.threadId;
          }
          await saveState(statePath!, current);
        },
      });
    } finally {
      await sessionRelease?.();
      await laterRelease?.();
      await release?.();
    }
  } catch (error) {
    if (command === 'agent') throw error;
    if (!controller.signal.aborted) throw error;
    log("Disconnected. Saved room and conversation can be resumed.");
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
process.stdout.on("error", (error) => {
  if ((error as NodeJS.ErrnoException).code === "EPIPE") process.exit(0);
  throw error;
});
main().catch((error) => {
  if (error?.name === "AbortError") {
    process.exitCode = 130;
    return;
  }
  const code = (error as NodeJS.ErrnoException).code;
  const message =
    error instanceof AgentClientError
      ? agentErrorMessage(error)
      : code === "EEXIST"
      ? "Output file already exists. Choose a new --output path."
      : code === "ELOCKED"
        ? "This room or agent session is already in use by another listener. Stop it before resuming."
        : code === "ENOENT"
          ? "File or directory not found. Check your workspace, task, room, and state paths."
          : code === "EACCES"
            ? "Permission denied. Choose a path you can read/write."
            : error instanceof SyntaxError
              ? "Invalid JSON in a saved file or server response."
              : error instanceof TypeError && error.message === "fetch failed"
                ? "Cannot reach the server. Check --server or run rendezvous config server URL."
                : error instanceof Error
                  ? error.message
                  : "CLI failed.";
  console.error(`Error: ${message}`);
  if (error instanceof UsageError)
    console.error(
      `Run ${invocation} ${process.argv[2] ?? ""} --help for examples.`,
    );
  process.exitCode ||= error instanceof UsageError ? 2 : 1;
});
