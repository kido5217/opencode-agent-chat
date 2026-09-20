import { existsSync } from "node:fs";
import { openQuestions, readAllMessages } from "./protocol.ts";
import { chatFilePath, isValidSessionId, openChatReadonly } from "./storage.ts";
import { renderTranscript } from "./view.ts";

export function transcriptFor(chatDir: string, sessionID: string): string | null {
  if (!isValidSessionId(sessionID)) return null;
  const path = chatFilePath(chatDir, sessionID);
  if (!existsSync(path)) return null;
  const db = openChatReadonly(path);
  try {
    return renderTranscript(readAllMessages(db), openQuestions(db).length, sessionID);
  } finally {
    db.close();
  }
}
