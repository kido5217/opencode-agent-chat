#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { lstatSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { defaultChatDir } from "./core/options.ts";
import { historyCount, openQuestions, readMessages } from "./core/protocol.ts";
import { sanitize } from "./core/render.ts";
import { chatFilePath, isValidSessionId } from "./core/storage.ts";
import type { Kind, Message } from "./core/types.ts";

const USAGE = "usage: agent-chat [view] [<session-id|path>] [--dir <chatDir>] [--follow]";
const LIVE_DIVIDER = "──── live ────";
const POLL_MS = 1000;
const READ_PAGE = 100;
const LINE_WIDTH = 100;
const MIN_BODY_WIDTH = 40;
const NAME_COLUMN = 26;
const GLYPHS: Record<Kind, string> = {
  status: "●",
  question: "?",
  answer: "✓",
  blocker: "!",
  finding: "★",
  handoff: "→",
  system: "→",
};

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

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clock(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
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

function openReadonly(path: string): Database {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`refusing symlinked chat file ${path}`);
  if (!stat.isFile()) throw new Error(`refusing non-regular chat file ${path}`);
  const db = new Database(path, { readonly: true });
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

function readAll(db: Database, since: number): Message[] {
  const messages: Message[] = [];
  let cursor = since;
  for (;;) {
    const page = readMessages(db, { since: cursor, limit: READ_PAGE });
    if (page.length === 0) return messages;
    messages.push(...page);
    if (page.length < READ_PAGE) return messages;
    cursor = page[page.length - 1]?.id ?? cursor;
  }
}

function liveParticipants(messages: Message[]): string[] {
  const live = new Set<string>(["main"]);
  for (const message of messages) {
    if (message.kind !== "system") continue;
    const body = message.body;
    if (body.endsWith(" joined")) {
      live.add(body.slice(0, -" joined".length));
    } else if (body.includes(" left")) {
      live.delete(body.slice(0, body.indexOf(" left")));
    }
  }
  return [...live];
}

function headerLine(session: string, messages: Message[], open: number): string {
  const names = liveParticipants(messages).map(sanitize).join(", ");
  return `chat ${sanitize(session)} · ${names} · ${open} open`;
}

function messageIdWidth(messages: Message[]): number {
  const last = messages[messages.length - 1];
  return last === undefined ? 1 : String(last.id).length;
}

function chunks(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line !== "" && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") lines.push(line);
  return lines.length === 0 ? [""] : lines;
}

function renderMessage(message: Message, idWidth: number): string {
  const head = `${clock(message.created_at)} [${String(message.id).padStart(idWidth)}]`;
  let prefix: string;
  if (message.kind === "system") {
    prefix = `${head} ${message.body.includes("joined") ? "→" : "←"}`;
  } else {
    const to = message.to_name === null || message.to_name === "" ? "" : ` → ${sanitize(message.to_name)}`;
    prefix = `${head} ${GLYPHS[message.kind]} ${sanitize(message.sender_name)}${to}`;
  }
  const body = sanitize(message.body);
  const bodyWidth = Math.max(MIN_BODY_WIDTH, LINE_WIDTH - prefix.length - 1);
  const lines = chunks(body, bodyWidth);
  const out = [`${prefix} ${lines[0] ?? ""}`];
  for (const extra of lines.slice(1)) out.push(`${" ".repeat(prefix.length + 1)}${extra}`);
  return out.join("\n");
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
      if (value === undefined) fail(`--dir needs a chat directory\n${USAGE}`);
      parsed.dir = value;
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "view" && parsed.target === null) continue;
    if (arg.startsWith("-")) fail(`unknown option ${arg}\n${USAGE}`);
    if (parsed.target !== null) fail(`unexpected argument ${arg}\n${USAGE}`);
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
    try {
      const db = openReadonly(path);
      const count = historyCount(db);
      const last = lastActivity(db);
      const open = openQuestions(db).length;
      db.close();
      const when = last === null ? "-" : clock(last);
      console.log(
        `  ${sanitize(session).padEnd(NAME_COLUMN)} ${String(count).padStart(4)} messages   last ${when}   open questions ${open}`,
      );
    } catch (err) {
      console.log(`  ${sanitize(session).padEnd(NAME_COLUMN)} unreadable: ${sanitize(errorText(err))}`);
    }
  }
}

function followChat(db: Database, startId: number): void {
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
      const idWidth = messageIdWidth(batch);
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
    if (args.follow) fail(`--follow needs a chat (give a session id or path)\n${USAGE}`);
    listChats(chatDir);
    return;
  }

  const target = args.target;
  const resolved = resolve(target);
  if (isDirectory(resolved)) {
    if (args.follow) fail(`--follow needs a chat (give a session id or path), not a directory\n${USAGE}`);
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
    db = openReadonly(path);
  } catch (err) {
    fail(`cannot read ${path}: ${errorText(err)}`);
  }

  let messages: Message[];
  let open: number;
  try {
    messages = readAll(db, 0);
    open = openQuestions(db).length;
  } catch (err) {
    fail(`cannot read ${path}: ${errorText(err)}`);
  }

  console.log(headerLine(session, messages, open));
  for (const message of messages) {
    console.log(renderMessage(message, messageIdWidth(messages)));
  }

  if (args.follow) {
    const last = messages[messages.length - 1];
    followChat(db, last === undefined ? 0 : last.id);
    return;
  }
  db.close();
}

try {
  main();
} catch (err) {
  fail(errorText(err));
}
