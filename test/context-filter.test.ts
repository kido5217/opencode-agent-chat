import { describe, expect, test } from "bun:test";
import { ContextFilter } from "../src/core/context-filter.ts";

describe("context filter", () => {
  test("hides only the noted ids", () => {
    const filter = new ContextFilter();
    filter.note("a");
    expect(filter.has("a")).toBe(true);
    expect(filter.has("b")).toBe(false);
    expect(filter.filter([{ id: "a" }, { id: "b" }])).toEqual([{ id: "b" }]);
  });

  test("ignores empty ids and evicts the oldest past the cap", () => {
    const filter = new ContextFilter(2);
    filter.note("");
    filter.note("a");
    filter.note("b");
    filter.note("c");
    expect(filter.has("a")).toBe(false);
    expect(filter.has("b")).toBe(true);
    expect(filter.has("c")).toBe(true);
  });

  test("noting an id again refreshes it against the cap", () => {
    const filter = new ContextFilter(2);
    filter.note("a");
    filter.note("b");
    filter.note("a");
    filter.note("c");
    expect(filter.has("a")).toBe(true);
    expect(filter.has("b")).toBe(false);
  });
});
