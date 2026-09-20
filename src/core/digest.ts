import type { Database } from "bun:sqlite";
import { historyCount, latestMessageId, openQuestions, unreadMessages } from "./protocol.ts";
import { INJECTION_HEADER, renderMessageLine, renderMessages, renderOpenQuestions } from "./render.ts";
import { getCursor, setCursor } from "./storage.ts";
import type { Message } from "./types.ts";

export interface Delivery {
  text: string;
  cursorTo: number;
}

const MESSAGE_COLUMNS = "id, sender_type, sender_name, sender_session, kind, to_name, in_reply_to, body, created_at";

function fitMessages(messages: Message[], maxChars: number): { kept: Message[]; cursorTo: number } {
  const kept: Message[] = [];
  let used = 0;
  for (const m of messages) {
    const line = renderMessageLine(m);
    if (kept.length > 0 && used + 1 + line.length > maxChars) break;
    used += (kept.length > 0 ? 1 : 0) + line.length;
    kept.push(m);
  }
  return { kept, cursorTo: kept.at(-1)?.id ?? 0 };
}

function compose(body: string, heading: string | null, questions: Message[]): string {
  const lines = [INJECTION_HEADER];
  if (heading !== null) lines.push(heading);
  lines.push(body, renderOpenQuestions(questions));
  return lines.join("\n");
}

export function buildJoinBriefing(
  db: Database,
  sessionID: string,
  name: string,
  limits: { maxMessages: number; maxChars: number },
  now: number,
): Delivery | null {
  return db.transaction(() => {
    const latest = latestMessageId(db);
    const total = historyCount(db);
    const messages = db
      .query(
        `SELECT ${MESSAGE_COLUMNS} FROM (
           SELECT ${MESSAGE_COLUMNS} FROM messages ORDER BY id DESC LIMIT ?
         ) ORDER BY id ASC`,
      )
      .all(limits.maxMessages) as Message[];
    const questions = openQuestions(db);
    const existing = getCursor(db, sessionID);
    setCursor(db, sessionID, existing?.agent_name ?? name, latest, now);
    if (messages.length === 0) return null;
    const heading = `Join briefing: ${total} messages total; showing the last ${messages.length}.`;
    return { text: compose(renderMessages(messages), heading, questions), cursorTo: latest };
  })();
}

export function buildDigest(
  db: Database,
  sessionID: string,
  name: string,
  limits: { maxMessages: number; maxChars: number },
  now: number,
): Delivery | null {
  return db.transaction(() => {
    const cursor = getCursor(db, sessionID);
    const unread = unreadMessages(db, cursor?.last_read_id ?? 0, limits.maxMessages);
    if (unread.length === 0) return null;
    const { kept, cursorTo } = fitMessages(unread, limits.maxChars);
    const questions = openQuestions(db);
    setCursor(db, sessionID, cursor?.agent_name ?? name, cursorTo, now);
    return { text: compose(renderMessages(kept), null, questions), cursorTo };
  })();
}
