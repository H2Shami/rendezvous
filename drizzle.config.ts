import { defineConfig } from "drizzle-kit";

// Generation is offline. Runtime migration supports both PostgreSQL and PGlite.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
});
