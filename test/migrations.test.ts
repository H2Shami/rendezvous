import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { openDatabase } from "../src/db.js";
import { applyMigrations } from "../src/migrations.js";
import { owners, agents, sessions } from "../src/schema.js";
import { uuid } from "../src/validation.js";

test("Drizzle migrations apply once and serialize repeated startup", async () => {
  const db = await openDatabase({
    databaseUrl: process.env.TEST_DATABASE_URL,
    dataDir: "memory://",
  });
  try {
    const before = (
      await db.query("SELECT * FROM drizzle.__drizzle_migrations ORDER BY id")
    ).rows;
    assert.equal(before.length, 1);
    await Promise.all([applyMigrations(db), applyMigrations(db)]);
    assert.deepEqual(
      (await db.query("SELECT * FROM drizzle.__drizzle_migrations ORDER BY id"))
        .rows,
      before,
    );
    const tables = (
      await db.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname='public'",
      )
    ).rows;
    assert.equal(tables.length, 16);
    assert.ok(!tables.some((t) => t.tablename === "schema_migrations"));
  } finally {
    await db.close();
  }
});

test("typed builders and SQL escape hatch share commit and rollback boundaries", async () => {
  const db = await openDatabase({
    databaseUrl: process.env.TEST_DATABASE_URL,
    dataDir: "memory://",
  });
  const owner = uuid(),
    agent = uuid();
  try {
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.orm
          .insert(owners)
          .values({ id: owner, issuer: "rollback", subject: owner });
        assert.equal(
          (await tx.query("SELECT id FROM owners WHERE id=$1", [owner])).rows
            .length,
          1,
        );
        await tx.orm
          .insert(agents)
          .values({ id: agent, owner_id: owner, display_name: "test" });
        throw new Error("rollback marker");
      }),
      /rollback marker/,
    );
    assert.equal(
      (await db.orm.select().from(owners).where(eq(owners.id, owner))).length,
      0,
    );
    assert.equal(
      (await db.orm.select().from(agents).where(eq(agents.id, agent))).length,
      0,
    );
    await db.transaction(async (tx) => {
      await tx.orm
        .insert(owners)
        .values({ id: owner, issuer: "commit", subject: owner });
      await tx.query("UPDATE owners SET subject=$2 WHERE id=$1", [
        owner,
        "updated",
      ]);
    });
    const [row] = await db.orm
      .select()
      .from(owners)
      .where(eq(owners.id, owner));
    assert.equal(row.subject, "updated");
    assert.ok(row.created_at instanceof Date);
    await assert.rejects(
      db.orm
        .insert(sessions)
        .values({ id: uuid(), expires_at: new Date(), max_participants: 11 }),
    );
  } finally {
    await db.orm.delete(owners).where(eq(owners.id, owner));
    await db.close();
  }
});

test("legacy storage is rejected without modifying its contents", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rendezvous-legacy-rejected-"));
  let old = new PGlite(dir);
  await old.waitReady;
  await old.exec(
    "CREATE TABLE sessions(id integer); INSERT INTO sessions VALUES(42)",
  );
  await old.close();
  try {
    await assert.rejects(
      openDatabase({ dataDir: dir }),
      /Legacy database detected/,
    );
    old = new PGlite(dir);
    await old.waitReady;
    assert.deepEqual((await old.query("SELECT * FROM sessions")).rows, [
      { id: 42 },
    ]);
    assert.equal(
      (
        await old.query<{ ledger: string | null }>(
          "SELECT to_regclass('drizzle.__drizzle_migrations') AS ledger",
        )
      ).rows[0].ledger,
      null,
    );
    await old.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Drizzle rolls back failed DDL and does not mark the migration applied", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rendezvous-failed-migration-"));
  const client = new PGlite();
  await client.waitReady;
  try {
    await mkdir(join(dir, "meta"));
    await writeFile(
      join(dir, "meta/_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [
          {
            idx: 0,
            version: "7",
            when: 1,
            tag: "0000_failure",
            breakpoints: true,
          },
        ],
      }),
    );
    await writeFile(
      join(dir, "0000_failure.sql"),
      "CREATE TABLE failed_marker(id integer);\n--> statement-breakpoint\nSELECT * FROM nonexistent_table;",
    );
    await assert.rejects(migrate(drizzle(client), { migrationsFolder: dir }));
    assert.equal(
      (
        await client.query<{ marker: string | null }>(
          "SELECT to_regclass('failed_marker') AS marker",
        )
      ).rows[0].marker,
      null,
    );
    assert.equal(
      (await client.query("SELECT * FROM drizzle.__drizzle_migrations")).rows
        .length,
      0,
    );
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
