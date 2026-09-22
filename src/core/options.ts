import { homedir } from "node:os";
import { join } from "node:path";

export interface ChatOptions {
  chatDir: string;
  maxBodyChars: number;
  maxPostsPerRun: number;
  digestMaxMessages: number;
  digestMaxChars: number;
  debug: boolean;
}

export const DEFAULTS = {
  maxBodyChars: 4000,
  maxPostsPerRun: 25,
  digestMaxMessages: 20,
  digestMaxChars: 2000,
  debug: false,
} as const;

export function dataBaseDir(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const xdg = env.XDG_DATA_HOME;
  return xdg && xdg.length > 0 ? xdg : join(home, ".local", "share");
}

export function defaultChatDir(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  return join(dataBaseDir(env, home), "opencode", "chats");
}

type Warn = (msg: string) => void;

const KNOWN_KEYS = new Set([
  "chatDir",
  "maxBodyChars",
  "maxPostsPerRun",
  "digestMaxMessages",
  "digestMaxChars",
  "debug",
]);

function positiveInt(raw: unknown, key: string, fallback: number, warn: Warn): number {
  if (raw === undefined) return fallback;
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1) return raw;
  warn(`agent-chat: invalid option "${key}" (expected an integer >= 1); using ${fallback}`);
  return fallback;
}

export function parseOptions(raw: unknown, warn: Warn = () => {}): ChatOptions {
  const fallbackDir = defaultChatDir();
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    warn("agent-chat: options must be an object; using defaults");
    return { chatDir: fallbackDir, ...DEFAULTS };
  }
  const input = raw as Record<string, unknown>;

  let chatDir = fallbackDir;
  if (input.chatDir !== undefined) {
    if (typeof input.chatDir === "string" && input.chatDir.length > 0) {
      chatDir = input.chatDir;
    } else {
      warn(`agent-chat: invalid option "chatDir" (expected a non-empty string); using ${fallbackDir}`);
    }
  }

  let debug: boolean = DEFAULTS.debug;
  if (input.debug !== undefined) {
    if (typeof input.debug === "boolean") {
      debug = input.debug;
    } else {
      warn(`agent-chat: invalid option "debug" (expected a boolean); using ${DEFAULTS.debug}`);
    }
  }

  for (const key of Object.keys(input)) {
    if (!KNOWN_KEYS.has(key)) warn(`agent-chat: unknown option "${key}" ignored`);
  }

  return {
    chatDir,
    maxBodyChars: positiveInt(input.maxBodyChars, "maxBodyChars", DEFAULTS.maxBodyChars, warn),
    maxPostsPerRun: positiveInt(input.maxPostsPerRun, "maxPostsPerRun", DEFAULTS.maxPostsPerRun, warn),
    digestMaxMessages: positiveInt(input.digestMaxMessages, "digestMaxMessages", DEFAULTS.digestMaxMessages, warn),
    digestMaxChars: positiveInt(input.digestMaxChars, "digestMaxChars", DEFAULTS.digestMaxChars, warn),
    debug,
  };
}
