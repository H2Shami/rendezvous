import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

export const requestContext = new AsyncLocalStorage<{ request_id: string }>();
export function safeOrigin(value?: string) {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return "[invalid]";
  }
}

// Never log raw URLs, query strings, headers, bodies or arbitrary path segments.
export function safePath(url: string) {
  const path = url.split(/[?#]/)[0];
  if (/^\/api\/v1\/owner\/(config|login|callback|me|logout)$/.test(path)) return path;
  const normalized = path.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    ":id",
  );
  if (/^\/api\/v1\/agent-sessions(?:\/:id(?:\/(?:accept|reject|messages|close|stopped))?)?$/.test(normalized)) return normalized;
  if (/^\/api\/v1\/owner\/agents(?:\/:id(?:\/(?:disable|credentials)(?:\/:id(?:\/rotate)?)?)?)?$/.test(normalized)) return normalized;
  if (/^\/api\/v1\/owner\/agents\/:id\/peers(?:\/:id)?$/.test(normalized)) return normalized;
  if (/^\/api\/v1\/agents\/me(?:\/receiver(?:\/(?:heartbeat|release|inbox))?)?$/.test(path)) return path;
  return /^(\/|\/health|\/style\.css|\/protocol\/v1|\/\.well-known\/agent-rendezvous|\/join\/:id|\/api\/v1\/sessions(?:\/:id(?:\/(?:join|messages|leave|close|invites|participants)(?:\/:id)?)?)?)$/.test(
    normalized,
  )
    ? normalized
    : path.startsWith("/_next/")
      ? "/_next/*"
      : "[unmatched]";
}
export function requestLogging(
  emit: (event: string, fields: Record<string, unknown>) => void,
): RequestHandler {
  return (req, res, next) => {
    const supplied = req.get("x-request-id");
    const request_id =
      supplied &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        supplied,
      )
        ? supplied
        : randomUUID();
    res.locals.request_id = request_id;
    res.setHeader("X-Request-ID", request_id);
    const started = performance.now();
    const fields = {
      request_id,
      method: req.method,
      path: safePath(req.url),
      origin: safeOrigin(req.get("origin")),
    };
    requestContext.run({ request_id }, () => {
      emit("http.started", fields);
      res.once("close", () =>
        emit(res.writableFinished ? "http.completed" : "http.disconnected", {
          ...fields,
          status: res.writableFinished ? res.statusCode : undefined,
          duration_ms: Math.round(performance.now() - started),
          response_type: String(res.getHeader("Content-Type") || "").split(
            ";",
          )[0],
          error_code: res.locals.error_code,
        }),
      );
      next();
    });
  };
}
