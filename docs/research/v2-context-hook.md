# Context-hook injection: main vs subagent sessions (opencode v2.0.8)

Researched 2026-09-20 on this host against the installed
`/nix/store/dg787j4sa7hmxrgmcp0n2vajwmv3cbg3-opencode2-2.0.8/bin/opencode2`.
Companion to `docs/research/opencode-v2-plugin-api.md`; this file closes two items that §11 of
that document listed as unverified — context-hook delivery to subagent sessions and subagent
loading of project `AGENTS.md`.

Sources, in evidence order:

1. Empirical probe (§Appendix) — a scratch project at `/tmp/opencode/hook-probe`, isolated
   `XDG_*` dirs, two probe plugins, one foreground `subagent` call, cheapest model
   (`deepseek/deepseek-flash`). Raw artifacts: `hook-log-run1.jsonl`, `main-export.json`,
   `child-export.json`.
2. Official V2 docs: [`/v2/docs/build/plugins`](https://opencode.ai/v2/docs/build/plugins)
   (Hooks → Model requests), [`/v2/docs/agents`](https://opencode.ai/v2/docs/agents),
   [`/v2/docs/instructions`](https://opencode.ai/v2/docs/instructions).
3. Type definitions, `@opencode/plugin@2.0.8`: `dist/promise/session.d.ts`
   (`SessionContext`, `SessionHooks`), `@opencode/ai` `dist/schema/messages.d.ts`
   (`SystemPart`, `Message`).

## Verdict

| Question | Verdict |
|---|---|
| `context` fires for the **main** session | VERIFIED |
| `context` fires for the **subagent child** session | VERIFIED |
| Fires **once per model request** (initial + tool-driven continuations) | VERIFIED |
| Mid-run injection into a running subagent | VERIFIED |
| `event.system.push(...)` reaches the model | VERIFIED |
| `event.messages.push(userMessage)` reaches the model | VERIFIED |
| Injected text persisted in the session transcript | **VERIFIED NO** — outgoing call only |
| Conditional on `event.agent` | VERIFIED |
| Conditional on `event.sessionID` | VERIFIED (field present and unique; same branch mechanics) |
| Subagent child loads project `AGENTS.md` | VERIFIED |
| Later-registered plugin sees earlier plugin's mutations | VERIFIED |

## 1. Fire frequency and trigger points

The hook is registered once at plugin setup on the session domain and is not bound to a session:

```ts
await ctx.session.hook("context", (event) => { … })
```

One probe run produced **four** `context` events, exactly two per agent loop:

| session | agent | call 1 `messagesLen` | call 2 `messagesLen` | call 2 roles |
|---|---|---|---|---|
| `ses_…SA7zbI` (main) | `probe-main` | 1 | 3 | user, assistant, tool |
| `ses_…B6aWP5` (child) | `probe-child` | 1 | 3 | user, assistant, tool |

- The child session is a real child session (`parentID = ses_…SA7zbI` in `session export`), and it
  carries its own agent id in `event.agent`. VERIFIED.
- The second event per session is the tool-driven continuation (`messages` gains
  `assistant` + `tool`). So the hook fires **per model request inside the agent loop**, including
  mid-run for a subagent that is already executing. A digest computed in the hook can therefore
  ride along with every subsequent request of a running child. VERIFIED.
- A separate single-request session (no subagent, prompt `Reply with exactly: OK-NOTITLE`)
  produced exactly **one** `context` event — the count tracks model requests, not sessions. VERIFIED.
- Docs: "`context` runs for the agent loop, including tool-driven continuations", while
  `compaction`, `generate`, and `title` are separate hooks with their own registration. That
  auxiliary requests do not also trigger `context` is DOCS-only (see UNVERIFIED).

### Payload shape at the hook (v2.0.8, observed)

- Top-level keys: `sessionID`, `model`, `system`, `messages`, `options`, `agent`, `tools`.
- `model` present each call: `{ id: "deepseek-flash", providerID: "deepseek", variant: "default" }`.
- No `kind` field on `context` (unlike `http.request`/WS hooks), so the agent loop is identified by
  hook name, not by `kind`.
- Entry state: `systemLen = 4` system parts already assembled; `messages` = persisted history
  (user/assistant/tool roles only).
- Types match `SessionContext extends SessionRequest` (`dist/promise/session.d.ts`):
  `readonly sessionID`, `readonly model`, `system: SystemPart[]`, `messages: Message[]`, `options`,
  `readonly agent`, `tools`.

## 2. Does injected text reach the model, and is it visible in the transcript?

Two injection forms were exercised in the same hook, branch on `event.agent`:

```ts
event.system.push({ type: "text", text: SYS_CHILD })        // system part, appended
event.messages.push(Message.user(USER_CHILD))               // user-role message, appended
```

Both reached the model, quoted verbatim in the agents' persisted answers:

- main: "my instructions contain the string `PROBE-SYS-MAIN-gxl636`" — and
  `PROBE-ORDER-MARKER` pushed by the second plugin.
- child: "In my system prompt: `PROBE-SYS-CHILD-gxl636`", "In the message that followed my shell
  call: `PROBE-USER-CHILD-gxl636`" — the user-role message arrived on the **continuation** request,
  after the tool result. VERIFIED.

Transcript form — **the injections are not part of persisted history**:

- `opencode2 session export` (main and child) contains the original user prompt, assistant
  messages (reasoning/text/tool parts), and an `idle` entry. No injected system or user entry.
- In the isolated DB, `session_message` contains the marker strings only inside `type=assistant`
  rows — i.e. only where the model itself echoed them. No stored user/system row contains a marker.
- Docs agree: "Changes affect only the outgoing model call, not persisted history or
  configuration." VERIFIED (empirically, on 2.0.8; this also fails to reproduce the beta-build
  issue anomalyco/opencode#44788 noted in the companion doc).

Formatting notes for injection (observed):

- `system` push appends one `SystemPart` of the documented shape `{ type: "text", text }`; it sits
  at the end of the system array, after built-in and AGENTS.md parts.
- `messages` push appends to the end of the message array. Because it re-runs on every request,
  a mid-loop push lands **after the last tool result** (the child observed it following its shell
  call). The same text is re-pushed on each subsequent request; there is no dedupe — a plugin that
  wants a current digest should rebuild it each call.
- `Message.user(...)` from `@opencode/ai` produced a schema-valid user message
  (`{"role":"user","content":[{"type":"text","text":"…"}]}`); plain object literals were not tested.

## 3. Conditional injection on agent / session id

- `event.agent` discriminates reliably: the branch injected `SYS_MAIN` for `probe-main` and
  `SYS_CHILD` + `USER_CHILD` for `probe-child`; each agent reported only its own markers. VERIFIED.
- `event.sessionID` is present on every event and unique per session (main `ses_…SA7zbI`, child
  `ses_…B6aWP5`, per-session child value stable across its two calls). Branching on it uses the same
  plain-string field mechanics as `agent`; it was not separately exercised end-to-end. VERIFIED
  structurally.

## 4. Subagent child and project AGENTS.md

`AGENTS.md` in the probe project root contained `AGENTS-MARKER-7f3a`. The child agent
(`probe-child`) answered from its own system prompt: "It appears in the project instructions
(AGENTS.md) visible to me, in this sentence: `The project token is AGENTS-MARKER-7f3a.`"

So a project `AGENTS.md` **is** part of a subagent child session's assembled instructions — the
docs' implied claim checked in the companion doc §11 is now VERIFIED. The main agent reported the
same. (V2 still does not resolve the config `instructions` array; only `AGENTS.md` is active — docs.)

## 5. Ordering and cross-plugin interaction

- Two plugins were discovered from `.opencode/plugins/<name>/index.ts`
  (`ctx-probe`, `ctx-probe-order`) in one server. The second plugin's hook logged, on **all four**
  events, that it could see the first plugin's pushed system part, and on both child events that it
  could see the first plugin's pushed user message. VERIFIED.
- This matches the docs: "OpenCode runs them in plugin order, so later hooks see changes made by
  earlier hooks." The observed order matched directory discovery order (alphabetical); the
  authoritative rule is registration/load order (DOCS).
- No formatting conflict was needed: each plugin appended its own `SystemPart`; the model saw both
  markers simultaneously.

## UNVERIFIED / caveats

- **Auxiliary request kinds.** Whether `context` (as opposed to the dedicated `compaction`/
  `generate`/`title` hooks) fires for those flows was not exercised. The no-title probe run stayed
  "Untitled session", so no title model call occurred at all.
- **Background subagents.** Only a foreground `subagent` call was tested. The child mechanics
  (session, agent id) should be identical for `background: true`, but it is not empirically shown
  here.
- **Other providers.** Only `deepseek/deepseek-flash` was used. Whether a pushed user message that
  lands after a tool result is accepted identically by every provider protocol is untested.
- **TUI/UI display.** Whether injected system text is surfaced anywhere in the interactive UI was
  not checked; `session export` and the DB are the only transcript evidence used.
- **Registration scoping.** The session hook API exposes only `{ providerID }` scoping; per-session
  targeting must be done inside the callback via `event.agent` / `event.sessionID`. A mechanism to
  scope a registration to one session was not found.
- **Compaction boundaries.** Long-session behavior (injection around compaction) was not tested.

## Appendix — probe setup (for reproduction)

- Project: `/tmp/opencode/hook-probe`; isolated env
  `XDG_CONFIG_HOME=$P/xdg-config XDG_DATA_HOME=$P/xdg-data XDG_CACHE_HOME=$P/xdg-cache`.
- Plugins: `$P/.opencode/plugins/ctx-probe/index.ts` (logs payload shape, branches on
  `event.agent`, pushes `PROBE-SYS-*` / `Message.user(PROBE-USER-CHILD-*)`) and
  `$P/.opencode/plugins/ctx-probe-order/index.ts` (checks visibility of the first plugin's parts,
  pushes `PROBE-ORDER-MARKER`). Both `Plugin.define` from `@opencode/plugin`; `@opencode/plugin@2.0.8`
  resolvable from the project's `node_modules`.
- Agents: `.opencode/agents/probe-main.md` (primary) and `probe-child.md` (subagent), both pinned to
  `deepseek/deepseek-flash`; project `AGENTS.md` with the marker.
- Run: `opencode2 run --standalone --agent probe-main -m deepseek/deepseek-flash --auto "<prompt>"`
  from the project dir, stdin closed; transcript via `opencode2 session export --standalone <id>`.
- Environment gotcha found while bootstrapping: in v2 the provider credential lives in the data-dir
  SQLite DB (`credential` table, consumed from `auth.json` on the real install). An isolated
  `XDG_DATA_HOME` with only a copied `auth.json` reports the key via `opencode2 auth list` but the
  run fails with `Model unavailable`; copying the `credential` row made the model usable. The
  successful probe runs used no shared state beyond that credential row.
