import { randomBytes, randomUUID } from "node:crypto";

export const uuid = () => randomUUID();
export const secret = () => randomBytes(32).toString("base64url");
export class HttpError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function requireThat(
  condition: unknown,
  code: string,
  message: string,
  status = 400,
): asserts condition {
  if (!condition) throw new HttpError(code, message, status);
}
export function integer(
  value: unknown,
  min: number,
  max: number,
  name: string,
): number {
  requireThat(
    typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= min &&
      value <= max,
    "INVALID_REQUEST",
    `${name} must be an integer from ${min} to ${max}.`,
  );
  return value;
}
export function exactFields(
  body: unknown,
  fields: string[],
): asserts body is Record<string, unknown> {
  requireThat(
    body && typeof body === "object" && !Array.isArray(body),
    "INVALID_REQUEST",
    "Expected a JSON object.",
  );
  requireThat(
    Object.keys(body).every((k) => fields.includes(k)),
    "INVALID_REQUEST",
    "Unknown fields.",
  );
}
export function metadata(value: unknown): Record<string, unknown> {
  const data = value ?? {};
  requireThat(
    data &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      Buffer.byteLength(JSON.stringify(data)) <= 2048,
    "INVALID_METADATA",
    "metadata must be an object of at most 2 KB.",
  );
  return data as Record<string, unknown>;
}
