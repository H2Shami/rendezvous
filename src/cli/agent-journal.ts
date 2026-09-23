import { constants } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ClientJournal, ClientState } from '../client/index.js';

export async function readPrivateFile(path: string) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077)))
      throw new Error('Agent credentials and journals must be private regular files (mode 0600).');
    return await file.readFile('utf8');
  } finally { await file.close(); }
}

/** Caller must hold the profile lock for the entire client lifetime. */
export class AgentJournal implements ClientJournal {
  constructor(private path: string) {}
  async load(): Promise<ClientState | undefined> {
    try {
      const state = JSON.parse(await readPrivateFile(this.path));
      if (!state || state.version !== 1 || typeof state.sessions !== 'object' || !state.sessions || Array.isArray(state.sessions))
        throw new Error('Invalid agent journal.');
      return state; // The shared client validates identities, leases and session records.
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  async save(state: ClientState) {
    return writePrivateJson(this.path, state);
  }
}

export async function writePrivateJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(value) + '\n');
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, path);
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await rm(temporary, { force: true }); }
}
