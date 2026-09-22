import { Plugin } from "@opencode/plugin";
import protocolText from "../docs/chat-protocol.md" with { type: "text" };
import { ChatHandles, MAX_TO_CHARS } from "./core/handle.ts";
import { ContextFilter } from "./core/context-filter.ts";
import { writeChatDirMarker } from "./core/marker.ts";
import { parseOptions } from "./core/options.ts";
import { ChatError } from "./core/protocol.ts";
import { debugLog, ensureChatDir } from "./core/storage.ts";
import { AGENT_KINDS, type Kind } from "./core/types.ts";

const POST_DESC =
  "Post to the session chat. Kinds: status, finding, question, blocker, handoff, answer (reply with in_reply_to). Post what changes a peer's knowledge or decisions — and post a `question` the moment you're blocked on a fact or decision a peer can settle. Silence is the prior, not a license to skip a question you could ask.";
const READ_DESC =
  "Read chat messages. No arguments: unread since your cursor (consumes it). open_only for open questions (answer the ones you can settle), ids for specific messages, since/before to browse history (does not consume).";
const ROSTER_DESC =
  "List the agents live in this session's chat, with name, type, and busy/idle status. Use it to pick a live `to` for a question, or to see who can answer.";

const KINDS = [...AGENT_KINDS];

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
    try {
      writeChatDirMarker(options.chatDir);
    } catch (err) {
      log(`agent-chat: could not write chat dir marker: ${String(err)}`);
    }

    const handles = new ChatHandles({ options, now: () => Date.now(), warn: log });
    const membership = handles.membership;
    const hidden = new ContextFilter();

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
                handles.executionStarted(sessionID);
                log(`join ${membership.nameFor(sessionID) ?? sessionID} (${sessionID})`);
                break;
              case "session.execution.succeeded":
                handles.executionEnded(sessionID, "completed");
                log(`leave ${membership.nameFor(sessionID) ?? sessionID} (completed)`);
                break;
              case "session.execution.failed":
                handles.executionEnded(sessionID, "failed");
                log(`leave ${membership.nameFor(sessionID) ?? sessionID} (failed)`);
                break;
              case "session.execution.interrupted":
                handles.executionEnded(sessionID, "interrupted");
                log(`leave ${membership.nameFor(sessionID) ?? sessionID} (interrupted)`);
                break;
              case "session.inbox.enqueued": {
                const item = (
                  ev.data as unknown as {
                    item?: { type?: unknown; payload?: { metadata?: Record<string, unknown> } };
                  }
                ).item;
                const inboxID = (ev.data as unknown as { inboxID?: unknown }).inboxID;
                if (
                  item?.type === "synthetic" &&
                  item.payload?.metadata?.source === "agent-chat" &&
                  typeof inboxID === "string"
                ) {
                  hidden.note(inboxID);
                  log(`hidden synthetic ${inboxID} (${sessionID})`);
                }
                break;
              }
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
      const messages = event.messages as unknown as Array<{ id: string }>;
      let hiddenCount = 0;
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (message !== undefined && hidden.has(message.id)) {
          messages.splice(i, 1);
          hiddenCount += 1;
        }
      }
      if (hiddenCount > 0) log(`context filter removed ${hiddenCount} synthetic message(s) for ${sessionID}`);
      const handle = handles.for(sessionID);
      if (handle === null) {
        log(`context for unknown session ${sessionID}`);
        return;
      }
      event.system.push({ type: "text", text: protocolText });
      const delivery = handle.nextDelivery();
      if (delivery !== null) {
        event.system.push({ type: "text", text: delivery.text });
        log(`${delivery.kind} ${sessionID} cursor=${delivery.cursorTo}`);
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
          const handle = handles.for(sessionID);
          if (handle === null) throw new Error(`agent-chat: session ${sessionID} is not attached to a chat`);
          try {
            return { content: handle.post({ body: post.body, kind: post.kind, to: post.to, in_reply_to: post.in_reply_to ?? null }) };
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
          const handle = handles.for(sessionID);
          if (handle === null) throw new Error(`agent-chat: session ${sessionID} is not attached to a chat`);
          return {
            content: handle.read({
              since: q.since,
              before: q.before,
              ids: q.ids,
              kind: q.kind,
              openOnly: q.open_only,
              limit: q.limit,
            }),
          };
        },
      });
      editor.add({
        name: "roster",
        description: ROSTER_DESC,
        input: ROSTER_SCHEMA,
        options: { namespace: "chat" },
        execute: async (_input, toolContext) => {
          const handle = handles.for(toolContext.sessionID);
          if (handle === null) throw new Error(`agent-chat: session ${toolContext.sessionID} is not attached to a chat`);
          return { content: handle.roster() };
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
      handles.close();
    };
  },
});
