import { describe, expect, test } from "bun:test";
import { AGENT_KINDS, ALL_KINDS, isKind, type Kind } from "../src/core/types.ts";

describe("kind vocabulary", () => {
  test("agent kinds are the six protocol kinds in order", () => {
    expect([...AGENT_KINDS]).toEqual(["status", "finding", "question", "answer", "blocker", "handoff"]);
  });
  test("system is the seventh kind", () => {
    expect(ALL_KINDS).toHaveLength(7);
    expect(ALL_KINDS.at(-1)).toBe("system");
  });
  test("isKind narrows known kinds and rejects the rest", () => {
    expect(isKind("question")).toBe(true);
    expect(isKind("system")).toBe(true);
    expect(isKind("nope")).toBe(false);
  });
  test("isKind narrows an unknown value to Kind at compile time", () => {
    const value: string = "blocker";
    if (!isKind(value)) throw new Error("expected isKind to accept a protocol kind");
    const kind: Kind = value;
    expect(kind).toBe("blocker");
  });
});
