// HTTP wire types only. The frontend has no database or service imports.
export interface Owner {
  session: string;
  token: string;
  account?: boolean;
  csrfToken?: string;
}
export interface Participant {
  id: string;
  display_name: string | null;
  left_at: string | null;
  revoked_at: string | null;
}
export interface Invite {
  id: string;
  use_count: number;
  max_uses: number;
  revoked_at: string | null;
}
export interface Room {
  status: string;
  expires_at: string;
  max_participants: number;
  participants: Participant[];
  invites: Invite[];
}
export interface Message {
  id: string;
  sequence: number;
  sender_id: string;
  content: string;
}
export interface MessagePage {
  messages: Message[];
  cursor: number;
  session_status: string;
  participants: Participant[];
}
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfter: number,
  ) {
    super(message);
  }
}
function sessionEndpoint(owner: Owner | null, path: string): string {
  return `/api/v1/${owner?.account ? "owner/agent-sessions" : "sessions"}${owner ? `/${encodeURIComponent(owner.session)}` : ""}${path}`;
}

function requestHeaders(
  owner: Owner | null,
  requestId: string,
  body: unknown,
): Headers {
  const headers = new Headers({ "X-Request-ID": requestId });
  if (owner?.account) { if (body !== undefined && owner.csrfToken) headers.set("X-CSRF-Token", owner.csrfToken); }
  else if (owner) headers.set("Authorization", `Bearer ${owner.token}`);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return headers;
}

function responseDetails(
  response: Response,
  method: string,
  endpoint: string,
  requestId: string,
): string {
  const id = response.headers.get("X-Request-ID") || requestId;
  return `${method} ${endpoint.split("?")[0]} → HTTP ${response.status}; request ${id}`;
}

async function parseResponse<T>(
  response: Response,
  details: string,
): Promise<T> {
  if (
    !response.headers
      .get("Content-Type")
      ?.toLowerCase()
      .includes("application/json")
  ) {
    throw new ApiError(
      response.status,
      `API proxy error: expected JSON, received a non-JSON response (${details}). Check the Next.js and Express server logs.`,
      5,
    );
  }
  let value;
  try {
    value = await response.json();
  } catch {
    throw new ApiError(
      response.status,
      `Invalid JSON from API (${details}). Check relay and proxy logs.`,
      5,
    );
  }
  if (!response.ok)
    throw new ApiError(
      response.status,
      `${value.error?.code || response.status}: ${value.error?.message || "Request failed"} (${details})`,
      Number(response.headers.get("Retry-After")) || 5,
    );
  return value as T;
}

export async function api<T>(
  owner: Owner | null,
  path = "",
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const endpoint = sessionEndpoint(owner, path);
  const requestId = crypto.randomUUID();
  const response = await fetch(endpoint, {
    method,
    signal,
    cache: "no-store",
    headers: requestHeaders(owner, requestId, body),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return parseResponse<T>(
    response,
    responseDetails(response, method, endpoint, requestId),
  );
}

export interface CreatedSession {
  session_id: string;
  owner_token: string;
  invite_id: string;
  invite_url: string;
}
export const createSession = (capacity: number) =>
  api<CreatedSession>(null, "", "POST", { max_participants: capacity });
export const getRoom = (owner: Owner, signal?: AbortSignal) =>
  api<Room>(owner, "", "GET", undefined, signal);
export const readMessages = (
  owner: Owner,
  cursor: number,
  signal?: AbortSignal,
) =>
  api<MessagePage>(
    owner,
    `/messages?after=${cursor}&wait=${owner.account ? 20 : 60}`,
    "GET",
    undefined,
    signal,
  );
export const sendMessage = (owner: Owner, content: string) =>
  api(owner, "/messages", "POST", { content });
export const createInvite = (owner: Owner) =>
  api<{ invite_id: string; invite_url: string }>(owner, "/invites", "POST", {});
export const closeSession = (owner: Owner) => api(owner, "/close", "POST", {});
export const revokeParticipant = (owner: Owner, id: string) =>
  api(owner, `/participants/${encodeURIComponent(id)}`, "DELETE");
export const revokeInvite = (owner: Owner, id: string) =>
  api(owner, `/invites/${encodeURIComponent(id)}`, "DELETE");
export function invitationText(invite: string) {
  return `Join this rendezvous: ${invite}\nFetch ${invite.split("#")[0]} with an ordinary HTTP GET for the full participation instructions (curl is fine; no browser needed). Keep the full invitation above, including its #fragment, for joining. Follow the returned instructions to coordinate on my task.`;
}
