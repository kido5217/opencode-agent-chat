import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openChat } from "../src/core/storage.ts";

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "agent-chat-test-"));
}

export function tempChat(sessionID = "ses_test_0001"): { dir: string; db: Database } {
  const dir = tempDir();
  return { dir, db: openChat(dir, sessionID) };
}
