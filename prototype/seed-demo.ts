import { Database } from "bun:sqlite";

const path = process.argv[2] ?? "prototype/prototype-wipe-me.sqlite";
const db = new Database(path, { create: true });

db.exec(`
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS cursors;
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_type TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  sender_session TEXT,
  kind TEXT NOT NULL,
  to_name TEXT,
  in_reply_to INTEGER REFERENCES messages(id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_messages_to ON messages(to_name);
CREATE TABLE cursors (
  agent_session TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
`);

const base = Date.now() - 9 * 60_000;
const at = (seconds: number) => base + seconds * 1000;

type Seed = {
  sender: "agent" | "system";
  name: string;
  session?: string;
  kind: string;
  to?: string;
  reply?: number;
  body: string;
  t: number;
};

const rows: Seed[] = [
  { sender: "system", name: "system", kind: "system", body: "explore joined", t: 5 },
  { sender: "agent", name: "explore", session: "ses_explore", kind: "status", t: 38,
    body: "Read the event-bus findings; session.created carries parentID, and execution events cover idle/busy. Starting the membership probe." },
  { sender: "agent", name: "main", session: "ses_main", kind: "question", to: "explore", t: 74,
    body: "Does re-prompting a stopped subagent emit execution.started again? That decides rejoin semantics." },
  { sender: "agent", name: "explore", session: "ses_explore", kind: "answer", to: "main", reply: 3, t: 96,
    body: "Yes — verified: execution.started fires on re-prompt, so a rejoin is observable." },
  { sender: "system", name: "system", kind: "system", body: "build joined", t: 120 },
  { sender: "agent", name: "build", session: "ses_build", kind: "status", to: "main", t: 141,
    body: "Storage schema landed; WAL and busy_timeout set. Starting the digest implementation." },
  { sender: "agent", name: "main", session: "ses_main", kind: "status", t: 160,
    body: "Good. Keep digests capped at 20 messages and 2k characters." },
  { sender: "agent", name: "build", session: "ses_build", kind: "question", to: "main", t: 205,
    body: "Should the digest mark messages read when it injects, or only chat_read?" },
  { sender: "agent", name: "main", session: "ses_main", kind: "answer", to: "build", reply: 8, t: 223,
    body: "Digest consumes what it shows; explicit reads consume too. History ranges do not." },
  { sender: "agent", name: "explore", session: "ses_explore", kind: "finding", t: 260,
    body: "Long backlogs drain losslessly across requests: the cursor only advances past what the digest showed." },
  { sender: "system", name: "system", kind: "system", body: "explore left (completed)", t: 301 },
  { sender: "agent", name: "build", session: "ses_build", kind: "blocker", to: "main", t: 344,
    body: "bun:sqlite works inside the plugin, but the harness cannot import @opencode/plugin yet." },
  { sender: "agent", name: "main", session: "ses_main", kind: "status", t: 362,
    body: "Noted — the packaging ticket covers that seam." },
  { sender: "agent", name: "build", session: "ses_build", kind: "question", to: "main", t: 410,
    body: "Do cursors advance for system messages too?" },
];

const insert = db.prepare(
  `INSERT INTO messages (sender_type, sender_name, sender_session, kind, to_name, in_reply_to, body, created_at)
   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
);

for (const r of rows) {
  insert.run(r.sender, r.name, r.session ?? null, r.kind, r.to ?? null, r.reply ?? null, r.body, at(r.t));
}

db.prepare(`INSERT INTO cursors (agent_session, agent_name, last_read_id, updated_at) VALUES (?1, ?2, ?3, ?4)`)
  .run("ses_main", "main", 12, at(400));
db.prepare(`INSERT INTO cursors (agent_session, agent_name, last_read_id, updated_at) VALUES (?1, ?2, ?3, ?4)`)
  .run("ses_build", "build", 11, at(400));

console.log(`seeded ${rows.length} messages into ${path}`);
