import type { Database } from "bun:sqlite";

export const SCHEMA_VERSION = 1;

const MIGRATIONS: readonly string[] = [
  `
CREATE TABLE messages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_type    TEXT NOT NULL,
  sender_name    TEXT NOT NULL,
  sender_session TEXT,
  kind           TEXT NOT NULL,
  to_name        TEXT,
  in_reply_to    INTEGER REFERENCES messages(id),
  body           TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_messages_to ON messages(to_name);
CREATE TABLE cursors (
  agent_session TEXT PRIMARY KEY,
  agent_name    TEXT NOT NULL,
  last_read_id  INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);
`,
];

export function migrate(db: Database): void {
  const row = db.query("PRAGMA user_version").get() as { user_version: number } | null;
  const current = row?.user_version ?? 0;
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `agent-chat: chat database schema version ${current} is newer than this build supports (${SCHEMA_VERSION})`,
    );
  }
  for (let version = current + 1; version <= SCHEMA_VERSION; version++) {
    const sql = MIGRATIONS[version - 1];
    if (sql === undefined) throw new Error(`agent-chat: missing migration for schema version ${version}`);
    db.transaction(() => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version}`);
    }).immediate();
  }
}
