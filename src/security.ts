import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { requireThat, secret } from "./validation.js";

export async function loadSecrets(path: string): Promise<{ pepper: string }> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const data = { pepper: secret() };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(data), { mode: 0o600, flag: "wx" });
  return data;
}

export function security({ pepper }: { pepper: string }) {
  const digest = (raw: string) =>
    createHmac("sha256", pepper).update(raw).digest("hex");
  const matches = (raw: unknown, stored: unknown) => {
    if (typeof raw !== "string" || typeof stored !== "string") return false;
    const a = Buffer.from(digest(raw), "hex"),
      b = Buffer.from(stored, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  };
  return { digest, matches };
}

export type Security = ReturnType<typeof security>;

export class RateLimiter {
  buckets = new Map<string, { count: number; until: number }>();
  constructor(private clock = Date.now) {}
  take(key: string, limit: number, interval: number) {
    const now = this.clock();
    if (this.buckets.size > 10000) this.sweep();
    const old = this.buckets.get(key);
    const b =
      old && old.until > now ? old : { count: 0, until: now + interval };
    requireThat(
      b.count < limit,
      "RATE_LIMITED",
      "Rate limit exceeded. Retry after the current window.",
      429,
    );
    requireThat(
      this.buckets.size < 50000 || this.buckets.has(key),
      "RATE_LIMITED",
      "Service is busy.",
      429,
    );
    b.count++;
    this.buckets.set(key, b);
  }
  sweep() {
    for (const [key, value] of this.buckets)
      if (value.until <= this.clock()) this.buckets.delete(key);
  }
}
