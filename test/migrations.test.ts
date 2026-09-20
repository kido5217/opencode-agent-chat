import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, SCHEMA_VERSION } from "../src/core/migrations.ts";
import { tempDir } from "./helpers.ts";
import { join } from "node:path";

test("fresh database gets schema version 1 and both tables", () => {
  const db = new Database(join(tempDir(), "fresh.db"));
  migrate(db);
  expect((db.query("PRAGMA user_version").get() as any).user_version).toBe(SCHEMA_VERSION);
  const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as any[];
  expect(tables.map((t) => t.name)).toContain("messages");
  expect(tables.map((t) => t.name)).toContain("cursors");
  db.close();
});

test("migrate is idempotent", () => {
  const db = new Database(join(tempDir(), "twice.db"));
  migrate(db); migrate(db);
  expect((db.query("PRAGMA user_version").get() as any).user_version).toBe(SCHEMA_VERSION);
  db.close();
});

test("a newer schema than this build supports is refused", () => {
  const db = new Database(join(tempDir(), "newer.db"));
  db.exec("PRAGMA user_version = 999");
  expect(() => migrate(db)).toThrow();
  db.close();
});
