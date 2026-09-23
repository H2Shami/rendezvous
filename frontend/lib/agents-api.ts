export interface ManagedAgent { id: string; display_name: string; created_at: string; updated_at: string; disabled_at: string | null }
export interface Credential { id: string; agent_id: string; created_at: string; revoked_at: string | null; last_used_at: string | null }
export interface AgentPage { agents: ManagedAgent[]; next_cursor: string | null }
export interface CredentialPage { credentials: Credential[]; next_cursor: string | null }
export interface IssuedKey { credential: Credential; api_key: string }
export interface PeerPolicy { peer_agent_id: string; allow_inbound: boolean; allow_outbound: boolean }
export interface PeerPolicyPage { policies: PeerPolicy[]; next_cursor: string | null }
export type Availability = 'offline' | 'paused' | 'busy' | 'available';
export class AgentApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
/** Owner cookies authenticate management. Runtime keys never authenticate these calls. */
export async function agentRequest<T>(path: string, options: { method?: string; body?: unknown; csrf?: string; signal?: AbortSignal } = {}): Promise<T> {
  const method = options.method ?? 'GET';
  let response: Response;
  try {
    response = await fetch(`/api/v1/owner/agents${path}`, { method, credentials: 'same-origin', cache: 'no-store', signal: options.signal,
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': options.csrf ?? '' },
      ...(method === 'GET' ? {} : { body: JSON.stringify(options.body ?? {}) }) });
  } catch (e) {
    if (options.signal?.aborted) throw e;
    throw new AgentApiError(0, method === 'GET' ? 'Unable to connect. Refresh to try again.' : 'The result could not be confirmed. Refresh before trying again. If a key was created, revoke it and issue a new one.');
  }
  if (!response.ok) {
    const messages: Record<number, string> = { 401: 'Your sign-in expired. Sign in again to continue.', 403: 'This action was rejected. Reload to refresh your sign-in.',
      404: 'This agent or key is unavailable to your account.', 409: 'This agent is disabled or the key has already been revoked. Refresh to see its current state.',
      429: 'Too many requests. Wait a moment, then try again.', 400: 'Check the name and try again.' };
    throw new AgentApiError(response.status, messages[response.status] ?? 'The request failed. Refresh to check its result before trying again.');
  }
  try { return await response.json(); }
  catch { throw new AgentApiError(0, 'The response could not be read. Refresh to check the result before trying again.'); }
}
