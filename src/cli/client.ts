import type { Message, MessagePage } from "../types.js";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter: number,
  ) {
    super(
      `Rendezvous returned HTTP ${status}. ${status === 401 || status === 403 ? "Check that the invitation or saved credential is valid and has not been revoked." : status === 429 ? "Rate limit reached; wait before trying again." : status === 409 ? "The room may be full or closed; check it in the dashboard." : "Check the server URL and room status."}`,
    );
  }
}

export function parseInvitation(value: string) {
  const url = new URL(value);
  const match = /^\/join\/([a-f0-9-]{36})$/.exec(url.pathname);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (!local && url.protocol !== "https:") ||
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    !match ||
    !url.hash.slice(1)
  ) {
    throw new Error(
      "Use a complete HTTPS /join/UUID#secret invitation (HTTP allowed on loopback).",
    );
  }
  return { origin: url.origin, roomId: match[1], secret: url.hash.slice(1) };
}

export class RoomClient {
  constructor(
    readonly origin: string,
    readonly roomId: string,
    private token = "",
  ) {}

  private async request<T>(
    path: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(
      `${this.origin}/api/v1/sessions/${this.roomId}${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(75_000)]),
        headers: {
          "content-type": "application/json",
          "ngrok-skip-browser-warning": "1",
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    if (!response.ok)
      throw new HttpError(
        response.status,
        Number(response.headers.get("retry-after")) || 1,
      );
    return (await response.json()) as T;
  }

  async inspect(signal: AbortSignal) {
    const result = await this.request<{ status: string; expires_at: string }>('', signal);
    if (!['WAITING', 'ACTIVE', 'CLOSED', 'EXPIRED'].includes(result.status) || !Number.isFinite(Date.parse(result.expires_at)))
      throw new Error('Server returned an invalid room status.');
    return result;
  }
  join(secret: string, displayName: string, signal: AbortSignal) {
    return this.request<{ participant_id: string; participant_token: string }>(
      "/join",
      signal,
      { invite_token: secret, display_name: displayName },
    );
  }
  read(after: number, wait: number, signal: AbortSignal) {
    return this.request<MessagePage>(
      `/messages?after=${after}&wait=${wait}`,
      signal,
    );
  }
  send(content: string, signal: AbortSignal) {
    return this.request<Message>("/messages", signal, { content });
  }
}

export function serverOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid --server URL. Example: http://localhost:3000");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (!local && url.protocol !== "https:") ||
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "--server must be an HTTPS origin (HTTP allowed on loopback), without a path or credentials.",
    );
  }
  return url.origin;
}

export interface CreatedRoom {
  session_id: string;
  invite_url: string;
  owner_url: string;
  expires_at: string;
}

export async function createRoom(
  origin: string,
  participants: number,
  ttl: number | undefined,
  signal: AbortSignal,
): Promise<CreatedRoom> {
  const response = await fetch(`${origin}/api/v1/sessions`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    headers: {
      "content-type": "application/json",
      "ngrok-skip-browser-warning": "1",
    },
    body: JSON.stringify({
      max_participants: participants,
      invite_max_uses: participants,
      ...(ttl === undefined ? {} : { ttl_seconds: ttl }),
    }),
  });
  if (!response.ok)
    throw new HttpError(
      response.status,
      Number(response.headers.get("retry-after")) || 1,
    );
  const result = await response.json();
  if (
    typeof result.session_id !== "string" ||
    typeof result.invite_url !== "string" ||
    typeof result.owner_url !== "string" ||
    typeof result.expires_at !== "string"
  ) {
    throw new Error("Server returned an invalid room response.");
  }
  // Use the selected origin, including a frontend proxy, even if the server advertises an internal URL.
  const invitation = parseInvitation(
    `${origin}/join/${result.session_id}#${new URL(result.invite_url).hash.slice(1)}`,
  );
  const owner = new URL(result.owner_url);
  if (!owner.hash) throw new Error("Server returned an invalid owner URL.");
  return {
    session_id: invitation.roomId,
    invite_url: `${origin}/join/${invitation.roomId}#${invitation.secret}`,
    owner_url: `${origin}/${owner.hash}`,
    expires_at: result.expires_at,
  };
}
