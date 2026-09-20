import { describe, expect, test } from "bun:test";
import {
  ChatError,
  RunGuard,
  getMessage,
  historyCount,
  latestMessageId,
  messageExists,
  openQuestions,
  postMessage,
  readMessages,
  unreadMessages,
} from "../src/core/protocol.ts";
import { tempChat, seed } from "./helpers.ts";

const meta = (now = 1) => ({ senderName: "main", senderSession: "ses_test_0001", now, maxBodyChars: 4000 });

describe("postMessage", () => {
  test("appends a row with defaults and returns it", () => {
    const { db } = tempChat();
    const m = postMessage(db, meta(42), { body: "hello" });
    expect(m.id).toBe(1);
    expect(m).toMatchObject({ sender_type: "agent", sender_name: "main", kind: "status", to_name: null, in_reply_to: null, created_at: 42, body: "hello" });
  });
  test("stores to/in_reply_to and a non-default kind", () => {
    const { db } = tempChat();
    const first = postMessage(db, meta(), { body: "hello", to: "builder" });
    const reply = postMessage(db, meta(2), { body: "answer", kind: "answer", in_reply_to: first.id });
    expect(first.to_name).toBe("builder");
    expect(reply).toMatchObject({ kind: "answer", in_reply_to: first.id });
    expect(getMessage(db, reply.id)).toEqual(reply);
  });
  test("over-cap body is a hard error naming the limit", () => {
    const { db } = tempChat();
    try { postMessage(db, { ...meta(), maxBodyChars: 5 }, { body: "123456" }); expect.unreachable(); }
    catch (e) { expect(e).toBeInstanceOf(ChatError); expect((e as ChatError).code).toBe("body_too_long"); expect((e as Error).message).toContain("5"); }
  });
  test("a body exactly at the cap is accepted", () => {
    const { db } = tempChat();
    const m = postMessage(db, { ...meta(), maxBodyChars: 5 }, { body: "12345" });
    expect(m.body).toBe("12345");
  });
  test("unknown kinds and agent-posted system rows are rejected", () => {
    const { db } = tempChat();
    expect(() => postMessage(db, meta(), { body: "x", kind: "nope" as any })).toThrow(ChatError);
    expect(() => postMessage(db, meta(), { body: "x", kind: "system" })).toThrow(ChatError);
    try { postMessage(db, meta(), { body: "x", kind: "system" }); expect.unreachable(); } catch (e) { expect((e as ChatError).code).toBe("unknown_kind"); }
  });
  test("system sender may post system rows", () => {
    const { db } = tempChat();
    const m = postMessage(db, { senderName: "system", senderSession: null, senderType: "system", now: 1, maxBodyChars: 100 }, { body: "explore joined", kind: "system" });
    expect(m.sender_type).toBe("system");
  });
  test("replying to a missing message is rejected", () => {
    const { db } = tempChat();
    expect(() => postMessage(db, meta(), { body: "x", kind: "answer", in_reply_to: 99 })).toThrow(ChatError);
    try { postMessage(db, meta(), { body: "x", kind: "answer", in_reply_to: 99 }); expect.unreachable(); } catch (e) { expect((e as ChatError).code).toBe("unknown_reply"); }
  });
});

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
  test("unreadMessages returns strictly after the cursor", () => {
    const { db } = tempChat();
    seed(db, 5);
    expect(unreadMessages(db, 0, 20).map((m) => m.id)).toEqual([1, 2, 3, 4, 5]);
    expect(unreadMessages(db, 3, 20).map((m) => m.id)).toEqual([4, 5]);
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

describe("RunGuard", () => {
  test("allows maxPostsPerRun posts then asks the agent to wrap up", () => {
    const guard = new RunGuard(25);
    guard.begin("s1");
    for (let i = 0; i < 25; i++) { guard.check("s1", `m${i}`); guard.record("s1", `m${i}`, i + 1); }
    try { guard.check("s1", "one more"); expect.unreachable(); }
    catch (e) { expect((e as ChatError).code).toBe("too_many_posts"); expect((e as Error).message).toContain("wrap up"); }
  });
  test("a whitespace-identical consecutive post is rejected with the earlier id", () => {
    const guard = new RunGuard(25);
    guard.begin("s1");
    guard.check("s1", "hello  world"); guard.record("s1", "hello  world", 7);
    try { guard.check("s1", "hello world"); expect.unreachable(); }
    catch (e) { expect((e as ChatError).code).toBe("duplicate_post"); expect((e as Error).message).toContain("#7"); }
  });
  test("begin resets the budget and the duplicate memory", () => {
    const guard = new RunGuard(1);
    guard.begin("s1"); guard.check("s1", "x"); guard.record("s1", "x", 1);
    guard.begin("s1");
    guard.check("s1", "x");
  });
  test("sessions are tracked independently and a missed begin still enforces the cap", () => {
    const guard = new RunGuard(1);
    guard.begin("s1");
    guard.check("s1", "x"); guard.record("s1", "x", 1);
    guard.begin("s2");
    guard.check("s2", "x");
    expect(() => guard.check("s1", "y")).toThrow(ChatError);
    guard.check("lazy", "a"); guard.record("lazy", "a", 2);
    expect(() => guard.check("lazy", "b")).toThrow(ChatError);
  });
  test("end evicts the run so the next check starts fresh", () => {
    const guard = new RunGuard(1);
    guard.begin("s1");
    guard.check("s1", "x"); guard.record("s1", "x", 1);
    guard.end("s1");
    guard.check("s1", "y");
  });
});
