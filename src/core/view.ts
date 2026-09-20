import { sanitize } from "./render.ts";
import type { Kind, Message } from "./types.ts";

export const LINE_WIDTH = 100;
export const MIN_BODY_WIDTH = 32;
export const SENDER_MAX = 16;
export const TO_MAX = 24;

export const GLYPHS: Record<Kind, string> = {
  status: "●",
  question: "?",
  answer: "✓",
  blocker: "!",
  finding: "★",
  handoff: "→",
  system: "→",
};

export function clock(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

export function liveParticipants(messages: Message[]): string[] {
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

export function headerLine(session: string, messages: Message[], open: number): string {
  const names = liveParticipants(messages).map(sanitize).join(", ");
  return `chat ${sanitize(session)} · ${names} · ${open} open`;
}

export function messageIdWidth(messages: Message[]): number {
  const last = messages[messages.length - 1];
  return last === undefined ? 1 : String(last.id).length;
}

export function chunks(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    let rest = word;
    while (rest.length > 0) {
      const room = line === "" ? width : width - line.length - 1;
      if (room <= 0) {
        lines.push(line);
        line = "";
        continue;
      }
      const piece = rest.slice(0, room);
      line = line === "" ? piece : `${line} ${piece}`;
      rest = rest.slice(piece.length);
      if (line.length >= width) {
        lines.push(line);
        line = "";
      }
    }
  }
  if (line !== "") lines.push(line);
  return lines.length === 0 ? [""] : lines;
}

export function fitField(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

export function renderTranscript(messages: Message[], open: number, sessionID: string): string {
  const lines = [headerLine(sessionID, messages, open)];
  const idWidth = messageIdWidth(messages);
  for (const message of messages) lines.push(renderMessage(message, idWidth));
  return lines.join("\n");
}

export function renderMessage(message: Message, idWidth: number): string {
  const head = `${clock(message.created_at)} [${String(message.id).padStart(idWidth)}]`;
  let prefix: string;
  if (message.kind === "system") {
    prefix = `${head} ${message.body.includes("joined") ? "→" : "←"}`;
  } else {
    const sender = fitField(sanitize(message.sender_name), SENDER_MAX);
    const rawTo =
      message.to_name === null || message.to_name === "" ? null : fitField(sanitize(message.to_name), TO_MAX);
    const to = rawTo === null ? "" : ` → ${rawTo}`;
    prefix = `${head} ${GLYPHS[message.kind]} ${sender}${to}`;
  }
  const body = sanitize(message.body);
  const bodyWidth = Math.max(MIN_BODY_WIDTH, LINE_WIDTH - prefix.length - 1);
  const lines = chunks(body, bodyWidth);
  const out = [`${prefix} ${lines[0] ?? ""}`];
  for (const extra of lines.slice(1)) out.push(`${" ".repeat(prefix.length + 1)}${extra}`);
  return out.join("\n");
}
