export const AGENT_KINDS = ["status", "finding", "question", "answer", "blocker", "handoff"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export const ALL_KINDS = [...AGENT_KINDS, "system"] as const;
export type Kind = (typeof ALL_KINDS)[number];

export function isKind(value: string): value is Kind {
  return (ALL_KINDS as readonly string[]).includes(value);
}

export interface Message {
  id: number;
  sender_type: "agent" | "system";
  sender_name: string;
  sender_session: string | null;
  kind: Kind;
  to_name: string | null;
  in_reply_to: number | null;
  body: string;
  created_at: number;
}

export interface Participant {
  sessionID: string;
  name: string;
  agentType: string;
  busy: boolean;
  joinedAt: number;
}
