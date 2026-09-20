import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { postMessage } from "../src/core/protocol.ts";
import { openChat } from "../src/core/storage.ts";

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "agent-chat-test-"));
}

export function tempChat(sessionID = "ses_test_0001"): { dir: string; db: Database } {
  const dir = tempDir();
  return { dir, db: openChat(dir, sessionID) };
}

export function seed(db: Database, count: number, body = (i: number) => `message ${i}`): number[] {
  const ids: number[] = [];
  for (let i = 1; i <= count; i++) {
    ids.push(postMessage(db, { senderName: "main", senderSession: "ses_test_0001", now: i, maxBodyChars: 4000 }, { body: body(i) }).id);
  }
  return ids;
}
