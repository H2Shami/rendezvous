export const LOCAL_TOKEN_PEPPER = "rendezvous-local-only-pepper-do-not-use-in-hosted-environments";

export function storageConfig(env: NodeJS.ProcessEnv) {
  const databaseUrl = env.DATABASE_URL?.trim();
  const pepper = env.TOKEN_PEPPER;
  // Disk-backed storage is an explicit isolated-test fixture, never a dev fallback.
  const embeddedTest = env.NODE_ENV === "test" && !databaseUrl && !!env.DATA_DIR;
  if (!databaseUrl && !embeddedTest) {
    throw new Error("DATABASE_URL is required. Start Docker PostgreSQL with npm run data:up; DATA_DIR database storage is deprecated.");
  }
  if (!embeddedTest && (!pepper || pepper.length < 32)) {
    throw new Error("TOKEN_PEPPER must contain at least 32 characters. Copy the local-only starter value from .env.example for local development.");
  }
  if (env.NODE_ENV === "production" && pepper === LOCAL_TOKEN_PEPPER) {
    throw new Error("The local-only TOKEN_PEPPER must be replaced with a private random secret in production.");
  }
  return { databaseUrl, pepper, embeddedTest };
}
