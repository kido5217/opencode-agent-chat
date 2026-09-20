#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { lstatSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { defaultChatDir } from "./core/options.ts";
import { historyCount, openQuestions, readAllMessages, readMessages } from "./core/protocol.ts";
import { sanitize } from "./core/render.ts";
import { chatFilePath, isValidSessionId, openChatReadonly } from "./core/storage.ts";
import type { Message } from "./core/types.ts";
import { clock, messageIdWidth, renderMessage, renderTranscript } from "./core/view.ts";

const USAGE = "usage: agent-chat [view] [<session-id|path>] [--dir <chatDir>] [--follow]";
const LIVE_DIVIDER = "──── live ────";
const POLL_MS = 1000;
const READ_PAGE = 100;
const NAME_COLUMN = 26;

interface CliArgs {
  target: string | null;
  dir: string | null;
  follow: boolean;
  help: boolean;
}

function fail(message: string): never {
  console.error(`agent-chat: ${sanitize(message)}`);
  process.exit(1);
}

function failUsage(prefix: string): never {
  console.error(`agent-chat: ${sanitize(prefix)}`);
  console.error(USAGE);
  process.exit(1);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function lastActivity(db: Database): number | null {
  const row = db.query("SELECT MAX(created_at) AS t FROM messages").get() as { t: number | null } | null;
  return row?.t ?? null;
}

function parseArgs(argv: string[]): CliArgs {
  const parsed: CliArgs = { target: null, dir: null, follow: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--follow") {
      parsed.follow = true;
      continue;
    }
    if (arg === "--dir") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) failUsage("--dir needs a chat directory");
      parsed.dir = value;
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "view" && parsed.target === null) continue;
    if (arg.startsWith("-")) failUsage(`unknown option ${arg}`);
    if (parsed.target !== null) failUsage(`unexpected argument ${arg}`);
    parsed.target = arg;
  }
  return parsed;
}

function resolveChatPath(target: string, chatDir: string): string {
  if (isValidSessionId(target)) return chatFilePath(chatDir, target);
  const path = resolve(target);
  const base = resolve(chatDir);
  if (dirname(path) !== base) {
    throw new Error(`refusing ${target}: an explicit path must sit directly in the chat directory ${base}`);
  }
  return path;
}

function listChats(dir: string): void {
  const base = resolve(dir);
  let files: string[] = [];
  try {
    files = readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".db"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    console.log(`no chats in ${sanitize(base)}`);
    return;
  }
  if (files.length === 0) {
    console.log(`no chats in ${sanitize(base)}`);
    return;
  }
  console.log(`chats in ${sanitize(base)}`);
  console.log("");
  for (const file of files) {
    const path = join(base, file);
    const session = file.slice(0, -".db".length);
    let db: Database | null = null;
    try {
      db = openChatReadonly(path);
      const count = historyCount(db);
      const last = lastActivity(db);
      const open = openQuestions(db).length;
      const when = last === null ? "-" : clock(last);
      console.log(
        `  ${sanitize(session).padEnd(NAME_COLUMN)} ${String(count).padStart(4)} messages   last ${when}   open questions ${open}`,
      );
    } catch (err) {
      console.log(`  ${sanitize(session).padEnd(NAME_COLUMN)} unreadable: ${sanitize(errorText(err))}`);
    } finally {
      db?.close();
    }
  }
}

function followChat(db: Database, startId: number, idWidth: number): void {
  let lastId = startId;
  let dividerShown = false;

  const appendNew = (): void => {
    for (;;) {
      const batch = readMessages(db, { since: lastId, limit: READ_PAGE });
      if (batch.length === 0) return;
      if (!dividerShown) {
        console.log(LIVE_DIVIDER);
        dividerShown = true;
      }
      for (const message of batch) {
        console.log(renderMessage(message, idWidth));
        lastId = message.id;
      }
      if (batch.length < READ_PAGE) return;
    }
  };

  const timer = setInterval(() => {
    try {
      appendNew();
    } catch (err) {
      console.log(`agent-chat: follow read failed: ${sanitize(errorText(err))}`);
    }
  }, POLL_MS);

  const stop = (): void => {
    clearInterval(timer);
    db.close();
    process.exit(0);
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const chatDir = args.dir ?? defaultChatDir();

  if (args.target === null) {
    if (args.follow) failUsage("--follow needs a chat (give a session id or path)");
    listChats(chatDir);
    return;
  }

  const target = args.target;
  const resolved = resolve(target);
  if (isDirectory(resolved)) {
    if (args.follow) failUsage("--follow needs a chat (give a session id or path), not a directory");
    listChats(resolved);
    return;
  }

  const path = resolveChatPath(target, chatDir);
  if (!exists(path)) {
    console.log(`no chat file at ${sanitize(path)}`);
    process.exitCode = 1;
    return;
  }

  const session = basename(path).replace(/\.(db|sqlite)$/i, "");
  let db: Database;
  try {
    db = openChatReadonly(path);
  } catch (err) {
    fail(`cannot read ${path}: ${errorText(err)}`);
  }

  let messages: Message[];
  let open: number;
  try {
    messages = readAllMessages(db);
    open = openQuestions(db).length;
  } catch (err) {
    fail(`cannot read ${path}: ${errorText(err)}`);
  }

  console.log(renderTranscript(messages, open, session));

  if (args.follow) {
    const last = messages[messages.length - 1];
    followChat(db, last === undefined ? 0 : last.id, messageIdWidth(messages));
    return;
  }
  db.close();
}

if (import.meta.main) {
  try {
    main();
  } catch (err) {
    fail(errorText(err));
  }
}
