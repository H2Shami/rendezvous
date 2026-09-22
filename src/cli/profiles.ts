import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { agentName, dataHome, type Agent } from './config.js';
import { serverOrigin } from './client.js';
import { UsageError } from './prompts.js';
import { lockState } from './state.js';

export interface AgentProfile {
  version: 1;
  name: string;
  origin: string;
  agentId: string;
  agent: Agent;
  workspace: string;
  instructions: string;
  credentialFile: 'credential';
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function profileName(name: string) {
  if (!/^[a-z][a-z0-9_-]{0,47}$/.test(name))
    throw new UsageError('Profile names must start with a lowercase letter and contain only lowercase letters, digits, _ or - (up to 48 characters).');
  return name;
}
export function profileDirectory(name: string) {
  return join(dataHome(), 'agents', profileName(name));
}
function validate(value: AgentProfile): AgentProfile {
  if (!value || value.version !== 1 || typeof value.name !== 'string' ||
    typeof value.agentId !== 'string' || !uuid.test(value.agentId) ||
    typeof value.workspace !== 'string' || !value.workspace ||
    typeof value.instructions !== 'string' || !value.instructions.trim() ||
    Buffer.byteLength(value.instructions) > 32768 || value.credentialFile !== 'credential')
    throw new UsageError('Invalid agent profile. Supply an agent UUID, workspace, and instructions of 1–32768 bytes.');
  return { version: 1, name: profileName(value.name), origin: serverOrigin(value.origin),
    agentId: value.agentId.toLowerCase(), agent: agentName(value.agent), workspace: value.workspace,
    instructions: value.instructions, credentialFile: 'credential' };
}
async function privateDirectory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || (process.platform !== 'win32' && (info.mode & 0o077)))
    throw new Error('Agent profile directories must be real, private directories (mode 0700).');
}

/** Publish the profile and its credential together; never replace an existing identity. */
export async function createProfile(input: Omit<AgentProfile, 'version' | 'credentialFile'>, apiKey: string) {
  const profile = validate({ ...input, version: 1, credentialFile: 'credential' });
  if (!/^agk_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/.test(apiKey))
    throw new UsageError('Invalid agent API key. Use a runtime key from the agent dashboard.');
  profile.workspace = await realpath(resolve(profile.workspace));
  if (!(await stat(profile.workspace)).isDirectory()) throw new UsageError('Workspace must be a directory.');
  const root = join(dataHome(), 'agents'), target = profileDirectory(profile.name);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await privateDirectory(root);
  const release = await lockState(target).catch(error => {
    if (error.code === 'ELOCKED') throw new Error('This agent profile is in use by another process. Try again after it stops.');
    throw error;
  });
  let temporary: string | undefined;
  try {
    const exists = await lstat(target).then(() => true, error => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    if (exists) throw new UsageError('That agent profile already exists. Choose a different profile name.');
    temporary = await mkdtemp(join(root, '.setup-'));
    await writeFile(join(temporary, 'credential'), apiKey + '\n', { mode: 0o600, flag: 'wx' });
    await writeFile(join(temporary, 'profile.json'), JSON.stringify(profile, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
    temporary = undefined;
    return profile;
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
    await release();
  }
}

/** Inspection never reads or returns the credential. */
export async function readProfile(name: string): Promise<AgentProfile> {
  const directory = profileDirectory(name);
  await privateDirectory(join(dataHome(), 'agents'));
  await privateDirectory(directory);
  const profile = validate(JSON.parse(await readFile(join(directory, 'profile.json'), 'utf8')));
  if (profile.name !== name) throw new Error('Saved agent profile name does not match its directory.');
  return profile;
}
export async function listProfiles() {
  const root = join(dataHome(), 'agents');
  try { await privateDirectory(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const names = (await readdir(root, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && /^[a-z][a-z0-9_-]{0,47}$/.test(entry.name)).map(entry => entry.name).sort();
  return Promise.all(names.map(readProfile));
}
