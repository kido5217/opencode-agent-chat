import type { Database } from "bun:sqlite";
import { isKind, type Kind, type Message } from "./types.ts";

export type ChatErrorCode =
  | "body_too_long"
  | "to_too_long"
  | "unknown_kind"
  | "unknown_reply"
  | "too_many_posts"
  | "duplicate_post";

export class ChatError extends Error {
  code: ChatErrorCode;

  constructor(code: ChatErrorCode, message: string) {
    super(message);
    this.name = "ChatError";
    this.code = code;
  }
}

export interface PostMeta {
  senderName: string;
  senderSession: string | null;
  senderType?: "agent" | "system";
  now: number;
  maxBodyChars: number;
}

export interface PostInput {
  body: string;
  kind?: Kind;
  to?: string | null;
  in_reply_to?: number | null;
}

export interface ReadQuery {
  since?: number;
  before?: number;
  ids?: number[];
  kind?: Kind;
  openOnly?: boolean;
  limit?: number;
}

export const MESSAGE_COLUMNS = "id, sender_type, sender_name, sender_session, kind, to_name, in_reply_to, body, created_at";
const OPEN_QUESTION_PREDICATE =
  "kind = 'question' AND NOT EXISTS (SELECT 1 FROM messages a WHERE a.in_reply_to = messages.id AND a.kind = 'answer')";

const DEFAULT_READ_LIMIT = 20;
const MAX_READ_LIMIT = 100;

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || Number.isNaN(limit)) return DEFAULT_READ_LIMIT;
  return Math.min(MAX_READ_LIMIT, Math.max(1, Math.trunc(limit)));
}

export function postMessage(db: Database, meta: PostMeta, post: PostInput): Message {
  const body = post.body;
  if (typeof body !== "string") {
    throw new ChatError("body_too_long", `agent-chat: body must be a string (maxBodyChars ${meta.maxBodyChars})`);
  }
  if (body.length > meta.maxBodyChars) {
    throw new ChatError(
      "body_too_long",
      `agent-chat: body is ${body.length} characters; maxBodyChars is ${meta.maxBodyChars}`,
    );
  }

  const kind = post.kind ?? "status";
  if (!isKind(kind) || (kind === "system" && meta.senderType !== "system")) {
    throw new ChatError("unknown_kind", `agent-chat: ${JSON.stringify(kind)} is not a kind this sender may post`);
  }

  const inReplyTo = post.in_reply_to ?? null;
  if (inReplyTo !== null && !messageExists(db, inReplyTo)) {
    throw new ChatError("unknown_reply", `agent-chat: cannot reply to missing message #${inReplyTo}`);
  }

  const info = db
    .query(
      `INSERT INTO messages (sender_type, sender_name, sender_session, kind, to_name, in_reply_to, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(meta.senderType ?? "agent", meta.senderName, meta.senderSession, kind, post.to ?? null, inReplyTo, body, meta.now);
  const created = getMessage(db, Number(info.lastInsertRowid));
  if (created === null) throw new Error("agent-chat: inserted message could not be read back");
  return created;
}

export function readMessages(db: Database, q: ReadQuery = {}): Message[] {
  const where: string[] = [];
  const params: (number | string)[] = [];

  if (q.ids !== undefined) {
    if (q.ids.length === 0) return [];
    where.push(`id IN (${q.ids.map(() => "?").join(", ")})`);
    params.push(...q.ids);
  }
  if (q.since !== undefined) {
    where.push("id > ?");
    params.push(q.since);
  }
  if (q.before !== undefined) {
    where.push("id < ?");
    params.push(q.before);
  }
  if (q.kind !== undefined) {
    where.push("kind = ?");
    params.push(q.kind);
  }
  if (q.openOnly === true) {
    where.push(OPEN_QUESTION_PREDICATE);
  }

  const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
  return db
    .query(`SELECT ${MESSAGE_COLUMNS} FROM messages${clause} ORDER BY id ASC LIMIT ?`)
    .all(...params, clampLimit(q.limit)) as Message[];
}

export function readAllMessages(db: Database): Message[] {
  const messages: Message[] = [];
  let cursor = 0;
  for (;;) {
    const page = readMessages(db, { since: cursor, limit: 100 });
    if (page.length === 0) return messages;
    messages.push(...page);
    if (page.length < 100) return messages;
    cursor = page[page.length - 1]?.id ?? cursor;
  }
}

export function unreadMessages(db: Database, lastReadId: number, limit: number): Message[] {
  return readMessages(db, { since: lastReadId, limit });
}

export function openQuestions(db: Database): Message[] {
  return db.query(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE ${OPEN_QUESTION_PREDICATE} ORDER BY id ASC`).all() as Message[];
}

export function messageExists(db: Database, id: number): boolean {
  const row = db.query("SELECT 1 AS found FROM messages WHERE id = ? LIMIT 1").get(id);
  return row != null;
}

export function getMessage(db: Database, id: number): Message | null {
  const row = db.query(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`).get(id) as Message | null | undefined;
  return row ?? null;
}

export function latestMessageId(db: Database): number {
  const row = db.query("SELECT COALESCE(MAX(id), 0) AS id FROM messages").get() as { id: number } | null | undefined;
  return row?.id ?? 0;
}

export function historyCount(db: Database): number {
  const row = db.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number } | null | undefined;
  return row?.n ?? 0;
}

interface RunState {
  count: number;
  lastBody: string | null;
  lastId: number;
}

function normalize(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}

export class RunGuard {
  private readonly maxPostsPerRun: number;
  private readonly runs = new Map<string, RunState>();

  constructor(maxPostsPerRun: number) {
    this.maxPostsPerRun = maxPostsPerRun;
  }

  begin(sessionID: string): void {
    this.runs.set(sessionID, { count: 0, lastBody: null, lastId: 0 });
  }

  end(sessionID: string): void {
    this.runs.delete(sessionID);
  }

  check(sessionID: string, body: string): void {
    const run = this.state(sessionID);
    if (run.count >= this.maxPostsPerRun) {
      throw new ChatError(
        "too_many_posts",
        `agent-chat: this run has posted ${run.count} messages (maxPostsPerRun ${this.maxPostsPerRun}); wrap up and finish your turn`,
      );
    }
    if (run.lastBody !== null && normalize(body) === run.lastBody) {
      throw new ChatError(
        "duplicate_post",
        `agent-chat: this body repeats your previous post (#${run.lastId}); say something new or wrap up`,
      );
    }
  }

  record(sessionID: string, body: string, messageID: number): void {
    const run = this.state(sessionID);
    run.count += 1;
    run.lastBody = normalize(body);
    run.lastId = messageID;
  }

  private state(sessionID: string): RunState {
    let run = this.runs.get(sessionID);
    if (run === undefined) {
      run = { count: 0, lastBody: null, lastId: 0 };
      this.runs.set(sessionID, run);
    }
    return run;
  }
}
