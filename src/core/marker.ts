import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataBaseDir } from "./options.ts";

/**
 * Marker published by the server-side plugin (which receives the config entry's
 * options) for the TUI entry (whose host context passes no options as of opencode
 * v2.0.12), so both entries agree on the chat directory.
 */
export function chatDirMarkerPath(env: Record<string, string | undefined> = process.env): string {
  return join(dataBaseDir(env), "opencode", "agent-chat.json");
}

export function writeChatDirMarker(
  chatDir: string,
  env: Record<string, string | undefined> = process.env,
): void {
  const path = chatDirMarkerPath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ version: 1, chatDir })}\n`);
}

export function readChatDirMarker(
  env: Record<string, string | undefined> = process.env,
): string | null {
  let raw: string;
  try {
    raw = readFileSync(chatDirMarkerPath(env), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const { version, chatDir } = parsed as { version?: unknown; chatDir?: unknown };
    if (version !== 1 || typeof chatDir !== "string" || chatDir.length === 0) return null;
    return chatDir;
  } catch {
    return null;
  }
}
