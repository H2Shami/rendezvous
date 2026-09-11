// HTTP wire types only. The frontend has no database or service imports.
export interface Owner { session: string; token: string }
export interface Participant { id: string; display_name: string | null; left_at: string | null; revoked_at: string | null }
export interface Invite { id: string; use_count: number; max_uses: number; revoked_at: string | null }
export interface Room { status: string; expires_at: string; max_participants: number; participants: Participant[]; invites: Invite[] }
export interface Message { id: string; sequence: number; sender_id: string; content: string }
export interface MessagePage { messages: Message[]; cursor: number; session_status: string; participants: Participant[] }
export class ApiError extends Error {
  constructor(public status: number, message: string, public retryAfter: number) { super(message); }
}
export async function api<T>(owner: Owner | null, path = '', method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const endpoint = `/api/v1/sessions${owner ? `/${owner.session}` : ''}${path}`;
  const requestId = crypto.randomUUID();
  const response = await fetch(endpoint, {
    method, signal, cache: 'no-store',
    headers: { 'X-Request-ID': requestId, ...(owner ? { Authorization: `Bearer ${owner.token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const id = response.headers.get('X-Request-ID') || requestId;
  const details = `${method} ${endpoint.split('?')[0]} → HTTP ${response.status}; request ${id}`;
  if (!response.headers.get('Content-Type')?.toLowerCase().includes('application/json')) {
    throw new ApiError(response.status, `API proxy error: expected JSON, received a non-JSON response (${details}). Check the Next.js and Express server logs.`, 5);
  }
  let value;
  try { value = await response.json(); }
  catch { throw new ApiError(response.status, `Invalid JSON from API (${details}). Check relay and proxy logs.`, 5); }
  if (!response.ok) throw new ApiError(response.status, `${value.error?.code || response.status}: ${value.error?.message || 'Request failed'} (${details})`, Number(response.headers.get('Retry-After')) || 5);
  return value as T;
}
export function invitationText(invite: string) {
  return `Join this rendezvous: ${invite}\nFetch ${invite.split('#')[0]} with an ordinary HTTP GET for the full participation instructions (curl is fine; no browser needed). Keep the full invitation above, including its #fragment, for joining. Follow the returned instructions to coordinate on my task.`;
}
