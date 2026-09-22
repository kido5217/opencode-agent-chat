import type { Database } from "bun:sqlite";
import { buildDigest, buildJoinBriefing } from "./digest.ts";
import { Membership } from "./membership.ts";
import type { ChatOptions } from "./options.ts";
import {
  ChatError,
  postMessage,
  readMessages,
  RunGuard,
  unreadMessages,
  type PostInput,
  type ReadQuery,
} from "./protocol.ts";
import { INJECTION_HEADER, renderMessages, renderRoster } from "./render.ts";
import { getCursor, openChat, setCursor } from "./storage.ts";
import type { Message } from "./types.ts";

export const MAX_TO_CHARS = 100;

export type ExecutionOutcome = "completed" | "failed" | "interrupted";

export interface Delivery {
  kind: "briefing" | "digest";
  text: string;
  cursorTo: number;
}

export interface ChatHandlesConfig {
  options: ChatOptions;
  now(): number;
  warn?: (msg: string) => void;
}

interface HandleDeps {
  db: Database;
  root: string;
  sessionID: string;
  membership: Membership;
  options: ChatOptions;
  now(): number;
}

/**
 * A participant's entry point to a chat. All of a participant's chat traffic — posts, reads,
 * roster, and deliveries — flows through its handle: the run-guard bracketing and both post
 * caps, the ranged-vs-consumed read decision, and the join-briefing-vs-digest decision live
 * behind these verbs.
 */
export class ChatHandle {
  private readonly deps: HandleDeps;
  private readonly guard: RunGuard;

  constructor(deps: HandleDeps) {
    this.deps = deps;
    this.guard = new RunGuard(deps.options.maxPostsPerRun);
  }

  post(post: PostInput): string {
    const { db, root, sessionID, membership, options, now } = this.deps;
    const to = typeof post.to === "string" && post.to.length > 0 ? post.to : null;
    if (to !== null && to.length > MAX_TO_CHARS) {
      throw new ChatError("to_too_long", `agent-chat: to is ${to.length} characters; the cap is ${MAX_TO_CHARS}`);
    }
    this.guard.check(sessionID, post.body);
    const message = postMessage(
      db,
      { senderName: this.name(), senderSession: sessionID, now: now(), maxBodyChars: options.maxBodyChars },
      { body: post.body, kind: post.kind, to, in_reply_to: post.in_reply_to ?? null },
    );
    this.guard.record(sessionID, post.body, message.id);
    let text = `posted #${message.id}`;
    if (to !== null && !membership.roster(root).some((p) => p.name === to)) {
      text += ` (note: no live participant named "${to}")`;
    }
    return text;
  }

  /**
   * Explicit ranges (`since`, `before`, `ids`, `kind`, `openOnly: true`) read without moving
   * the cursor. Anything else — including an explicit `openOnly: false` — is the consuming
   * unread path: unread after the cursor, oldest first, cursor advanced in the same storage
   * transaction as the read.
   */
  read(query: ReadQuery = {}): string {
    const { db, sessionID, options, now } = this.deps;
    const ranged =
      query.since !== undefined ||
      query.before !== undefined ||
      query.ids !== undefined ||
      query.kind !== undefined ||
      query.openOnly === true;
    let messages: Message[];
    if (ranged) {
      messages = readMessages(db, query);
    } else {
      const cursor = getCursor(db, sessionID);
      messages = unreadMessages(db, cursor?.last_read_id ?? 0, query.limit ?? 20);
      const last = messages.at(-1);
      if (last !== undefined) {
        const lastId = last.id;
        const name = this.name();
        db.transaction(() => {
          setCursor(db, sessionID, name, lastId, now());
        }).immediate();
      }
    }
    return messages.length === 0 ? "" : `${INJECTION_HEADER}\n${renderMessages(messages, options.maxBodyChars)}`;
  }

  roster(): string {
    return renderRoster(this.deps.membership.roster(this.deps.root));
  }

  /**
   * The join briefing when the participant has no cursor row yet, otherwise the digest of
   * what it has not read. Nothing is delivered when there is nothing new.
   */
  nextDelivery(): Delivery | null {
    const { db, sessionID, options, now } = this.deps;
    const limits = { maxMessages: options.digestMaxMessages, maxChars: options.digestMaxChars };
    const joinBriefing = getCursor(db, sessionID) === null;
    const name = this.name();
    const delivery = joinBriefing
      ? buildJoinBriefing(db, sessionID, name, limits, now())
      : buildDigest(db, sessionID, name, limits, now());
    if (delivery === null) return null;
    return { kind: joinBriefing ? "briefing" : "digest", text: delivery.text, cursorTo: delivery.cursorTo };
  }

  /** A run begins: the post-cap budget and duplicate memory reset, and the join is recorded. */
  executionStarted(): void {
    this.guard.begin(this.deps.sessionID);
    this.deps.membership.executionStarted(this.deps.sessionID);
  }

  /** A run ends: the run guard is evicted and the leave is recorded. */
  executionEnded(outcome: ExecutionOutcome): void {
    this.guard.end(this.deps.sessionID);
    this.deps.membership.executionEnded(this.deps.sessionID, outcome);
  }

  private name(): string {
    return this.deps.membership.nameFor(this.deps.sessionID) ?? "unknown";
  }
}

/**
 * One registry per plugin setup: owns the per-root chat database pool, the membership state,
 * the options, and the per-session handle cache. `for` returns null for a session that is not
 * attached to a chat yet; `executionEnded` drops the cached handle so the run-guard state is
 * evicted with the run.
 */
export class ChatHandles {
  readonly membership: Membership;
  private readonly dbs = new Map<string, Database>();
  private readonly handles = new Map<string, ChatHandle>();
  private readonly options: ChatOptions;
  private readonly now: () => number;
  private readonly warn: (msg: string) => void;

  constructor(config: ChatHandlesConfig) {
    this.options = config.options;
    this.now = config.now;
    this.warn = config.warn ?? (() => {});
    this.membership = new Membership({
      now: this.now,
      appendSystemMessage: (root, body) => {
        postMessage(
          this.openDb(root),
          {
            senderName: "system",
            senderSession: null,
            senderType: "system",
            now: this.now(),
            maxBodyChars: this.options.maxBodyChars,
          },
          { body, kind: "system" },
        );
      },
    });
  }

  for(sessionID: string): ChatHandle | null {
    const root = this.membership.rootFor(sessionID);
    if (root === null) return null;
    let handle = this.handles.get(sessionID);
    if (handle === undefined) {
      handle = new ChatHandle({
        db: this.openDb(root),
        root,
        sessionID,
        membership: this.membership,
        options: this.options,
        now: this.now,
      });
      this.handles.set(sessionID, handle);
    }
    return handle;
  }

  executionStarted(sessionID: string): void {
    const handle = this.for(sessionID);
    if (handle !== null) handle.executionStarted();
  }

  executionEnded(sessionID: string, outcome: ExecutionOutcome): void {
    const handle = this.for(sessionID);
    if (handle !== null) handle.executionEnded(outcome);
    this.handles.delete(sessionID);
  }

  close(): void {
    for (const db of this.dbs.values()) db.close();
    this.dbs.clear();
    this.handles.clear();
  }

  private openDb(root: string): Database {
    let db = this.dbs.get(root);
    if (db === undefined) {
      db = openChat(this.options.chatDir, root, this.warn);
      this.dbs.set(root, db);
    }
    return db;
  }
}
