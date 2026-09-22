import { describe, expect, test } from "bun:test";
import {
  ChatError,
  getMessage,
  historyCount,
  latestMessageId,
  messageExists,
  openQuestions,
  postMessage,
  readMessages,
} from "../src/core/protocol.ts";
import { tempChat, seed } from "./helpers.ts";

const meta = (now = 1) => ({ senderName: "main", senderSession: "ses_test_0001", now, maxBodyChars: 4000 });

describe("reads", () => {
  test("readMessages filters, orders oldest-first, and clamps the limit", () => {
    const { db } = tempChat();
    const ids = seed(db, 30);
    expect(readMessages(db, {}).map((m) => m.id)).toEqual(ids.slice(0, 20));
    expect(readMessages(db, { limit: 500 }).length).toBe(30);
    expect(readMessages(db, { since: 25 }).map((m) => m.id)).toEqual([26, 27, 28, 29, 30]);
    expect(readMessages(db, { before: 3 }).map((m) => m.id)).toEqual([1, 2]);
    expect(readMessages(db, { ids: [5, 7] }).map((m) => m.id)).toEqual([5, 7]);
  });
  test("an empty ids list matches nothing and a zero limit clamps to one", () => {
    const { db } = tempChat();
    seed(db, 5);
    expect(readMessages(db, { ids: [] })).toEqual([]);
    expect(readMessages(db, { limit: 0 }).map((m) => m.id)).toEqual([1]);
  });
  test("a non-integer limit truncates instead of falling back", () => {
    const { db } = tempChat();
    const ids = seed(db, 30);
    expect(readMessages(db, { limit: 5.5 }).map((m) => m.id)).toEqual(ids.slice(0, 5));
    expect(readMessages(db, { limit: Number.NaN }).length).toBe(20);
  });
  test("readMessages filters by kind and combines it with since", () => {
    const { db } = tempChat();
    postMessage(db, meta(), { body: "q1", kind: "question" });
    postMessage(db, meta(2), { body: "s1" });
    postMessage(db, meta(3), { body: "q2", kind: "question" });
    expect(readMessages(db, { kind: "question" }).map((m) => m.body)).toEqual(["q1", "q2"]);
    expect(readMessages(db, { kind: "question", since: 1 }).map((m) => m.body)).toEqual(["q2"]);
  });
  test("open questions are derived, and an answer closes one", () => {
    const { db } = tempChat();
    const q = postMessage(db, meta(), { body: "why?", kind: "question" });
    postMessage(db, meta(2), { body: "another?", kind: "question" });
    expect(openQuestions(db).map((m) => m.id)).toEqual([q.id, q.id + 1]);
    postMessage(db, meta(3), { body: "because", kind: "answer", in_reply_to: q.id });
    expect(openQuestions(db).map((m) => m.id)).toEqual([q.id + 1]);
    postMessage(db, meta(4), { body: "self-close", kind: "answer", in_reply_to: q.id + 1 });
    expect(openQuestions(db)).toEqual([]);
  });
  test("only an answer closes a question, and openOnly agrees", () => {
    const { db } = tempChat();
    const q = postMessage(db, meta(), { body: "why?", kind: "question" });
    postMessage(db, meta(2), { body: "not an answer", kind: "status", in_reply_to: q.id });
    expect(openQuestions(db).map((m) => m.id)).toEqual([q.id]);
    expect(readMessages(db, { openOnly: true }).map((m) => m.id)).toEqual([q.id]);
    postMessage(db, meta(3), { body: "because", kind: "answer", in_reply_to: q.id });
    expect(readMessages(db, { openOnly: true })).toEqual([]);
  });
});

describe("counts and lookups", () => {
  test("empty chat has no latest id or history", () => {
    const { db } = tempChat();
    expect(latestMessageId(db)).toBe(0);
    expect(historyCount(db)).toBe(0);
    expect(getMessage(db, 1)).toBeNull();
    expect(messageExists(db, 1)).toBe(false);
  });
  test("latestMessageId and historyCount track appends", () => {
    const { db } = tempChat();
    seed(db, 3);
    expect(latestMessageId(db)).toBe(3);
    expect(historyCount(db)).toBe(3);
    expect(messageExists(db, 3)).toBe(true);
    expect(messageExists(db, 4)).toBe(false);
  });
});

describe("ChatError", () => {
  test("carries its code and name", () => {
    const e = new ChatError("unknown_kind", "nope");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ChatError");
    expect(e.code).toBe("unknown_kind");
    expect(e.message).toBe("nope");
  });
});
