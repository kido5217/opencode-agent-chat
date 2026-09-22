import type { Message } from "./types.ts";
import { headerLine, messageIdWidth, renderMessage, renderTranscript } from "./view.ts";

export const WINDOW_SIZE = 10;
export const FULL_COMMAND = "/agent-chat full";

export interface WindowedTranscript {
  /** Rendered body: the full transcript, or the header plus the last WINDOW_SIZE messages. */
  readonly text: string;
  /** The synthetic notice label, with the truncation indicator and expand hint when truncated. */
  readonly label: string;
  /** Total message count (system messages included). */
  readonly total: number;
  readonly truncated: boolean;
}

export function windowTranscript(root: string, messages: Message[], open: number): WindowedTranscript {
  const total = messages.length;
  if (total <= WINDOW_SIZE) {
    return {
      text: renderTranscript(messages, open, root),
      label: `agent-chat transcript for ${root}`,
      total,
      truncated: false,
    };
  }
  const window = messages.slice(-WINDOW_SIZE);
  const idWidth = messageIdWidth(messages);
  const lines = [
    headerLine(root, messages, open),
    ...window.map((message) => renderMessage(message, idWidth)),
  ];
  return {
    text: lines.join("\n"),
    label: `agent-chat transcript for ${root} · showing last ${WINDOW_SIZE} of ${total} · ${FULL_COMMAND}`,
    total,
    truncated: true,
  };
}
