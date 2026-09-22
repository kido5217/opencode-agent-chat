import { describe, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { readAllMessages } from "../src/core/protocol.ts";
import { panelTranscriptFor, transcriptFor, tuiTranscriptFor } from "../src/core/transcript.ts";
import { headerLine, messageIdWidth, renderMessage, renderTranscript } from "../src/core/view.ts";
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

describe("tuiTranscriptFor", () => {
  test("returns the windowed transcript with the expand hint above the window size", () => {
    const { dir, db } = tempChat("ses_test_0005");
    seed(db, 12, (i) => `hello ${i}`);
    const messages = readAllMessages(db);
    const idWidth = messageIdWidth(messages);
    const expected = [
      headerLine("ses_test_0005", messages, 0),
      ...messages.slice(-10).map((m) => renderMessage(m, idWidth)),
    ].join("\n");
    db.close();
    const result = tuiTranscriptFor(dir, "ses_test_0005");
    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(true);
    expect(result!.total).toBe(12);
    expect(result!.label).toBe("agent-chat transcript for ses_test_0005 · showing last 10 of 12 · /agent-chat full");
    expect(result!.text).toBe(expected);
    const lines = result!.text.split("\n");
    expect(lines[0]).toBe("chat ses_test_0005 · main · 0 open");
    expect(lines[lines.length - 1]).toContain("hello 12");
  });

  test("returns the full transcript without the expand hint at or below the window size", () => {
    const { dir, db } = tempChat("ses_test_0006");
    seed(db, 3, (i) => `hello ${i}`);
    const messages = readAllMessages(db);
    db.close();
    const result = tuiTranscriptFor(dir, "ses_test_0006");
    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(false);
    expect(result!.total).toBe(3);
    expect(result!.label).toBe("agent-chat transcript for ses_test_0006");
    expect(result!.text).toBe(renderTranscript(messages, 0, "ses_test_0006"));
  });

  test("returns null for an unknown session and an invalid id", () => {
    const dir = tempDir();
    expect(tuiTranscriptFor(dir, "ses_absent")).toBeNull();
    expect(tuiTranscriptFor(dir, "../escape")).toBeNull();
  });
});

describe("panelTranscriptFor", () => {
  test("returns the full transcript text and the message count", () => {
    const { dir, db } = tempChat("ses_test_0007");
    seed(db, 12, (i) => `hello ${i}`);
    const messages = readAllMessages(db);
    db.close();
    const result = panelTranscriptFor(dir, "ses_test_0007");
    expect(result).not.toBeNull();
    expect(result!.total).toBe(12);
    expect(result!.text).toBe(renderTranscript(messages, 0, "ses_test_0007"));
  });

  test("returns null for an unknown session and an invalid id", () => {
    const dir = tempDir();
    expect(panelTranscriptFor(dir, "ses_absent")).toBeNull();
    expect(panelTranscriptFor(dir, "../escape")).toBeNull();
  });
});
