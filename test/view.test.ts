import { describe, expect, test } from "bun:test";
import type { Message } from "../src/core/types.ts";
import { chunks, headerLine, liveParticipants, messageIdWidth, renderMessage } from "../src/core/view.ts";

function message(over: Partial<Message>): Message {
  return {
    id: 1,
    sender_type: "agent",
    sender_name: "main",
    sender_session: "ses_x",
    kind: "status",
    to_name: null,
    in_reply_to: null,
    body: "hi",
    created_at: 0,
    ...over,
  } as Message;
}

describe("viewer rendering", () => {
  test("a long unbroken token wraps without exceeding the line width", () => {
    const rendered = renderMessage(message({ body: "x".repeat(450) }), 1);
    for (const line of rendered.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
  });

  test("long sender and recipient fields are capped so the line stays within 100 columns", () => {
    const rendered = renderMessage(message({ id: 8, sender_name: "s".repeat(60), to_name: "z".repeat(99) }), 1);
    for (const line of rendered.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
    expect(rendered).toContain("→ z");
  });

  test("a normal message renders unchanged", () => {
    expect(renderMessage(message({ body: "hello" }), 1)).toMatch(/^\d{2}:\d{2}:\d{2} \[1\] ● main hello$/);
    expect(renderMessage(message({ body: "hello", to_name: "builder" }), 1)).toMatch(
      /^\d{2}:\d{2}:\d{2} \[1\] ● main → builder hello$/,
    );
  });

  test("chunks hard-breaks an over-width word and wraps the rest", () => {
    const lines = chunks(`ab ${"c".repeat(45)} tail`, 20);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(20);
    expect(lines.join("")).toContain("c".repeat(45));
    expect(lines.join("")).toContain("tail");
  });
});

describe("viewer header", () => {
  test("live participants start with main and follow join/leave rows", () => {
    const messages = [
      message({ kind: "system", body: "explore joined", id: 1 }),
      message({ kind: "status", body: "hello", id: 2 }),
      message({ kind: "system", body: "builder joined", id: 3 }),
      message({ kind: "system", body: "explore left (completed)", id: 4 }),
    ];
    expect(liveParticipants(messages)).toEqual(["main", "builder"]);
  });

  test("the header carries the session, live names, and the open count", () => {
    expect(headerLine("ses_abc", [message({ kind: "system", body: "explore joined" })], 3)).toBe(
      "chat ses_abc · main, explore · 3 open",
    );
  });

  test("the id column width follows the last message; an empty chat uses one", () => {
    expect(messageIdWidth([])).toBe(1);
    expect(messageIdWidth([message({ id: 9 })])).toBe(1);
    expect(messageIdWidth([message({ id: 120 })])).toBe(3);
  });
});
