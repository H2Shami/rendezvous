export interface Field { key: string; label: string; hint?: string; initial?: string; required?: boolean; choices?: string[] }
export interface TuiAction { id: string; title: string; description: string; fields?: Field[]; command?: (values: Record<string, string>) => string[] }
const field = (key: string, label: string, initial = '', required = false): Field => ({ key, label, initial, required });
const profile = field('profile', 'Profile name', '', true);
const harness: Field = { key: 'agent', label: 'Harness', initial: 'codex', choices: ['codex', 'claude', 'cursor', 'opencode'] };
const options = (v: Record<string, string>, keys: string[]) => keys.flatMap(key => v[key]?.trim() ? [`--${key}`, v[key].trim()] : []);
const runtime = [harness, field('task', 'Instructions (blank to enter in a private prompt)'), field('workspace', 'Workspace'), field('server', 'Server override'), field('session', 'Existing harness thread (optional)')];

export const tuiActions: TuiAction[] = [
  { id: 'home', title: 'Home', description: 'Your agents, rooms, and active work' },
  { id: 'agents', title: 'Agents', description: 'Browse saved agent profiles' },
  { id: 'rooms', title: 'Rooms', description: 'Browse rooms created on this machine' },
  { id: 'settings', title: 'Settings', description: 'Defaults for your harness and server' },
  { id: 'setup', title: 'Set up an agent', description: 'Save an identity and securely enter its API key', fields: [profile, field('agent-id', 'Agent UUID', '', true), ...runtime.filter(f => f.key !== 'session')], command: v => ['agent', 'setup', v.profile, ...options(v, ['agent-id', 'agent', 'task', 'workspace', 'server'])] },
  { id: 'start', title: 'Start an agent', description: 'Connect a profile and watch its execution', fields: [profile, { key: 'takeover', label: 'Replace another remote listener?', initial: 'no', choices: ['no', 'yes'] }, { key: 'close-sessions', label: 'Abandon interrupted sessions? Inspect history first', initial: 'no', choices: ['no', 'yes'] }], command: v => ['agent', 'start', v.profile, ...options(v, ['peer', 'message']), ...['takeover', 'close-sessions'].filter(k => v[k] === 'yes').map(k => `--${k}`)] },
  { id: 'inspect', title: 'Inspect an agent', description: 'Profile, workspace, instructions and server', fields: [profile], command: v => ['agent', 'show', v.profile] },
  { id: 'status', title: 'Check agent status', description: 'Read live availability without acquiring a lease', fields: [profile], command: v => ['agent', 'status', v.profile] },
  { id: 'create', title: 'Create a room', description: 'Create an invitation and optionally join it', fields: [{ key: 'join', label: 'Join with a harness?', initial: 'yes', choices: ['yes', 'no'] }, field('participants', 'Room capacity', '2'), field('ttl', 'Lifetime in seconds (optional)'), ...runtime], command: v => ['create', ...(v.join === 'no' ? ['--no-join'] : []), ...options(v, ['participants', 'ttl', 'agent', 'task', 'workspace', 'server', 'session'])] },
  { id: 'join', title: 'Join or resume a room', description: 'Use an invitation, saved room, or exact harness thread', fields: [field('room', 'Saved room UUID (blank for private invitation prompt)'), ...runtime], command: v => ['join', ...(v.room.trim() ? [v.room.trim()] : []), ...options(v, ['agent', 'task', 'workspace', 'server', 'session'])] },
  { id: 'owner', title: 'Show owner link', description: 'Reveal the private dashboard link for a saved room', fields: [field('room', 'Room UUID', '', true)], command: v => ['owner', v.room] },
  { id: 'config-agent', title: 'Default harness', description: 'Set the harness used for new work', fields: [harness], command: v => ['config', 'agent', v.agent] },
  { id: 'config-server', title: 'Default server', description: 'Set your local or hosted Rendezvous server', fields: [field('server', 'Server URL', '', true)], command: v => ['config', 'server', v.server] },
  { id: 'config', title: 'Show configuration', description: 'Inspect current saved defaults', command: () => ['config', 'show'] },
  { id: 'open', title: 'Contact an agent', description: 'Choose a friend by name and start a conversation', fields: [field('message', 'Opening message', '', true)] },
  { id: 'close', title: 'Close conversation', description: 'End the current session; keep the listener online' },
  { id: 'stop', title: 'Stop selected process', description: 'Disconnect the selected agent or room listener' },
  { id: 'jobs', title: 'Active work', description: 'Switch between running listeners and recent results' },
  { id: 'run', title: 'Run any CLI command', description: 'All CLI options, without leaving this app', fields: [field('command', 'Command, without the rendezvous prefix', '', true)], command: v => parseCommand(v.command) },
  { id: 'help', title: 'Command reference', description: 'Read help for any CLI command', fields: [{ key: 'topic', label: 'Command', initial: 'agent', choices: ['agent', 'create', 'join', 'rooms', 'owner', 'config'] }], command: v => [v.topic, '--help'] },
  { id: 'version', title: 'Version', description: 'Show the installed Rendezvous version', command: () => ['--version'] },
  { id: 'quit', title: 'Quit', description: 'Stop running work and exit Rendezvous' },
];

/** Parse arguments only. There is no shell, command substitution, or expansion. */
export function parseCommand(value: string) {
  const args: string[] = []; let current = '', quote = '', escape = false, started = false;
  for (const char of value.trim()) {
    if (escape) { current += char; escape = false; started = true; }
    else if (char === '\\' && quote !== "'") { escape = true; started = true; }
    else if (quote) { if (char === quote) quote = ''; else current += char; }
    else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) { args.push(current); current = ''; started = false; } }
    else { current += char; started = true; }
  }
  if (quote || escape) throw new Error('Close the quote or trailing escape in your command.');
  if (started) args.push(current);
  if (args[0] === 'rendezvous') args.shift();
  if (!args.length) throw new Error('Enter a CLI command.');
  return args;
}
