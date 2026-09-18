import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, readdir, mkdir, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { serverOrigin, parseInvitation, type CreatedRoom } from "./client.js";
import { lockState } from "./state.js";

export const AGENTS = ["codex", "claude", "cursor", "opencode"] as const;
export type Agent = (typeof AGENTS)[number];
export function agentName(value: string): Agent {
  if (!(AGENTS as readonly string[]).includes(value))
    throw new Error(`Unknown agent. Choose: ${AGENTS.join(", ")}.`);
  return value as Agent;
}

export const agentLabels: Record<Agent, string> = {
  codex: "Codex",
  claude: "Claude Code",
  cursor: "Cursor",
  opencode: "OpenCode",
};
export function dataHome() {
  return process.env.RENDEZVOUS_HOME || join(homedir(), ".rendezvous");
}
export interface Config {
  agent?: Agent;
  server?: string;
}
export async function readConfig(): Promise<Config> {
  try {
    const value = JSON.parse(
      await readFile(join(dataHome(), "config.json"), "utf8"),
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid config file.");
    return {
      ...(value.agent ? { agent: agentName(value.agent) } : {}),
      ...(value.server ? { server: serverOrigin(value.server) } : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}
export async function setConfig(key: "agent" | "server", value: string) {
  const validated = key === "agent" ? agentName(value) : serverOrigin(value);
  const path = join(dataHome(), "config.json");
  const release = await lockState(path);
  try {
    const config = { ...(await readConfig()), [key]: validated };
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(config, null, 2) + "\n", {
      mode: 0o600,
    });
    await rename(temp, path);
  } finally {
    await release();
  }
}
export interface LocalRoom extends CreatedRoom {
  room_file: string;
}
export async function ownedRooms(): Promise<LocalRoom[]> {
  const directory = join(dataHome(), "created");
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const rooms: LocalRoom[] = [];
  for (const file of files.filter((f) => f.endsWith(".json")).sort()) {
    const path = join(directory, file);
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (
        typeof value?.invite_url !== "string" ||
        typeof value.owner_url !== "string" ||
        typeof value.expires_at !== "string"
      )
        continue;
      const invite = parseInvitation(value.invite_url);
      if (value.session_id !== invite.roomId) continue;
      rooms.push({
        session_id: value.session_id,
        invite_url: value.invite_url,
        owner_url: value.owner_url,
        expires_at: value.expires_at,
        room_file: path,
      });
    } catch (error) {
      // A reserved file from an uncertain create may be empty. Never expose its contents.
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }
  return rooms;
}
export async function rememberRoom(room: CreatedRoom) {
  const directory = join(dataHome(), "created");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${room.session_id}.json`);
  // A create has a fresh UUID. Exclusive writes protect existing owner credentials.
  await writeFile(path, JSON.stringify(room, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  return path;
}
