import { describe, expect, test } from "bun:test";
import { buildDigest, buildJoinBriefing } from "../src/core/digest.ts";
import { postMessage } from "../src/core/protocol.ts";
import { INJECTION_HEADER } from "../src/core/render.ts";
import { getCursor } from "../src/core/storage.ts";
import { seed, tempChat } from "./helpers.ts";

const limits = { maxMessages: 20, maxChars: 2000 };

describe("buildDigest", () => {
  test("no unread means no injection", () => {
    const { db } = tempChat();
    seed(db, 3);
    expect(buildJoinBriefing(db, "ses_test_0001", "main", limits, 1)).not.toBeNull();
    expect(buildDigest(db, "ses_test_0001", "main", limits, 2)).toBeNull();
  });

  test("drains 50 unread losslessly across three digests, no gaps or dupes", () => {
    const { db } = tempChat();
    seed(db, 50);
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      const d = buildDigest(db, "ses_test_0001", "main", limits, i + 1)!;
      seen.push(...[...d.text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
    }
    expect(seen).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(buildDigest(db, "ses_test_0001", "main", limits, 9)).toBeNull();
  });

  test("delivering the same digest twice is impossible (exactly-once)", () => {
    const { db } = tempChat();
    seed(db, 5);
    const first = buildDigest(db, "ses_test_0001", "main", limits, 1)!;
    expect(first.cursorTo).toBe(5);
    expect(buildDigest(db, "ses_test_0001", "main", limits, 2)).toBeNull();
  });

  test("the character cap stops at a line boundary and advances only past displayed ids", () => {
    const { db } = tempChat();
    seed(db, 6, (i) => "x".repeat(400));
    const d = buildDigest(db, "ses_test_0001", "main", { maxMessages: 20, maxChars: 1000 }, 1)!;
    const ids = [...d.text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
    expect(ids.length).toBeGreaterThanOrEqual(1);
    expect(ids.length).toBeLessThan(6);
    expect(d.cursorTo).toBe(ids.at(-1)!);
  });

  test("join briefing shows the last N of the history and parks the cursor at the latest id", () => {
    const { db } = tempChat();
    seed(db, 34);
    const d = buildJoinBriefing(db, "ses_test_0001", "main", limits, 1)!;
    expect(d.text).toContain("34 messages total");
    expect(d.text).toContain("showing the last 20");
    expect(d.cursorTo).toBe(34);
    expect(buildDigest(db, "ses_test_0001", "main", limits, 2)).toBeNull();
  });

  test("an empty chat injects nothing but still records the cursor", () => {
    const { db } = tempChat();
    expect(buildJoinBriefing(db, "ses_test_0001", "main", limits, 1)).toBeNull();
    expect(getCursor(db, "ses_test_0001")).not.toBeNull();
    expect(getCursor(db, "ses_test_0001")?.last_read_id).toBe(0);
    const m = postMessage(db, { senderName: "main", senderSession: "ses_test_0001", now: 2, maxBodyChars: 4000 }, { body: "hi" });
    const d = buildDigest(db, "ses_test_0001", "main", limits, 3)!;
    expect(d.text).toContain(`[${m.id}]`);
  });

  test("questions and blockers are flagged and open questions close", () => {
    const { db } = tempChat();
    const q = postMessage(db, { senderName: "explore", senderSession: "ses_e", now: 1, maxBodyChars: 4000 }, { body: "how?", kind: "question", to: "main" });
    const d = buildDigest(db, "ses_test_0001", "main", limits, 2)!;
    expect(d.text).toContain(`? [${q.id}] explore · question → main: how?`);
    expect(d.text).toContain(`Open questions: #${q.id} (explore)`);
  });
});

describe("delivery shape", () => {
  test("every injection opens with the header; digests carry no briefing line", () => {
    const briefing = tempChat();
    seed(briefing.db, 1);
    const b = buildJoinBriefing(briefing.db, "ses_test_0001", "main", limits, 1)!;
    expect(b.text.startsWith(`${INJECTION_HEADER}\n`)).toBe(true);
    expect(b.text).toContain("Join briefing:");

    const digest = tempChat();
    seed(digest.db, 2);
    const d = buildDigest(digest.db, "ses_test_0001", "main", limits, 1)!;
    expect(d.text.startsWith(`${INJECTION_HEADER}\n`)).toBe(true);
    expect(d.text).not.toContain("Join briefing:");
  });

  test("a single over-cap line is still delivered", () => {
    const { db } = tempChat();
    seed(db, 1, () => "x".repeat(400));
    const d = buildDigest(db, "ses_test_0001", "main", { maxMessages: 20, maxChars: 10 }, 1)!;
    expect(d.text).toContain("[1]");
    expect(d.cursorTo).toBe(1);
  });

  test("system messages are delivered like any other kind", () => {
    const { db } = tempChat();
    const m = postMessage(db, { senderName: "system", senderSession: null, senderType: "system", now: 1, maxBodyChars: 4000 }, { body: "explore joined", kind: "system" });
    const d = buildDigest(db, "ses_test_0001", "main", limits, 2)!;
    expect(d.text).toContain(`[${m.id}] system · system: explore joined`);
  });

  test("a blocker is flagged and an answer closes the question", () => {
    const { db } = tempChat();
    const q = postMessage(db, { senderName: "explore", senderSession: "ses_e", now: 1, maxBodyChars: 4000 }, { body: "how?", kind: "question", to: "main" });
    const b = postMessage(db, { senderName: "explore", senderSession: "ses_e", now: 2, maxBodyChars: 4000 }, { body: "stuck", kind: "blocker" });
    const first = buildDigest(db, "ses_test_0001", "main", limits, 3)!;
    expect(first.text).toContain(`! [${b.id}] explore · blocker: stuck`);
    expect(first.text).toContain(`Open questions: #${q.id} (explore)`);
    expect(first.cursorTo).toBe(b.id);

    const a = postMessage(db, { senderName: "main", senderSession: "ses_test_0001", now: 4, maxBodyChars: 4000 }, { body: "because", kind: "answer", in_reply_to: q.id });
    const second = buildDigest(db, "ses_test_0001", "main", limits, 5)!;
    expect(second.text).toContain(`[${a.id}]`);
    expect(second.text).toContain("Open questions: none");
  });
});
