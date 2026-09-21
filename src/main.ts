import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { openDatabase, type Database } from "./db.js";
import { loadSecrets, security } from "./security.js";
import { Service } from "./service.js";
import { createApplication } from "./server.js";
import { WorkOSProvider, ownerAuthConfig } from "./owners/provider.js";
import lockfile from "proper-lockfile";

async function main() {
  const port = Number(process.env.PORT || 3000);
  const publicUrl = (
    process.env.NGROK_DOMAIN ||
    process.env.PUBLIC_URL ||
    `http://localhost:${port}`
  ).replace(/\/$/, "");
  const url = new URL(publicUrl);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("PUBLIC_URL must be an origin.");
  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new Error("Non-loopback PUBLIC_URL must use HTTPS.");
  const dataDir = resolve(process.env.DATA_DIR || ".data");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const release = await lockfile
    .lock(dataDir, {
      lockfilePath: resolve(dataDir, "server.lock"),
      stale: 120000,
      update: 10000,
      retries: 0,
    })
    .catch((err) => {
      if ((err as NodeJS.ErrnoException).code === "ELOCKED")
        throw new Error(
          "SERVER_ALREADY_RUNNING: Another process owns this data directory. It may be outside your sandbox. Retry the HTTP request with approved network access; do not remove database lock files.",
        );
      throw err;
    });
  let db: Database | undefined,
    app: ReturnType<typeof createApplication> | undefined;
  try {
    const secrets = process.env.TOKEN_PEPPER
      ? { pepper: process.env.TOKEN_PEPPER }
      : await loadSecrets(resolve(dataDir, "server-secrets.json"));
    db = await openDatabase({
      databaseUrl: process.env.DATABASE_URL,
      dataDir: resolve(dataDir, "postgres"),
    });
    const numeric = (name: string, fallback: number) => {
      const value = Number(process.env[name] ?? fallback);
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error(`${name} must be a positive integer.`);
      return value;
    };
    const service = new Service(db, security(secrets), {
      ttlSeconds: numeric("SESSION_TTL_SECONDS", 86400),
      maxTtlSeconds: numeric("MAX_TTL_SECONDS", 604800),
      sessionsPerHour: numeric("SESSIONS_PER_HOUR", 10),
      joinsPerHour: numeric("JOINS_PER_HOUR", 30),
      retentionSeconds: numeric("RETENTION_SECONDS", 86400),
      messagesPerMinute: numeric("MESSAGES_PER_MINUTE", 60),
      messageBudget: numeric("MESSAGE_BUDGET", 10000),
    });
    const ownerConfig = ownerAuthConfig(process.env, publicUrl);
    app = createApplication(service, {
      ownerProvider: ownerConfig ? new WorkOSProvider(ownerConfig, service.auth.digest(`owner:workos-cookie:${ownerConfig.clientId}`)) : undefined,
      publicUrl,
      frontendOrigin: process.env.FRONTEND_URL || process.env.NGROK_DOMAIN,
      trustProxy: process.env.TRUST_PROXY || false,
    });
    await app.listen(port, process.env.HOST || "127.0.0.1");
    console.log(`Rendezvous listening at ${publicUrl}`);
    let stopping = false;
    async function stop() {
      if (stopping) return;
      stopping = true;
      await app?.close();
      await db?.close();
      await release();
    }
    process.on("SIGINT", () => void stop());
    process.on("SIGTERM", () => void stop());
  } catch (e) {
    await app?.close().catch(() => {});
    await db?.close();
    await release();
    throw e;
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
