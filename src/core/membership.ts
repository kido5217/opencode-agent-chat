import type { Participant } from "./types.ts";

export interface SessionInfo {
  id: string;
  parentID?: string | null;
  agentType?: string | null;
  live?: boolean;
}

export interface MembershipDeps {
  now(): number;
  appendSystemMessage(rootSessionID: string, body: string): void;
}

interface Member {
  id: string;
  parentID: string | null;
  agentType: string | null;
  name: string | null;
  live: boolean;
  busy: boolean;
  joinedAt: number;
}

export class Membership {
  private readonly deps: MembershipDeps;
  private readonly members = new Map<string, Member>();

  constructor(deps: MembershipDeps) {
    this.deps = deps;
  }

  sessionCreated(s: SessionInfo): void {
    const existing = this.members.get(s.id);
    if (existing === undefined) {
      this.members.set(s.id, {
        id: s.id,
        parentID: s.parentID ?? null,
        agentType: s.agentType ?? null,
        name: null,
        live: false,
        busy: false,
        joinedAt: 0,
      });
      return;
    }
    if (s.parentID !== undefined) existing.parentID = s.parentID ?? null;
    if (s.agentType !== undefined) existing.agentType = s.agentType ?? null;
  }

  executionStarted(sessionID: string): void {
    const member = this.members.get(sessionID);
    if (member === undefined) return;
    const root = this.rootFor(sessionID);
    member.live = true;
    member.busy = true;
    member.joinedAt = this.deps.now();
    if (root === null) return;
    const name = this.assignName(member, root);
    this.deps.appendSystemMessage(root, `${name} joined`);
  }

  executionEnded(sessionID: string, outcome: "completed" | "failed" | "interrupted"): void {
    const member = this.members.get(sessionID);
    if (member === undefined || !member.live) return;
    member.live = false;
    member.busy = false;
    const root = this.rootFor(sessionID);
    if (root === null || member.name === null) return;
    this.deps.appendSystemMessage(root, `${member.name} left (${outcome})`);
  }

  reconcile(sessions: SessionInfo[]): void {
    for (const s of sessions) this.sessionCreated(s);
    for (const s of sessions) {
      if (s.live !== true) continue;
      const member = this.members.get(s.id);
      if (member === undefined) continue;
      const root = this.rootFor(s.id);
      if (root === null) continue;
      this.assignName(member, root);
      if (!member.live) member.joinedAt = this.deps.now();
      member.live = true;
      member.busy = true;
    }
  }

  rootFor(sessionID: string): string | null {
    let member = this.members.get(sessionID);
    if (member === undefined) return null;
    const seen = new Set<string>();
    while (member.parentID !== null) {
      if (seen.has(member.id)) return null;
      seen.add(member.id);
      const parent = this.members.get(member.parentID);
      if (parent === undefined) return null;
      member = parent;
    }
    return member.id;
  }

  nameFor(sessionID: string): string | null {
    return this.members.get(sessionID)?.name ?? null;
  }

  isLive(sessionID: string): boolean {
    return this.members.get(sessionID)?.live === true;
  }

  roster(rootSessionID: string): Participant[] {
    const participants: Participant[] = [];
    for (const member of this.members.values()) {
      if (!member.live || member.name === null) continue;
      if (this.rootFor(member.id) !== rootSessionID) continue;
      participants.push({
        sessionID: member.id,
        name: member.name,
        agentType: member.agentType ?? (member.parentID === null ? "main" : "subagent"),
        busy: member.busy,
        joinedAt: member.joinedAt,
      });
    }
    return participants.sort((a, b) => a.joinedAt - b.joinedAt);
  }

  private assignName(member: Member, root: string): string {
    if (member.name !== null) return member.name;
    const base = member.parentID === null ? "main" : member.agentType ?? "subagent";
    const taken = new Set<string>();
    for (const other of this.members.values()) {
      if (other === member || !other.live || other.name === null) continue;
      if (this.rootFor(other.id) === root) taken.add(other.name);
    }
    let name = base;
    for (let suffix = 2; taken.has(name); suffix++) name = `${base}-${suffix}`;
    member.name = name;
    return name;
  }
}
