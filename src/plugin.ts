import { Plugin } from "@opencode/plugin";
import type { Database } from "bun:sqlite";
import protocolText from "../docs/chat-protocol.md" with { type: "text" };
import { buildDigest, buildJoinBriefing } from "./core/digest.ts";
import { Membership } from "./core/membership.ts";
import { parseOptions } from "./core/options.ts";
import { ChatError, postMessage, readMessages, RunGuard, unreadMessages } from "./core/protocol.ts";
import { INJECTION_HEADER, renderMessages, renderRoster } from "./core/render.ts";
import { debugLog, ensureChatDir, getCursor, openChat, setCursor } from "./core/storage.ts";
import { AGENT_KINDS, type Kind, type Message } from "./core/types.ts";

const POST_DESC =
  "Post to the session chat. Kinds: status, finding, question, blocker, handoff, answer (reply with in_reply_to). Silence is the default — post what changes a peer's decisions.";
const READ_DESC =
  "Read chat messages. No arguments: unread since your cursor (consumes it). open_only for open questions, ids for specific messages, since/before to browse history (does not consume).";
const ROSTER_DESC =
  "List the agents currently connected to this session's chat, with name, agent type, and busy/idle status.";

const KINDS = [...AGENT_KINDS];
const MAX_TO_CHARS = 100;

const POST_SCHEMA = {
  type: "object",
  properties: {
    body: { type: "string" },
    kind: { type: "string", enum: KINDS },
    to: { type: "string", maxLength: MAX_TO_CHARS },
    in_reply_to: { type: "integer" },
  },
  required: ["body"],
  additionalProperties: false,
} as const;

const READ_SCHEMA = {
  type: "object",
  properties: {
    since: { type: "integer" },
    before: { type: "integer" },
    ids: { type: "array", items: { type: "integer" } },
    kind: { type: "string", enum: KINDS },
    open_only: { type: "boolean" },
    limit: { type: "integer" },
  },
  additionalProperties: false,
} as const;

const ROSTER_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

interface PostArgs {
  body: string;
  kind?: Kind;
  to?: string;
  in_reply_to?: number;
}

interface ReadArgs {
  since?: number;
  before?: number;
  ids?: number[];
  kind?: Kind;
  open_only?: boolean;
  limit?: number;
}

export default Plugin.define({
  id: "opencode-agent-chat",
  async setup(ctx) {
    const warnings: string[] = [];
    const options = parseOptions(ctx.options, (m) => warnings.push(m));
    const log = (line: string) => {
      if (options.debug) debugLog(options.chatDir, line);
    };
    for (const w of warnings) log(`option warning: ${w}`);
    try {
      ensureChatDir(options.chatDir, log);
    } catch (err) {
      log(`agent-chat: could not create chat directory ${options.chatDir}: ${String(err)}`);
    }

    const dbs = new Map<string, Database>();
    const openDb = (root: string): Database => {
      let db = dbs.get(root);
      if (db === undefined) {
        db = openChat(options.chatDir, root, log);
        dbs.set(root, db);
      }
      return db;
    };

    const membership = new Membership({
      now: () => Date.now(),
      appendSystemMessage: (root, body) => {
        const db = openDb(root);
        postMessage(
          db,
          {
            senderName: "system",
            senderSession: null,
            senderType: "system",
            now: Date.now(),
            maxBodyChars: options.maxBodyChars,
          },
          { body, kind: "system" },
        );
      },
    });
    const guard = new RunGuard(options.maxPostsPerRun);

    const seen = new Set<string>();
    const hydrate = async (sessionID: string): Promise<void> => {
      let id: string | undefined = sessionID;
      while (id !== undefined && !seen.has(id)) {
        try {
          const info = await ctx.session.get({ sessionID: id });
          membership.sessionCreated({ id: info.id, parentID: info.parentID, agentType: info.agent });
          seen.add(id);
          log(`session hydrated ${id}${info.parentID == null ? " (root)" : ` parent=${info.parentID}`}`);
          id = info.parentID ?? undefined;
        } catch (err) {
          log(`session hydrate failed ${id}: ${String(err)}`);
          return;
        }
      }
    };

    const abort = new AbortController();
    void (async () => {
      try {
        for await (const ev of ctx.event.subscribe({ signal: abort.signal })) {
          try {
            if (ev.type === "session.created") {
              const { sessionID, parentID, agent } = ev.data;
              membership.sessionCreated({ id: sessionID, parentID, agentType: agent });
              seen.add(sessionID);
              log(`session created ${sessionID}${parentID === undefined ? " (root)" : ` parent=${parentID}`}`);
              if (parentID !== undefined && parentID !== null) await hydrate(parentID);
              continue;
            }
            const data = ev.data as { sessionID?: unknown };
            if (typeof data.sessionID !== "string") continue;
            const sessionID = data.sessionID;
            await hydrate(sessionID);
            switch (ev.type) {
              case "session.execution.started":
                guard.begin(sessionID);
                membership.executionStarted(sessionID);
                log(`join ${membership.nameFor(sessionID) ?? sessionID} (${sessionID})`);
                break;
              case "session.execution.succeeded":
                guard.end(sessionID);
                membership.executionEnded(sessionID, "completed");
                log(`leave ${membership.nameFor(sessionID) ?? sessionID} (completed)`);
                break;
              case "session.execution.failed":
                guard.end(sessionID);
                membership.executionEnded(sessionID, "failed");
                log(`leave ${membership.nameFor(sessionID) ?? sessionID} (failed)`);
                break;
              case "session.execution.interrupted":
                guard.end(sessionID);
                membership.executionEnded(sessionID, "interrupted");
                log(`leave ${membership.nameFor(sessionID) ?? sessionID} (interrupted)`);
                break;
              default:
                break;
            }
          } catch (err) {
            log(`event ${ev.type} failed: ${String(err)}`);
          }
        }
      } catch (err) {
        log(`event stream ended: ${String(err)}`);
      }
    })();

    await ctx.session.hook("context", (event) => {
      const sessionID = event.sessionID;
      const root = membership.rootFor(sessionID);
      if (root === null) {
        log(`context for unknown session ${sessionID}`);
        return;
      }
      event.system.push({ type: "text", text: protocolText });
      const db = openDb(root);
      const name = membership.nameFor(sessionID) ?? "unknown";
      const limits = { maxMessages: options.digestMaxMessages, maxChars: options.digestMaxChars };
      const now = Date.now();
      const joinBriefing = getCursor(db, sessionID) === null;
      const delivery = joinBriefing
        ? buildJoinBriefing(db, sessionID, name, limits, now)
        : buildDigest(db, sessionID, name, limits, now);
      if (delivery !== null) {
        event.system.push({ type: "text", text: delivery.text });
        log(`${joinBriefing ? "briefing" : "digest"} ${sessionID} cursor=${delivery.cursorTo}`);
      }
    });

    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "chat", description: "Shared chat between this session's agents" });
      editor.add({
        name: "post",
        description: POST_DESC,
        input: POST_SCHEMA,
        options: { namespace: "chat" },
        execute: async (input, toolContext) => {
          const post = input as PostArgs;
          const sessionID = toolContext.sessionID;
          const root = membership.rootFor(sessionID);
          if (root === null) throw new Error(`agent-chat: session ${sessionID} is not attached to a chat`);
          const db = openDb(root);
          const name = membership.nameFor(sessionID) ?? "unknown";
          const to = typeof post.to === "string" && post.to.length > 0 ? post.to : null;
          if (to !== null && to.length > MAX_TO_CHARS) {
            throw new Error(`agent-chat: to is ${to.length} characters; the cap is ${MAX_TO_CHARS}`);
          }
          try {
            guard.check(sessionID, post.body);
            const message = postMessage(
              db,
              {
                senderName: name,
                senderSession: sessionID,
                now: Date.now(),
                maxBodyChars: options.maxBodyChars,
              },
              { body: post.body, kind: post.kind, to, in_reply_to: post.in_reply_to ?? null },
            );
            guard.record(sessionID, post.body, message.id);
            let text = `posted #${message.id}`;
            if (to !== null && !membership.roster(root).some((p) => p.name === to)) {
              text += ` (note: no live participant named "${to}")`;
            }
            return { content: text };
          } catch (err) {
            if (err instanceof ChatError) throw new Error(err.message);
            throw err;
          }
        },
      });
      editor.add({
        name: "read",
        description: READ_DESC,
        input: READ_SCHEMA,
        options: { namespace: "chat" },
        execute: async (input, toolContext) => {
          const q = input as ReadArgs;
          const sessionID = toolContext.sessionID;
          const root = membership.rootFor(sessionID);
          if (root === null) throw new Error(`agent-chat: session ${sessionID} is not attached to a chat`);
          const db = openDb(root);
          const ranged =
            q.since !== undefined ||
            q.before !== undefined ||
            q.ids !== undefined ||
            q.kind !== undefined ||
            q.open_only === true;
          let messages: Message[];
          if (ranged) {
            messages = readMessages(db, {
              since: q.since,
              before: q.before,
              ids: q.ids,
              kind: q.kind,
              openOnly: q.open_only,
              limit: q.limit,
            });
          } else {
            const cursor = getCursor(db, sessionID);
            messages = unreadMessages(db, cursor?.last_read_id ?? 0, q.limit ?? 20);
            const last = messages.at(-1);
            if (last !== undefined) {
              setCursor(db, sessionID, membership.nameFor(sessionID) ?? "unknown", last.id, Date.now());
            }
          }
          return {
            content: messages.length === 0 ? "" : `${INJECTION_HEADER}\n${renderMessages(messages, options.maxBodyChars)}`,
          };
        },
      });
      editor.add({
        name: "roster",
        description: ROSTER_DESC,
        input: ROSTER_SCHEMA,
        options: { namespace: "chat" },
        execute: async (_input, toolContext) => {
          const root = membership.rootFor(toolContext.sessionID);
          if (root === null) throw new Error(`agent-chat: session ${toolContext.sessionID} is not attached to a chat`);
          return { content: renderRoster(membership.roster(root)) };
        },
      });
      const ids = editor
        .list()
        .filter((tool) => tool.options?.namespace === "chat")
        .map((tool) => tool.id);
      log(`chat tool ids: ${ids.join(", ")}`);
    });

    log("plugin loaded");
    return () => {
      abort.abort();
      for (const db of dbs.values()) db.close();
      dbs.clear();
    };
  },
});
