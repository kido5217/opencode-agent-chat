import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { dataBaseDir, defaultChatDir } from "../src/core/options.ts";
import { chatDirMarkerPath, readChatDirMarker, writeChatDirMarker } from "../src/core/marker.ts";

function sandbox(): { env: Record<string, string | undefined>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "agent-chat-marker-"));
  return { env: { XDG_DATA_HOME: dir }, dir };
}

describe("dataBaseDir", () => {
  test("uses XDG_DATA_HOME when set", () => {
    expect(dataBaseDir({ XDG_DATA_HOME: "/xdg" }, "/home/u")).toBe("/xdg");
  });

  test("falls back to ~/.local/share when XDG_DATA_HOME is unset or empty", () => {
    expect(dataBaseDir({}, "/home/u")).toBe(join("/home/u", ".local", "share"));
    expect(dataBaseDir({ XDG_DATA_HOME: "" }, "/home/u")).toBe(join("/home/u", ".local", "share"));
  });

  test("defaultChatDir is the opencode/chats subdir of the data base", () => {
    expect(defaultChatDir({ XDG_DATA_HOME: "/xdg" }, "/home/u")).toBe(join("/xdg", "opencode", "chats"));
  });
});

describe("chat dir marker", () => {
  test("lives at <data base>/opencode/agent-chat.json", () => {
    expect(chatDirMarkerPath({ XDG_DATA_HOME: "/xdg" })).toBe(join("/xdg", "opencode", "agent-chat.json"));
  });

  test("write then read round-trips the chat dir", () => {
    const { env, dir } = sandbox();
    try {
      writeChatDirMarker("/custom/chats", env);
      expect(readChatDirMarker(env)).toBe("/custom/chats");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("read returns null when the marker is missing", () => {
    const { env, dir } = sandbox();
    try {
      expect(readChatDirMarker(env)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("read returns null for a corrupt or wrong-shaped marker", () => {
    const { env, dir } = sandbox();
    try {
      const path = chatDirMarkerPath(env);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "not json");
      expect(readChatDirMarker(env)).toBeNull();
      writeFileSync(path, JSON.stringify({ version: 99, chatDir: "/x" }) + "\n");
      expect(readChatDirMarker(env)).toBeNull();
      writeFileSync(path, JSON.stringify({ version: 1 }) + "\n");
      expect(readChatDirMarker(env)).toBeNull();
      writeFileSync(path, JSON.stringify({ version: 1, chatDir: "" }) + "\n");
      expect(readChatDirMarker(env)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("overwrite replaces the previous chat dir", () => {
    const { env, dir } = sandbox();
    try {
      writeChatDirMarker("/first", env);
      writeChatDirMarker("/second", env);
      expect(readChatDirMarker(env)).toBe("/second");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
