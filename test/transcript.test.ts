import { describe, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { readAllMessages } from "../src/core/protocol.ts";
import { transcriptFor } from "../src/core/transcript.ts";
import { renderTranscript } from "../src/core/view.ts";
import { seed, tempChat, tempDir } from "./helpers.ts";

describe("readAllMessages", () => {
  test("returns every message in id order across page boundaries", () => {
    const { db } = tempChat();
    seed(db, 250);
    const messages = readAllMessages(db);
    expect(messages.length).toBe(250);
    expect(messages[0]?.id).toBe(1);
    expect(messages[249]?.id).toBe(250);
    db.close();
  });
});

describe("renderTranscript", () => {
  test("renders the header followed by every message", () => {
    const { db } = tempChat("ses_test_0002");
    seed(db, 2);
    const text = renderTranscript(readAllMessages(db), 0, "ses_test_0002");
    const lines = text.split("\n");
    expect(lines[0]).toBe("chat ses_test_0002 · main · 0 open");
    expect(lines.length).toBe(3);
    db.close();
  });
});

describe("transcriptFor", () => {
  test("returns the rendered transcript for a session chat file", () => {
    const { dir, db } = tempChat("ses_test_0003");
    seed(db, 2, (i) => `hello ${i}`);
    db.close();
    const text = transcriptFor(dir, "ses_test_0003");
    expect(text).toContain("chat ses_test_0003 · main · 0 open");
    expect(text).toContain("hello 1");
    expect(text).toContain("hello 2");
  });

  test("returns null for an unknown session and an invalid id", () => {
    const dir = tempDir();
    expect(transcriptFor(dir, "ses_absent")).toBeNull();
    expect(transcriptFor(dir, "../escape")).toBeNull();
  });

  test("refuses a symlinked chat file", () => {
    const dir = tempDir();
    const { dir: other, db } = tempChat("ses_test_0004");
    db.close();
    symlinkSync(join(other, "ses_test_0004.db"), join(dir, "ses_test_0004.db"));
    expect(() => transcriptFor(dir, "ses_test_0004")).toThrow(/symlinked/);
  });
});
