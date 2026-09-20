import { Database } from "bun:sqlite";
import { appendFileSync, chmodSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { migrate } from "./migrations.ts";

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface CursorRow {
  agent_session: string;
  agent_name: string;
  last_read_id: number;
  updated_at: number;
}

export function isValidSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id);
}

export function ensureChatDir(chatDir: string, warn: (msg: string) => void = () => {}): void {
  mkdirSync(chatDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(chatDir, 0o700);
  } catch (err) {
    warn(`agent-chat: could not chmod ${chatDir} to 0700: ${String(err)}`);
  }
}

export function chatFilePath(chatDir: string, sessionID: string): string {
  if (!isValidSessionId(sessionID)) {
    throw new Error(`agent-chat: invalid session id ${JSON.stringify(sessionID)}`);
  }
  const base = resolve(chatDir);
  const path = resolve(chatDir, `${sessionID}.db`);
  if (dirname(path) !== base) {
    throw new Error(`agent-chat: session id escapes the chat directory: ${JSON.stringify(sessionID)}`);
  }
  return path;
}

export function openChat(
  chatDir: string,
  sessionID: string,
  warn: (msg: string) => void = () => {},
): Database {
  ensureChatDir(chatDir, warn);
  const path = chatFilePath(chatDir, sessionID);
  let stat: Stats | null = null;
  try {
    stat = lstatSync(path);
  } catch {
    stat = null;
  }
  if (stat !== null) {
    if (stat.isSymbolicLink()) {
      throw new Error(`agent-chat: refusing symlinked chat file ${path}`);
    }
    if (!stat.isFile()) {
      throw new Error(`agent-chat: refusing non-regular chat file ${path}`);
    }
  } else {
    writeFileSync(path, "", { mode: 0o600 });
  }
  chmodSync(path, 0o600);
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  try {
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

export function debugLog(chatDir: string, line: string): void {
  try {
    mkdirSync(chatDir, { recursive: true, mode: 0o700 });
    const path = join(chatDir, "debug.log");
    appendFileSync(path, `[${new Date().toISOString()}] ${line}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  } catch {}
}

export function getCursor(db: Database, sessionID: string): CursorRow | null {
  const row = db
    .query("SELECT agent_session, agent_name, last_read_id, updated_at FROM cursors WHERE agent_session = ?")
    .get(sessionID) as CursorRow | null;
  return row ?? null;
}

export function setCursor(db: Database, sessionID: string, name: string, lastReadId: number, now: number): void {
  db.query(
    `INSERT INTO cursors (agent_session, agent_name, last_read_id, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(agent_session) DO UPDATE SET
       agent_name = excluded.agent_name,
       last_read_id = excluded.last_read_id,
       updated_at = excluded.updated_at`,
  ).run(sessionID, name, lastReadId, now);
}

export function messageCount(db: Database): number {
  const row = db.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number };
  return row.n;
}
