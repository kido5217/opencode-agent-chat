import { describe, expect, test } from "bun:test";
import { FULL_COMMAND, WINDOW_SIZE, windowTranscript } from "../src/core/window.ts";
import type { Message } from "../src/core/types.ts";
import { headerLine, messageIdWidth, renderMessage, renderTranscript } from "../src/core/view.ts";

const ROOT = "ses_root";

function message(id: number, over: Partial<Message> = {}): Message {
  return {
    id,
    sender_type: "agent",
    sender_name: "main",
    sender_session: "ses_x",
    kind: "status",
    to_name: null,
    in_reply_to: null,
    body: `message ${id}`,
    created_at: id,
    ...over,
  };
}

function systemMessage(id: number, body: string): Message {
  return message(id, { sender_type: "system", sender_name: "system", sender_session: null, kind: "system", body });
}

function chat(n: number): Message[] {
  return Array.from({ length: n }, (_, i) => message(i + 1));
}

describe("windowTranscript", () => {
  test("keeps the full transcript without an indicator at the window size", () => {
    const messages = chat(WINDOW_SIZE);
    const result = windowTranscript(ROOT, messages, 0);
    expect(result.truncated).toBe(false);
    expect(result.total).toBe(WINDOW_SIZE);
    expect(result.label).toBe(`agent-chat transcript for ${ROOT}`);
    expect(result.text).toBe(renderTranscript(messages, 0, ROOT));
  });

  test("keeps the full transcript without an indicator below the window size", () => {
    const messages = chat(3);
    const result = windowTranscript(ROOT, messages, 1);
    expect(result.truncated).toBe(false);
    expect(result.total).toBe(3);
    expect(result.label).toBe(`agent-chat transcript for ${ROOT}`);
    expect(result.text).toBe(renderTranscript(messages, 1, ROOT));
  });

  test("keeps an empty chat as a header-only full transcript", () => {
    const result = windowTranscript(ROOT, [], 0);
    expect(result.truncated).toBe(false);
    expect(result.total).toBe(0);
    expect(result.text).toBe(headerLine(ROOT, [], 0));
  });

  test("windows to the last 10 messages and adds the indicator above the window size", () => {
    const messages = chat(12);
    const result = windowTranscript(ROOT, messages, 0);
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(12);
    expect(result.label).toBe(`agent-chat transcript for ${ROOT} · showing last 10 of 12 · ${FULL_COMMAND}`);
    const idWidth = messageIdWidth(messages);
    const expected = [
      headerLine(ROOT, messages, 0),
      ...messages.slice(-WINDOW_SIZE).map((m) => renderMessage(m, idWidth)),
    ].join("\n");
    expect(result.text).toBe(expected);
    const lines = result.text.split("\n");
    for (const line of renderMessage(messages[0]!, idWidth).split("\n")) expect(lines).not.toContain(line);
    for (const line of renderMessage(messages[1]!, idWidth).split("\n")) expect(lines).not.toContain(line);
  });

  test("counts system messages in the window and the total", () => {
    const messages = [
      ...chat(9),
      systemMessage(10, "explore-abc123 joined"),
      systemMessage(11, "explore-abc123 left (completed)"),
      message(12),
    ];
    const result = windowTranscript(ROOT, messages, 0);
    expect(result.total).toBe(12);
    expect(result.label).toContain(`showing last 10 of 12`);
    expect(result.text).toContain("explore-abc123 joined");
    expect(result.text).toContain("explore-abc123 left (completed)");
  });

  test("computes the header over the full message list, not just the window", () => {
    const messages = [
      message(1),
      systemMessage(2, "explore-abc123 joined"),
      ...chat(10).map((m, i) => message(i + 3)),
    ];
    const result = windowTranscript(ROOT, messages, 2);
    const header = result.text.split("\n")[0]!;
    expect(header).toBe(headerLine(ROOT, messages, 2));
    expect(header).toContain("explore-abc123");
  });

  test("cuts on message boundaries: an excluded wrapped message leaves no partial line", () => {
    const messages = [
      message(1, { body: "w".repeat(500) }),
      ...chat(10).map((m, i) => message(i + 2)),
      message(12, { body: "v".repeat(500) }),
    ];
    const result = windowTranscript(ROOT, messages, 0);
    const idWidth = messageIdWidth(messages);
    const lines = result.text.split("\n");
    const excluded = renderMessage(messages[0]!, idWidth).split("\n");
    expect(excluded.length).toBeGreaterThan(1);
    for (const line of excluded) expect(lines).not.toContain(line);
    const included = renderMessage(messages[11]!, idWidth).split("\n");
    expect(included.length).toBeGreaterThan(1);
    for (const line of included) expect(lines).toContain(line);
  });
});
