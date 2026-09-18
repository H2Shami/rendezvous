import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";

import type { Agent } from "./config.js";

export interface BridgeState {
  version: 1;
  origin: string;
  roomId: string;
  participantId: string;
  token: string;
  workspace: string;
  objective: string;
  cursor: number;
  threadId?: string;
  agent?: Agent;
  initialized: boolean;
  pendingUser?: boolean;
  userInput?: string;
  roster?: string;
  inFlight?: boolean;
}

export async function saveState(path: string, state: BridgeState) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", {
    mode: 0o600,
  });
  await rename(temporary, path);
}

export async function loadState(
  path: string,
): Promise<BridgeState | undefined> {
  try {
    const state = JSON.parse(await readFile(path, "utf8")) as BridgeState;
    if (
      state.version !== 1 ||
      !state.token ||
      !state.roomId ||
      !Number.isSafeInteger(state.cursor) ||
      state.cursor < 0 ||
      !state.workspace ||
      !state.objective
    )
      throw new Error("Invalid bridge state file.");
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function lockState(path: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  return lockfile.lock(path, { realpath: false, retries: 0 });
}
