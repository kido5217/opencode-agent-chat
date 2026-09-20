# Synthetic-message route for `/agent-chat`: can the command append to the transcript? (0.2.0 research)

**Question** (ticket #47). Can the in-TUI `/agent-chat` command append its rendered chat to the session
transcript through `client.session.synthetic`, and with what semantics? Four sub-questions: rendering,
wake, model context, persistence. If the route is not usable, the fallback is a fullscreen `session.panel`.

**Verdict: transcript-append is viable on the installed host (`opencode2` 2.0.8).** All four questions were
settled with live probes on a standalone 2.0.8 server plus a tmux TUI:

| Question | Verdict | How |
|---|---|---|
| 1. Rendering | **VERIFIED, with a constraint** | Live TUI: a synthetic with `description` renders as one inline subdued `◈` notice row showing the `description` (all lines); without `description` it is hidden. The `text` field is never rendered. |
| 2. Wake | **VERIFIED** | `resume` omitted/true starts a model turn; `resume:false` never does. `delivery:"steer"` merges into the next turn, `"queue"` is parked until an idle boundary. |
| 3. Model context | **VERIFIED** | Synthetic enters context as a `user`-role LLM message. It can be filtered by the server plugin's context hook **by message id**; filtering **by `metadata` tag is impossible** (metadata is dropped in the LLM message). |
| 4. Persistence | **VERIFIED** | Once promoted, the synthetic is a `synthetic` session message: in the session DB, in `opencode2 session export`, and in the TUI. While pending it lives only in the inbox (still rendered by the TUI). |

Nothing in the recommended route needs a host newer than 2.0.8.

## Method

- **Host**: `/etc/profiles/per-user/kido/bin/opencode2` → `opencode v2.0.8`; local `@opencode/{client,plugin,schema}` 2.0.8.
- **Sources read**: the v2 HTTP API docs (SSR HTML fetched directly — the scrape tool 404s on the
  fragment URLs), the `v2.0.8` source tag (`github.com/anomalyco/opencode`, tag `v2.0.8`, sha
  `7673ed6`), local `dist/*.d.ts` types.
- **Live probes**: a standalone server (`opencode2 serve --port 7412`, isolated XDG dirs, host
  `credential` + `models-dev:catalog` rows copied in — the `smoke/run.ts` recipe), driven through
  `@opencode/client` 2.0.8 (`OpenCode.make(...)`), with a throwaway server plugin logging every
  `session.hook("context")` event and optionally filtering synthetic messages. TUI rendering was probed
  by connecting the real TUI to that server in `tmux` (`opencode2 --server http://127.0.0.1:7412
  --session <id>`) and capturing the pane. Probe artifacts: `/tmp/opencode/probe-synth/` (not committed).

## Q1 — Rendering in the TUI transcript: VERIFIED (live TUI probe)

Two live captures on a host session with 2.0.8, 220 columns:

- **With `description`** (`◈` = U+25C8):

  ```
   • wake-true-7hj9j2
     ◈ Notice: synthetic probe 7hj9j2
     + Thought · 315ms
     CODE-7hj9j2
     Probe-Main · DeepSeek V4.1 Flash · 2.1s · 24.2 tok/s
  ```

  The row is a single inline **notice block**, not a user bubble: subdued color, `◈` icon at
  the left margin, the `description` text after it, and the session title on the right. It is not
  rolled up under any user/assistant turn; it sits between turns.
- **Without `description`**: `grep -c` over a fresh capture found **0** occurrences of both `Notice`
  and the synthetic text — the message is not rendered at all.
- **Long descriptions render in full**: a 31-line `description` (header + 30 lines) produced all 30
  lines in the capture (`CHAT-LINE-<nonce>-01` … `-30`), each continuation line indented under the
  text after the icon. There is no truncation or collapse for the notice fallback; the full-screen
  notice "completion" variant (with `Locale.truncateWidth`) is only used when the synthetic carries
  `metadata.source` of `subagent`/`shell`, which the command would not set.
- **The `text` field is never displayed.** The notice renders only `description`; the model-facing
  `text` is invisible in the transcript.
- **Pending items render too**: an admitted but unpromoted synthetic (`resume:false`, idle session,
  empty `session export`) still rendered its notice row, including on a fresh TUI mount. So the
  command's output appears immediately; promotion only changes durability.

Source (v2.0.8): `packages/tui/src/routes/session/rows.ts:314` drops synthetics whose description is
blank; `packages/tui/src/routes/session/index.tsx:1695` routes synthetic into
`SessionNoticeMessageV2`; `:2029–2030` picks `description` as the body text; `:2051` renders it through
`InlineToolRow icon="◈" … pending="Notice"`. The TUI's own composer already calls this API for hidden
editor context at `packages/tui/src/component/prompt/index.tsx:1333`
(`client.api.session.synthetic({ sessionID, text, resume:false })`).

**Constraint for the command**: the notice wrapper adds a left gutter and a `◈` prefix, so the chat
body cannot be byte-identical to `agent-chat view` inside the transcript; the shared renderer's text is
indented under the icon.

## Q2 — Wake semantics: VERIFIED (live probe + source)

Live, on an idle session with no other work:

| Call | Result |
|---|---|
| `resume` omitted | A model turn started in ~2 s; the model replied with the code from the synthetic `text` (`CODE-ff9il7`). |
| `resume: true` | Same: turn in ~2–4 s, reply `CODE-7hj9j2`. |
| `resume: false` | No turn after 90 s; the item stayed in `session.inbox`; `session export` was empty. |

`delivery`, live:

| Call | Result |
|---|---|
| `"steer"` + `resume:false`, idle | Stays pending; on the next user prompt it is promoted into **the same turn** (the model saw it in that turn's context). |
| `"queue"` + `resume:false`, idle | Stays pending; after the next user prompt completes, the queued synthetic runs as **its own later turn** (two assistant replies). |
| `"queue"` + `resume:true`, idle | The queued item alone still starts a turn — `resume` controls the wake, independent of delivery. |

Source (v2.0.8): `packages/core/src/session/session.ts:267–304` — `synthetic` durably admits the item
with `delivery: input.delivery ?? "steer"`, then `if (input.resume !== false && !session.revert)
execution.wake(sessionID)`. The wake is a doorbell: an idle key starts an execution, an active one
drains again (`packages/core/src/session/run-coordinator.ts:14–15`). Promotion timing:
`SessionInbox.Promotable` — `"steer"` promotes steers only at a step boundary mid-work; `"input"` also
allows one queued item at the idle boundary when no steers wait
(`packages/core/src/session/inbox.ts:42–47`, `:407–424`, `:496–520`;
`packages/core/src/session/runner/llm.ts:160`). Docs: *"Durably admit synthetic session input and
schedule execution unless resume is false."* — `POST /api/session/{sessionID}/synthetic`
(<https://opencode.ai/v2/docs/api>, fetched 2026-09-20).

For the command, `resume:false` is the no-model-turn mode; **`delivery:"steer"` is the better default**
because the output merges into the next real turn instead of spawning a second one.

## Q3 — Model context and filtering: VERIFIED (live probe + source)

- **It enters context.** `packages/core/src/session/runner/to-llm-message.ts:284` maps a synthetic
  message to `{ id, role: "user", content: message.text }`. Live: a synthetic admitted with
  `resume:false` and promoted on the next prompt was quoted back by the model in that turn; after a
  wake (`resume:true`) the model answered from the synthetic alone; the follow-up prompt in the same
  session was answered from the persisted synthetic again.
- **The server plugin can filter it out.** Live A/B on the same flow with a throwaway plugin hooking
  `ctx.session.hook("context", (event) => …)`: with filtering off the model replied `CTXCODE-<nonce>`;
  with the synthetic's LLM message spliced out of `event.messages` the model replied `NONE`, while the
  synthetic stayed in the export and DB. The hook can mutate `event.messages` in place
  (`@opencode/plugin` `SessionContext.messages: Array<Message>`; the runner consumes the hook's
  `messages` at `packages/core/src/session/model-request.ts:91`).
- **Filtering by `metadata` tag does not work.** Live: a synthetic admitted with
  `metadata: { tag: "agent-chat", probe: … }` kept that metadata in the exported session message, but
  the corresponding LLM message had `hasMetadata: false` — the synthetic branch of
  `to-llm-message.ts` drops metadata. Filtering must key on the **message id** (the admission id, which
  equals the inbox id and the session-message id) or on a sentinel in the text.
- **How the server plugin learns the id**: the project's server plugin already subscribes to
  `ctx.event.subscribe` (`src/plugin.ts:133`); a synthetic admission emits
  `session.inbox.enqueued` with `item.type === "synthetic"` and the `inboxID` — the live filter probe
  collected ids exactly that way. Alternatively the TUI command can pass an explicit `id`
  (`SessionSyntheticInput.id`), but ids are deduped per session, so a fixed id only admits once.

Consequence for the command: putting the chat in `description` and a short marker in `text` keeps the
chat itself out of the model request only if the server plugin filters the marker message; otherwise
the marker (or whatever `text` carries) enters context on the next turn. `text` is required by the
schema, and it is the only half the model ever sees.

## Q4 — Persistence: VERIFIED (live probe)

- **Promoted** synthetic: inserted into the `session_message` table by the projector
  (`packages/core/src/session/projector.ts:624`; updater `message-updater.ts:160–167`), shown by the TUI,
  and present in `opencode2 session export --standalone <id>`:

  ```
  synthetic | msg_0bffe9a65001AuKPmSwPoDgo3l | The secret code is CODE-7hj9j2. … | Notice: synthetic probe 7hj9j2 | metadata: None
  ```

  Export covers synthetics explicitly (`packages/core/src/session/transfer.ts:242`;
  `Session.Message.Synthetic` is `{ id, metadata?, time, text, description?, type }` in the docs type
  table and in `@opencode/schema/session-message`).
- **Pending** synthetic (`resume:false`, still idle): only in the `session_inbox` table and in the
  TUI; absent from `session export` and from `session_message` until a turn promotes it. Both states
  were observed directly in the probe DB.
- **Idempotency**: `id` is the admission key; repeating a call with the same id returns the existing
  admission instead of duplicating (`SessionInbox.reconcile`). A fresh id per command invocation
  appends a fresh notice row, which matches "append output".
- `metadata` passed to `synthetic` is persisted on the session message; it is not rendered in the
  TUI notice and not visible to the model.

## Exact call shape (2.0.8)

From the TUI plugin (`context.client` is the promise `OpenCodeClient`, `@opencode/plugin/dist/tui/context.d.ts:447`):

```ts
await context.client.session.synthetic({
  sessionID,              // active session from ui.router.current()
  text,                   // REQUIRED; model-facing; enters context as a user-role message
  description,            // human-facing transcript notice body (renders only if non-blank)
  metadata: { source: "agent-chat" },  // persisted; model-invisible
  resume: false,          // no wake, no model turn
  // delivery defaults to "steer"
})
// → SessionInboxSynthetic { id, sessionID, time, type: "synthetic", payload, delivery }
```

The same method is what the live probe drove on 2.0.8. The in-tree TUI instead calls
`client.api.session.synthetic` (its internal client); the plugin-facing equivalent is the promise
method above.

## Final verdict

**Transcript-append is viable — do not fall back to the fullscreen panel for capability reasons.**
The chat text can be appended inline, with no model turn, and persists. The panel remains the better
choice only on UX grounds:

- **Append route (if chosen)**: put the rendered chat in `description` and a short marker in `text`;
  call with `resume:false`, `delivery:"steer"`. The chat appears immediately as a subdued `◈` notice
  block (full multi-line text renders; no collapse or scroll affordance), persists after the next
  turn, and comes back on TUI restart. Add the server-plugin context filter (by synthetic id, learned
  from `session.inbox.enqueued`) so the marker never reaches the model.
- **Panel route (fallback)**: scrollable, closable, re-renderable, exact `agent-chat view` formatting,
  zero transcript/model side effects. Prefer it if long chats must stay navigable, if the notice
  styling is unacceptable, or if byte-identical format parity is a requirement.

The parent ticket's preference ("appended … if the synthetic-message probe allows") is satisfied: the
probe allows it, with the notice styling and context-filter caveats above.

## Host/newer-version note

- Everything above is verified on **host 2.0.8**; no part of the route needs a newer host. The API,
  the wake/queue semantics, and the notice rendering are all present in 2.0.8.
- **Version-sensitive surface** (re-probe when the host moves): the notice mechanism depends on
  `Session.Message.Synthetic.description`. The upstream default branch at fetch time
  (`anomalyco/opencode` `packages/schema/src/session-message.ts`) declares `Synthetic` as
  `{ …Base, sessionID, text, type }` — no `description` — and its TUI layer keys off a text-part
  `synthetic` flag instead, so the rendering rule may change on a post-2.0.x host. The local
  dependency range is `@opencode/plugin ~2.0.8`; keep the probe assumptions pinned to the 2.0.x line.

## Probe log (throwaway, `/tmp/opencode/probe-synth`)

- **Setup**: standalone `opencode2 serve` on 127.0.0.1:7412, isolated `XDG_*`, host credentials
  seeded; throwaway plugin logs every `context` hook and filters recorded synthetic ids.
- **W1** `resume:true`, idle: turn in 4.0 s, reply `CODE-7hj9j2`; synthetic promoted to export; inbox empty.
- **W2** `resume:false`, idle: 90 s no turn, no export messages, item still in inbox.
- **W3** `resume` omitted: turn in 2.0 s, reply `CODE-ff9il7`; follow-up turn quoted the code again.
- **C1** pending `steer` + later prompt (filter off): one turn, model replied `CTXCODE-brh4w6`.
- **C2** same with filter on: model replied `NONE`; synthetic still exported; hook logged the splice.
- **M1** synthetic with `metadata`: export metadata preserved; LLM message `hasMetadata:false`.
- **Q1** queue + `resume:false`: no turn; later prompt ran prompt turn then a separate queued turn.
  queue + `resume:true`: queued item alone started a turn.
- **N1** synthetic without `description`, `resume:true`: assistant replied; TUI capture had 0 notice/text matches.
- **L1** 31-line `description`, `resume:false`: TUI rendered all 30 `CHAT-LINE-*` lines although export was empty.
- **T1/T2/T3** TUI in `tmux` against the probe server: notice row captured (`◈ …`), hidden case captured,
  long-description case captured. Captures: `logs/tui-nodesc.txt`, `logs/tui-longdesc.txt`.
- **Export/DB**: `opencode2 session export --standalone` and direct `session_message` / `session_inbox`
  reads confirmed the persistence split.

## Primary sources

- Docs: `POST /api/session/{sessionID}/synthetic` ("Durably admit synthetic session input and schedule
  execution unless resume is false"), `Session.Inbox.*` and `Session.Message.Synthetic` type tables —
  <https://opencode.ai/v2/docs/api>; plugin surface `ctx.session.synthetic` —
  <https://opencode.ai/v2/docs/build/plugins>.
- Types (local 2.0.8): `@opencode/client/dist/promise/client.d.ts` (`session.synthetic`),
  `@opencode/client/dist/effect/api/api.d.ts:325` (`SessionSyntheticInput`),
  `@opencode/schema/dist/session-inbox.d.ts`, `session-message.d.ts`,
  `@opencode/plugin/dist/promise/session.d.ts` (`SessionContext.messages`),
  `@opencode/plugin/dist/tui/context.d.ts:447` (`client`).
- Source (v2.0.8 tag, `7673ed6`): `packages/tui/src/routes/session/{rows.ts,index.tsx}`,
  `packages/tui/src/component/prompt/index.tsx:1333`,
  `packages/core/src/session/session.ts:267–304`, `session/projector.ts:624`,
  `session/message-updater.ts:160–167`, `session/transfer.ts:242`,
  `session/runner/to-llm-message.ts:284`, `session/runner/llm.ts:160`, `session/inbox.ts:42–47,407–520`,
  `session/run-coordinator.ts:14–15`, `session/model-request.ts:91`.
- Upstream drift check: `anomalyco/opencode` default branch `packages/schema/src/session-message.ts` and
  `packages/tui/src/util/transcript.ts` (fetched 2026-09-20).
