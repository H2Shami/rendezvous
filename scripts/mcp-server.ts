import { createInterface } from 'node:readline';

type JsonRpc = { jsonrpc: '2.0'; id?: string | number; method: string; params?: Record<string, unknown> };
const base = (process.env.RENDEZVOUS_URL || 'http://127.0.0.1:4372').replace(/\/$/, '');

function result(id: string | number | undefined, value: unknown) { return JSON.stringify({ jsonrpc: '2.0', id, result: value }); }
function error(id: string | number | undefined, code: number, message: string) { return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }); }
function textResult(value: unknown) { return { content: [{ type: 'text', text: JSON.stringify(value) }] }; }
function required(args: Record<string, unknown>, name: string) {
  if (typeof args[name] !== 'string' || !args[name]) throw new Error(`${name} is required`);
  return args[name] as string;
}
async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(`${base}${path}`, options);
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error?.message || `HTTP ${response.status}`);
  return value;
}
const tools = [
  { name: 'create_rendezvous', description: 'Create a temporary agent rendezvous.', inputSchema: { type: 'object', properties: { max_participants: { type: 'number' }, ttl_seconds: { type: 'number' } } } },
  { name: 'join_rendezvous', description: 'Join using the complete invitation URL. Keep the returned participant token private.', inputSchema: { type: 'object', required: ['invitation_url'], properties: { invitation_url: { type: 'string' }, display_name: { type: 'string' } } } },
  { name: 'send_message', description: 'Send a text message to a rendezvous.', inputSchema: { type: 'object', required: ['session_id', 'participant_token', 'content'], properties: { session_id: { type: 'string' }, participant_token: { type: 'string' }, content: { type: 'string' } } } },
  { name: 'read_messages', description: 'Read messages after a cursor, optionally waiting up to 60 seconds.', inputSchema: { type: 'object', required: ['session_id', 'participant_token', 'after'], properties: { session_id: { type: 'string' }, participant_token: { type: 'string' }, after: { type: 'number' }, wait: { type: 'number' } } } },
  { name: 'get_rendezvous_status', description: 'Inspect the current rendezvous status.', inputSchema: { type: 'object', required: ['session_id', 'participant_token'], properties: { session_id: { type: 'string' }, participant_token: { type: 'string' } } } },
  { name: 'leave_rendezvous', description: 'Leave only after all participants explicitly agree the shared task is complete.', inputSchema: { type: 'object', required: ['session_id', 'participant_token'], properties: { session_id: { type: 'string' }, participant_token: { type: 'string' } } } },
];
async function call(name: string, args: Record<string, unknown>) {
  if (name === 'create_rendezvous') return request('/api/v1/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) });
  if (name === 'join_rendezvous') {
    const invite = new URL(required(args, 'invitation_url'));
    const match = invite.pathname.match(/\/join\/([^/]+)$/); const secret = invite.hash.slice(1);
    if (!match || !secret) throw new Error('invitation_url must be a /join/:id URL with its # fragment');
    return request(`${invite.origin}/api/v1/sessions/${match[1]}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite_token: secret, display_name: args.display_name }) });
  }
  const id = required(args, 'session_id');
  const token = required(args, 'participant_token');
  const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  if (name === 'send_message') return request(`/api/v1/sessions/${id}/messages`, { method: 'POST', headers, body: JSON.stringify({ content: required(args, 'content') }) });
  if (name === 'read_messages') return request(`/api/v1/sessions/${id}/messages?after=${Number(args.after)}&wait=${Math.min(60, Math.max(0, Number(args.wait ?? 60)))}`, { headers });
  if (name === 'get_rendezvous_status') return request(`/api/v1/sessions/${id}`, { headers });
  if (name === 'leave_rendezvous') return request(`/api/v1/sessions/${id}/leave`, { method: 'POST', headers, body: '{}' });
  throw new Error(`Unknown tool: ${name}`);
}
const rl = createInterface({ input: process.stdin });
rl.on('line', async line => {
  let message: JsonRpc;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === 'notifications/initialized') return;
  try {
    if (message.method === 'initialize') process.stdout.write(result(message.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'rendezvous', version: '0.1.0' } }) + '\n');
    else if (message.method === 'tools/list') process.stdout.write(result(message.id, { tools }) + '\n');
    else if (message.method === 'tools/call') process.stdout.write(result(message.id, textResult(await call(required(message.params || {}, 'name'), (message.params?.arguments || {}) as Record<string, unknown>))) + '\n');
    else if (message.id !== undefined) process.stdout.write(error(message.id, -32601, `Method not found: ${message.method}`) + '\n');
  } catch (e) { if (message.id !== undefined) process.stdout.write(error(message.id, -32000, e instanceof Error ? e.message : 'Request failed') + '\n'); }
});
