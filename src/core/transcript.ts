import { existsSync } from "node:fs";
import { openQuestions, readAllMessages } from "./protocol.ts";
import { chatFilePath, isValidSessionId, openChatReadonly } from "./storage.ts";
import type { Message } from "./types.ts";
import { windowTranscript, type WindowedTranscript } from "./window.ts";
import { renderTranscript } from "./view.ts";

interface ChatRead {
  readonly messages: Message[];
  readonly open: number;
}

function readChat(chatDir: string, sessionID: string): ChatRead | null {
  if (!isValidSessionId(sessionID)) return null;
  const path = chatFilePath(chatDir, sessionID);
  if (!existsSync(path)) return null;
  const db = openChatReadonly(path);
  try {
    return { messages: readAllMessages(db), open: openQuestions(db).length };
  } finally {
    db.close();
  }
}

export function transcriptFor(chatDir: string, sessionID: string): string | null {
  const read = readChat(chatDir, sessionID);
  return read === null ? null : renderTranscript(read.messages, read.open, sessionID);
}

export function tuiTranscriptFor(chatDir: string, sessionID: string): WindowedTranscript | null {
  const read = readChat(chatDir, sessionID);
  return read === null ? null : windowTranscript(sessionID, read.messages, read.open);
}

export interface PanelTranscript {
  /** The full rendered transcript: header line plus every message. */
  readonly text: string;
  /** Total message count (system messages included). */
  readonly total: number;
}

export function panelTranscriptFor(chatDir: string, sessionID: string): PanelTranscript | null {
  const read = readChat(chatDir, sessionID);
  if (read === null) return null;
  return { text: renderTranscript(read.messages, read.open, sessionID), total: read.messages.length };
}
