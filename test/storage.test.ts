import { describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chatFilePath, debugLog, ensureChatDir, isValidSessionId, openChat, getCursor, setCursor } from "../src/core/storage.ts";
import { tempDir } from "./helpers.ts";

describe("session ids", () => {
  test("accepts opencode-style ids, rejects traversal and empties", () => {
    expect(isValidSessionId("ses_f413c71a4ffe")).toBe(true);
    expect(isValidSessionId("")).toBe(false);
    expect(isValidSessionId("../etc/passwd")).toBe(false);
    expect(isValidSessionId("a/b")).toBe(false);
    expect(isValidSessionId("x".repeat(129))).toBe(false);
  });
  test("chatFilePath stays a direct child of chatDir", () => {
    const dir = tempDir();
    expect(chatFilePath(dir, "ses_abc")).toBe(join(dir, "ses_abc.db"));
    expect(() => chatFilePath(dir, "..evil")).toThrow();
  });
});

describe("sandbox and open", () => {
  test("ensureChatDir creates 0700 and repairs loose modes", () => {
    const dir = join(tempDir(), "chats");
    ensureChatDir(dir);
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
    chmodSync(dir, 0o755);
    ensureChatDir(dir);
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
  });
  test("openChat pre-creates 0600 so WAL inherits it, and applies pragmas", () => {
    const dir = tempDir();
    const db = openChat(dir, "ses_abc");
    expect(lstatSync(join(dir, "ses_abc.db")).mode & 0o777).toBe(0o600);
    db.exec("INSERT INTO messages (sender_type, sender_name, kind, body, created_at) VALUES ('system','system','system','x',1)");
    for (const suffix of ["", "-wal"]) {
      const p = join(dir, `ses_abc.db${suffix}`);
      expect(lstatSync(p).mode & 0o777).toBe(0o600);
    }
    expect((db.query("PRAGMA journal_mode").get() as any).journal_mode).toBe("wal");
    expect((db.query("PRAGMA busy_timeout").get() as any).timeout).toBe(5000);
    expect((db.query("PRAGMA synchronous").get() as any).synchronous).toBe(1);
    expect((db.query("PRAGMA foreign_keys").get() as any).foreign_keys).toBe(1);
    db.close();
  });
  test("a symlinked chat file is refused", () => {
    const dir = tempDir();
    ensureChatDir(dir);
    writeFileSync(join(dir, "real.db"), "");
    symlinkSync(join(dir, "real.db"), join(dir, "ses_link.db"));
    expect(() => openChat(dir, "ses_link")).toThrow(/symlink/i);
  });
});

describe("cursors", () => {
  test("get returns null until set; set upserts", () => {
    const db = openChat(tempDir(), "ses_abc");
    expect(getCursor(db, "ses_abc")).toBeNull();
    setCursor(db, "ses_abc", "main", 7, 100);
    expect(getCursor(db, "ses_abc")?.last_read_id).toBe(7);
    setCursor(db, "ses_abc", "main", 9, 200);
    expect(getCursor(db, "ses_abc")?.last_read_id).toBe(9);
    db.close();
  });
});

describe("debugLog", () => {
  test("creates and appends a 0600 file", () => {
    const dir = tempDir();
    debugLog(dir, "first");
    debugLog(dir, "second");
    const p = join(dir, "debug.log");
    expect(lstatSync(p).mode & 0o777).toBe(0o600);
    expect(readFileSync(p, "utf8")).toContain("second");
  });
});
