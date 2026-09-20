import { describe, expect, test } from "bun:test";
import { defaultChatDir, parseOptions } from "../src/core/options.ts";

describe("parseOptions", () => {
  test("empty input yields the documented defaults", () => {
    expect(parseOptions({})).toEqual({
      chatDir: defaultChatDir(),
      maxBodyChars: 4000,
      maxPostsPerRun: 25,
      digestMaxMessages: 20,
      digestMaxChars: 2000,
      debug: false,
    });
  });
  test("valid values pass through", () => {
    const o = parseOptions({ chatDir: "/tmp/x", maxBodyChars: 10, maxPostsPerRun: 3, digestMaxMessages: 4, digestMaxChars: 50, debug: true });
    expect(o).toEqual({ chatDir: "/tmp/x", maxBodyChars: 10, maxPostsPerRun: 3, digestMaxMessages: 4, digestMaxChars: 50, debug: true });
  });
  test("invalid values warn and fall back", () => {
    const warnings: string[] = [];
    const o = parseOptions({ maxBodyChars: 0, debug: "yes" }, (m) => warnings.push(m));
    expect(o.maxBodyChars).toBe(4000);
    expect(o.debug).toBe(false);
    expect(warnings).toHaveLength(2);
  });
  test("unknown keys warn and are ignored", () => {
    const warnings: string[] = [];
    expect(parseOptions({ nope: 1 }, (m) => warnings.push(m))).toEqual(parseOptions({}));
    expect(warnings[0]).toContain("nope");
  });
  test("non-object input is all defaults with one warning", () => {
    const warnings: string[] = [];
    expect(parseOptions("junk", (m) => warnings.push(m)).maxBodyChars).toBe(4000);
    expect(warnings).toHaveLength(1);
  });
});

describe("defaultChatDir", () => {
  test("uses XDG_DATA_HOME when set", () => {
    expect(defaultChatDir({ XDG_DATA_HOME: "/xdg" }, "/home/u")).toBe("/xdg/opencode/chats");
  });
  test("falls back to ~/.local/share", () => {
    expect(defaultChatDir({}, "/home/u")).toBe("/home/u/.local/share/opencode/chats");
  });
});
