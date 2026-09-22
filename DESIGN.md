# Agent chat for opencode v2 — design

**Status:** design locked (2026-09-20). This is the handoff spine for implementation; every
decision below is resolved on the [wayfinder map](https://github.com/kido5217/opencode-agent-chat/issues/3),
where the linked ticket holds the full reasoning.

A session's main agent and subagents share one append-only chat. Each agent posts status,
findings, blockers, and questions; at its next model request it receives a digest of what it
has not read, and it pulls the full text on demand. The chat persists in one SQLite file per
session, and a human reads it through a small viewer CLI.

## How to read this

- **Vocabulary** is `CONTEXT.md` (Chat, Participant, Message, Kind, Open question, Cursor,
  Digest, Join briefing, Roster, …). This document uses those terms exactly.
- **Hard-to-reverse choices** live in `docs/adr/` (0001 append-only log, 0002 per-session
  files, 0003 untrusted content).
- **Verified platform facts** live in `docs/research/` on branch `research/wayfinder-charting`;
  section pointers below name the relevant file.
- **The rules agents actually read** are `docs/chat-protocol.md` — shipped inside the package
  and injected (see §9).

## 1. Scope

In: opencode v2 (the 2.0.x line, floor `2.0.8`; developed against 2.0.8); agents only (main +
subagents in one session); one flat channel per session; SQLite storage; digest injection;
tools; viewer; npm distribution.

Out: opencode v1; threads, search, attachments, multiple channels; real-time push or
auto-wake; cross-project or cross-session chat; human posting; adopting sibling projects
(`opencode-ensemble`, `opencode-swarm`, `agent-bus` are reference only).

## 2. Architecture

Four pieces, one dependency direction: core ← adapter, core ← viewer, core ← TUI entry.

| Piece | Path | Responsibility |
|---|---|---|
| Core | `src/core/` | Pure TypeScript: storage, message protocol, digest, membership, the participants' chat handles, options, migrations, transcript. No opencode imports; `bun:sqlite` is the only runtime dependency. |
| Adapter | `src/plugin.ts` | The installed plugin. Wires opencode into core through the chat handle registry: event subscription, context-hook injection, synthetic-transcript filtering, tool registration. Thin and branch-free — every chat verb flows through a participant's handle. |
| Viewer | `src/cli.ts` | `agent-chat` CLI. Reads chat files directly; never imports the plugin. |
| TUI entry | `src/tui.ts`, `src/panel.tsx` | The in-TUI `/agent-chat` command. Resolves the active session's root chat and posts a windowed transcript notice (last 10 messages over 10) through `client.session.synthetic`; `/agent-chat full` opens a fullscreen `session.panel` self-rendering the full transcript. Thin adapter over `src/core/transcript.ts`. |

Runtime facts that shape this (all verified in `docs/research/`):

- Plugins run **in-process** in the opencode server; `bun:sqlite` works there
  (`v2-plugin-packaging.md`).
- `ctx.event.subscribe` is **live-only** — no replay. Membership hydrates on first sight of a
  session; there is no plugin-side session listing on the 2.0.x line (`v2-event-bus.md`;
  re-checked through 2.0.11 in `012-compat-surface.md`).
- The `context` hook fires **per model request** for main and subagent sessions, including
  mid-run tool continuations; injected text reaches the model but is **not persisted** in the
  transcript, so injections are regenerated every request (`v2-context-hook.md`).
- `session.inbox.*` is opencode's own prompt-admission queue. We do not fight or mirror it;
  we own our storage and viewer (`v2-session-inbox.md`).
- The TUI plugin entry (`@opencode/plugin/tui`) can register a slash command that runs local
  code; the keymap layer must be registered from an `app` slot render (a Solid owner), and
  TUI options arrive only through `cli.json` (`020-tui-command-surface.md`).

Flow for one message: an agent calls `chat_post` → core appends a row → (no push). At each
agent's next model request the adapter asks core for that participant's digest → core renders
and advances the cursor → the adapter pushes the text into `event.system` → the model reads
it and may call `chat_read` for full text.

## 3. Storage

- **Directory**: `chatDir` option; default `$XDG_DATA_HOME/opencode/chats`
  (`~/.local/share/opencode/chats` when unset).
- **File**: one per session, named `<session-id>.db` (ADR-0002). A chat's lifetime is exactly
  its session's; rows carry no `session_id` — the file is the scope.
- **Sandbox** (#18): `chatDir` is created `0700`; an existing dir is chmodded to `0700` at
  startup (warn to the debug log, never throw). The session file is **pre-created at `0600`
  before SQLite opens it** so WAL/SHM inherit `0600`, then defensively re-chmodded. A
  symlinked chat file is refused. The viewer is exempt: it lists every chat in the directory
  (it is the human's own tool).
- **Session id handling**: tools take no session argument. The file is derived from the
  calling session id, which must match `^[A-Za-z0-9_-]{1,128}$` and resolve to a direct child
  of `chatDir`; anything else is refused and logged. One chat is one file — no cross-chat
  reads.
- **Pragmas**: `journal_mode=WAL`, `busy_timeout=5000`, `synchronous=NORMAL`,
  `foreign_keys=ON`. One writer per file in practice (single in-process server), so writes
  are short; one statement per message.
- **Migrations** (#8): `PRAGMA user_version` plus ordered in-code migrations. Fresh-create and
  versioned upgrade are idempotent.
- **Retention**: keep every message for the session's life; no trimming in v1. Orphaned files
  are fog (§16).

```sql
CREATE TABLE messages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_type    TEXT NOT NULL,            -- 'agent' | 'system'
  sender_name    TEXT NOT NULL,
  sender_session TEXT,                     -- opencode session id; NULL for system
  kind           TEXT NOT NULL,            -- validated in code, never by CHECK
  to_name        TEXT,                     -- advisory recipient; NULL = everyone
  in_reply_to    INTEGER REFERENCES messages(id),
  body           TEXT NOT NULL,            -- size-capped at post time
  created_at     INTEGER NOT NULL          -- epoch ms
);
CREATE INDEX idx_messages_to ON messages(to_name);

CREATE TABLE cursors (
  agent_session TEXT PRIMARY KEY,
  agent_name    TEXT NOT NULL,
  last_read_id  INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);
```

`AUTOINCREMENT` guarantees ids are never reused (a cursor can never silently re-point).
Detail: tickets #8, #15, #18; ADR-0001, ADR-0002.

## 4. Message model

Kinds are validated in code (ADR-0001); the vocabulary can grow without a table rebuild.

| Kind | Posted by | Means |
|---|---|---|
| `status` | agent | a meaningful piece of work starts or ends |
| `finding` | agent | something verified that peers can rely on |
| `question` | agent | a fact or a decision the sender cannot reach alone |
| `answer` | agent | settles a question; replies via `in_reply_to` |
| `blocker` | agent | the sender cannot proceed; names what unblocks it |
| `handoff` | agent | work moves; names the owner and the state |
| `system` | plugin | membership change: `explore joined`, `explore left (completed)` |

- **Open question** is derived, never stored: a `question` with no `answer` whose
  `in_reply_to` is that message's id. The asker may answer their own question to close it.
- **Recipient** (`to_name`) is advisory: it shapes the digest and the protocol, not access.
  Naming no live participant is accepted with a note.
- **Body** is capped at `maxBodyChars` (default 4,000); over-cap posts are a hard error naming
  the limit.
- **Cursors**: one row per participant, keyed by session id, advancing only per §6.

## 5. Membership lifecycle

Event-driven; no plugin-side session listing exists on the 2.0.x line (ruling R1), so
membership hydrates on first sight of a session (`v2-event-bus.md`).

| Moment | Signal | Effect |
|---|---|---|
| Root session starts | `session.created` without `parentID` | the chat exists; root joins as `main` |
| Subagent spawned | `session.created` with `data.parentID` | child joins its root's chat (deeper nesting walks the parent chain) |
| Session running | `session.execution.started` | join/rejoin recorded (`<name> joined`) |
| Session reaches terminal | `session.execution.succeeded \| failed \| interrupted` | leave recorded (`<name> left (completed\|failed\|interrupted)`) |
| Plugin loads | — (no session listing; see §7) | sessions register on their first event, and each new child walks its ancestor chain so the chat root resolves; no synthetic events on restart |

- **Roster** is live-only: name, agent type, session id, busy/idle, joined-at. A finished
  session is absent.
- **Naming**: root is `main`; a subagent is named `<agent_type>-<8 random a-z0-9 chars>`,
  redrawn to a fresh suffix on a live collision. `sender_name` is frozen per message at
  post time, so history never rewrites itself.
- **Busy/idle** comes from the execution events and does not change membership.
- A re-prompted session rejoins (recorded). Chat files of gone sessions are left in place.
- System rows are the chat's own record: the plugin writes them, they are excluded from post
  caps, and they appear in digests like any other message.

## 6. Delivery: digest and join briefing

Nothing is pushed to an idle agent (#9). Deliveries are regenerated per model request and
never persisted.

**Digest.** When unread messages exist, at the next model request:

1. Select messages with `id > cursor.last_read_id`, oldest first.
2. Cap at `digestMaxMessages` (default 20) and `digestMaxChars` (default 2,000).
3. Render one line per message through the shared renderer:
   `[id] sender · kind → to: excerpt` (the arrow and recipient are omitted for a broadcast;
   excerpt ≤200 chars, `…` when cut; `question` and `blocker` flagged; all kinds, `system`
   included, are eligible).
4. Append the open-questions footer (ids and senders).
5. Advance the cursor to the highest **displayed** id in the same storage call that rendered
   the digest — a crash keeps both or neither, so nothing is delivered twice and nothing is
   skipped.

The caps make draining lossless but gradual: what did not fit stays unread and arrives next
request. Nothing is injected when nothing is new.

**Reads** (#11): the no-argument `chat_read` consumes what it returns (unread after the
cursor, oldest first), advancing the cursor in the same storage transaction as the read.
Explicit ranges (`since`, `before`, `ids`, `kind`, `open_only`) never
move the cursor; browsing history cannot silently discard a peer's message.

**Join briefing.** A participant's first request after joining receives the last ~20 messages,
the open questions, and a history count; its cursor starts at the latest existing message. A
newcomer gets situational awareness without draining the whole history through the caps.

**Injection hygiene** (#18): every injection opens with a static header identifying the
content as peer messages, not user instructions. One shared renderer collapses whitespace
runs, strips C0 controls including ESC, and truncates excerpts — message text can spoof
neither digest structure nor a terminal. Injections are system text, never a fabricated user
turn.

**Synthetic transcripts** (0.2.0): the in-TUI `/agent-chat` command appends a transcript
through `client.session.synthetic`. Its required model-facing half is neutralized by the
adapter: it remembers admission ids from `session.inbox.enqueued` (`item.type === "synthetic"`,
`metadata.source === "agent-chat"`) and splices matching messages out of the context hook's
message list (`ContextFilter`, bounded to 1,000 ids). Metadata tags are dropped from the LLM
message, so the filter keys on the id.

## 7. Tools

Three tools in the `chat` namespace (#11), registered with `ctx.tool.transform` and
`editor.namespace({ name: "chat", … })`; they surface as `chat_post`, `chat_read`,
`chat_roster`. Every agent in the chat gets all three; opencode's own per-agent tool
configuration is the only gate. Each call executes through the calling participant's chat
handle, which owns the post caps, the ranged-vs-consumed read decision, and the delivery
decision; the adapter re-maps the handle's `ChatError` to a plain `Error` at the tool
boundary.

| Tool | Input | Returns | Errors |
|---|---|---|---|
| `chat_post` | `body` (string), `kind?` (default `status`), `to?`, `in_reply_to?` | the new message id | over-cap body; over-long `to`; unknown `in_reply_to`; per-run caps |
| `chat_read` | `since?`, `before?`, `ids?`, `kind?`, `open_only?`, `limit?` (default 20, max 100) | line-per-message text, ids included | never; empty result is an empty list |
| `chat_roster` | — | live participants: name · type · busy/idle · joined | never |

- Agents cannot post `system`; only the plugin writes those rows.
- An explicit `open_only: false` is treated as no filter and takes the consuming unread path
  when it is the only argument (ratified 0.1.0 behaviour; omit the key to consume).
- Hydration is lazy (ruling R1: no plugin-side session listing): a session is registered on
  its first event and its ancestors are walked into the same chat. A tool call that arrives
  before its session's first event can see `not attached to a chat` once; the next event
  registers it and the call succeeds.
- Post caps (#12), enforced in the participant's chat handle (the only path into a post):
  `maxBodyChars` per post (4,000);
  `maxPostsPerRun` per agent execution run (25, reset each run, system rows excluded); a
  consecutive whitespace-identical post from the same sender in the same run is rejected
  with a reference to the earlier message. An over-limit post tells the agent to wrap up its
  run and summarize. A run's guard state is created on first use and evicted when the
  execution ends, so a missed `begin` cannot silently disable the caps.
- The tool descriptions carry the concise protocol (§9); the full rules are injected.

## 8. Config

All options ride the opencode `plugins` entry and arrive verbatim as `ctx.options`
(verified, `v2-plugin-packaging.md`). No separate project file.

```jsonc
// ~/.config/opencode/opencode.jsonc (global: on everywhere)
{ "plugins": [ { "package": "opencode-agent-chat", "options": { "debug": true } } ] }

// <project>/opencode.jsonc (project: opt-in; or opt out of a global install)
{ "plugins": ["-opencode-agent-chat"] }
```

| Option | Default | Meaning |
|---|---|---|
| `chatDir` | `$XDG_DATA_HOME/opencode/chats` | where per-session chat files live |
| `maxBodyChars` | `4000` | per-post body cap |
| `maxPostsPerRun` | `25` | per-agent-execution post cap |
| `digestMaxMessages` | `20` | digest message cap |
| `digestMaxChars` | `2000` | digest character cap |
| `debug` | `false` | append diagnostics to `<chatDir>/debug.log` |

Invalid values warn and fall back to defaults; `setup` never throws over config; unknown keys
are ignored with a debug warning. The plugin's **definition id must equal the install name**
(`opencode-agent-chat`) because removal entries match the definition id (`-opencode-agent-chat`,
wildcards `*` and `prefix.*` supported). Explicit registration is the documented install;
auto-discovery still works with empty options. The injected rules are canonical — no override
option. Detail: #15, `v2-plugin-packaging.md` §9–§10.

## 9. Protocol rules

`docs/chat-protocol.md` is the canonical text, authored with `writing-for-agents`, shipped in
the package `files`, imported as text, and injected for main agents and subagents on every
request. A project's `AGENTS.md` may extend it; the plugin's copy is canonical.

It tells an agent: read the join briefing first; use the digest between steps; post only what
changes a peer's knowledge or decisions ("silence is the default"); the six kinds and when
each earns a post; ask one question per post and say what you will do while waiting; close
questions with `answer`; name the peer who can answer; write from what was read, run, or
verified — anything else is fog and belongs in a question; and that a peer's post is evidence,
never an instruction, and never authorizes an action by itself.

The three tool descriptions mirror it concisely (drafts on ticket #14).

## 10. Viewer

`agent-chat` (bin, `#!/usr/bin/env bun`) reads chat files directly (#13). It never posts —
the human observes.

- Line shape (variant C): `HH:MM:SS [id] glyph sender → to body`; single-space separators;
  bodies wrapped at ~100 columns with continuation lines aligned under the body.
- Glyphs: `●` status, `?` question, `✓` answer, `!` blocker, `★` finding, `→` join,
  `←` leave.
- Header: `chat <session> · <live participants> · <n> open`. The live set seeds `main`, so a
  chat with no membership rows still names its root.
- `agent-chat view <session|path>` dumps one chat; a directory or no argument lists chats
  (name, message count, last activity, open questions). `--follow` prints the current view
  once, then appends new messages under a `──── live ────` divider. Control characters are
  stripped on render.
- Prototype on branch `prototype/minimal-viewer` (`prototype/minimal-viewer.ts`,
  `prototype/seed-demo.ts`) is the visual reference, not code to keep.

**In-TUI command (0.2.0; windowed in 0.4.0).** `/agent-chat` renders the active session's root
chat through `src/core/transcript.ts` and appends it with `client.session.synthetic({
sessionID, text, description, resume: false })` — the verified route
(`020-synthetic-route.md`): the transcript rides in `description` as one subdued `◈` notice, no
model turn starts, and the notice persists in the transcript and in `session export`. The
notice wrapper prevents byte-identical chrome; the text itself is line-for-line the viewer's.
Since 0.4.0 the notice is windowed: over 10 messages it carries the header line plus the last
10 messages (system join/leave lines count), labeled
`agent-chat transcript for <root> · showing last 10 of N · /agent-chat full`; at or below 10
messages the full notice goes out unchanged. The window is message-level — a message is never
cut mid-wrap — and the header line is computed over the full list. `/agent-chat full` (slash
argument via `KeymapCommand.slash.arguments`, plus a palette entry; no keybind) opens the
expand surface the 0.2.0 note anticipated: a fullscreen `session.panel` the plugin claims and
self-renders — a `agent-chat transcript for <root> · N messages` header over the full
transcript from the same renderer. The panel content is a Solid signal set on each open, so
re-invoking `/agent-chat full` re-reads and re-renders (refresh); closing is the host's panel
chrome. The TUI entry registers its keymap layer from an `app` slot render (a Solid owner; a
layer registered directly in `setup` registered nothing on 2.0.8) and reads `chatDir` from its
own `cli.json` options — `opencode.json` plugin options do not reach the TUI layer.

## 11. Testing and smoke loop

Detail: #16.

- **Unit**: `bun test`, no extra framework. Test files mirror `src/core/` modules (storage,
  protocol, digest, membership, handle, options, migrations, render, types, window,
   transcript), plus a viewer
  wrap/render contract test. The chat handle is the test surface for protocol, digest, and
  guard behaviour: the regression scenarios below run through its interface, not the
  internal functions. Each test gets a fresh **temp-file**
  SQLite (real WAL and `busy_timeout` behavior; `:memory:` hides it). Timestamps come from an
  injectable `now()`.
- **Smoke**: `bun run smoke [--scenario chat|config|all]`. Each scenario builds a temp
  project with isolated XDG dirs and a copied data-dir `credential` row (or runs fail with
  `Model unavailable`), mounts the plugin as a directory through the project config with
  `{ chatDir, debug: true }`, and runs
  `opencode run --standalone --format json --print-logs --auto --agent <probe-main>` with a
  prompt that spawns one subagent which posts a `finding` and a `question` (>200 characters,
  ending in a tail marker), then has main read that question by id, list the roster, and
  answer it. The chat assertions also prove the full question body came back from `chat_read`.
  Runs are bounded by `timeout`; exit 124 is acceptable once the plugin has loaded —
  assertions decide, and they read **artifacts, never stdout**.
  - `chat`: chat DB exists; kinds/senders/`in_reply_to` chains; join/leave system rows;
    digest injections in `debug.log`; a digest id quoted in the session export; exactly one
    plugin load/setup.
  - `config`: global add + project `"-opencode-agent-chat"` → not loaded; project add →
    loaded (pins the corrected removal semantics live).
- **Regression set**: lossless drain (50 unread over repeated digests, no gaps or dupes);
  exactly-once digest (rebuilding without advancing delivers nothing twice); membership
  hydration and reconcile (right roster, no replay, no synthetic rows); malformed input
  (unknown kind, over-cap body, unknown `in_reply_to`, multi-line and `[id]`-lookalike bodies
  that must not forge digest entries); migration idempotence; per-run caps.
- **The adapter has no unit tests**: every chat verb is a handle call, so it stays
  branch-free and is guarded by the smoke run.
- Gates are local (`bun test`, `bun run smoke`); no CI in v1.

## 12. Trust and safety

ADR-0003 governs. Chat content is **untrusted input**: the plugin executes nothing a message
contains (no tool call, no shell, no wake) and adds no permission hook — opencode's permission
layer sees tools and resources, not message provenance, so a provenance-based deny is
unimplementable and a blanket deny would break legitimate work. An agent weighs a peer's post
under its own instructions and normal permissions; the injected rules say so explicitly, and
so do the injections' header.

Files are user-private (`chatDir` 0700, session files 0600, debug log 0600); the session id is
whitelisted and confined to `chatDir`; symlinked chat files are refused. Rendering hygiene
(§6) defends the digest's structure and the terminal. All posts persist append-only for
audit, with no edit or delete in v1; reads only advance cursors.

## 13. Packaging and distribution

Detail: #17, `v2-plugin-packaging.md` §10.

| Field | Value |
|---|---|
| npm name | `opencode-agent-chat` |
| plugin id | `opencode-agent-chat` (must equal the install name; removal `-opencode-agent-chat`) |
| viewer bin | `agent-chat` |
| version | `0.5.0` (manual semver; `0.1.0` was the first release) |
| license | MIT |
| SDK | `@opencode/plugin` allowed the `~2.0.8` range (floor `2.0.8`); the dev lock stays at the floor, and each release re-proves the top of the range (scratch-worktree bump → `bun test` + typecheck, recorded on the release ticket) |

Root-as-package layout (no monorepo): `src/plugin.ts` (adapter), `src/core/` (pure core),
`src/cli.ts` (viewer), `src/tui.ts` + `src/panel.tsx` (TUI entry), `test/` mirrors core,
`smoke/` scenarios,
`flake.nix` devShell, `docs/chat-protocol.md` shipped via `files` (imported with Bun's
`{ type: "text" }`), design docs, ADRs and `CONTEXT.md` at the root.

Users install with `opencode plugin add opencode-agent-chat`; the host auto-installs bare npm
targets into its XDG cache, so nothing is pre-installed by hand. Dev/dogfood uses a config
path entry (`{"package": "/abs/path"}`); on 2.0.8 a local absolute directory target resolves
physical `<dir>/server` or `<dir>/index` files and ignores `package.json` `exports`, so the
repo ships root `server.ts` and `tui.ts` re-export shims for the repo-root target. npm installs
are unaffected: a package target resolves through `exports["./server"]` → `src/plugin.ts` and
`exports["./tui"]` → `src/tui.ts`. The
published `files` list ships `src/`, `docs/chat-protocol.md`, `README.md` and `LICENSE`;
the root shims are deliberately not shipped, because a directory target pointed into a published
tarball is not a supported install form. Release
is manual — bump, tag `vX.Y.Z`, `npm publish`, GitHub release notes. The npm token is a
granular access token in the user's `~/.npmrc` (`chmod 600`), never in the repo. A `flake.nix`
devShell is the supported dev environment; Nix packaging of the plugin itself is a follow-up.

## 14. Suggested build order

Each step lands with its tests; the adapter is last so its smoke run exercises a finished
core.

1. **Scaffold** — `package.json`, `flake.nix`, `bun test` runs (even with one trivial test).
2. **Storage** — `chatDir` sandbox, file open/create, pragmas, schema, migrations; unit tests
   on a temp file.
3. **Protocol** — post, read, roster, open-question query, caps; unit tests including
   malformed input.
4. **Renderer + digest** — shared rendering, caps, cursor advance, join briefing; unit tests
   prove lossless drain and exactly-once delivery.
5. **Membership** — event handling and hydrate-on-first-seen; unit tests over synthetic events.
6. **Adapter** — `Plugin.define`, event subscription, context hook, tool registration; tools,
   hook, and events visible in `debug.log`.
7. **Viewer** — `agent-chat` per §10; manual check against a seeded file.
8. **Smoke** — `chat` and `config` scenarios pass end to end.
9. **README** — the approved quickstart outline (#17): what it is, install, verify, options
   table, what agents see, mechanics, dev loop, v2-only limits.

## 15. Fog (deliberately not designed yet)

- Behaviour across session resume/restart: stale roster members and orphaned chat files.
- Retention beyond a session's life; per-session files accumulating under `chatDir`.
- Whether and when to add auto-wake of idle agents, and the budget caps it would need.
- Observability: error surfacing and how a user debugs a plugin that went silent.
- Performance at scale: many messages, many concurrent subagents.

## 16. References

- Tickets: the [map](https://github.com/kido5217/opencode-agent-chat/issues/3) and its 16
  children (#4–#19).
- Research (branch `research/wayfinder-charting`, `docs/research/`):
  `opencode-v2-plugin-api.md`, `v2-event-bus.md`, `v2-context-hook.md`,
  `v2-session-inbox.md`, `v2-plugin-packaging.md`.
- Prototype (branch `prototype/minimal-viewer`).
- `CONTEXT.md`, `docs/adr/0001–0003`, `docs/chat-protocol.md`.
