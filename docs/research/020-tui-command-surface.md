# `/agents-chat` in the TUI: feasibility and exact API (0.2.0 research)

**Question.** Can an opencode **v2** plugin (target `@opencode/plugin ~2.0.8`, dev bin `opencode2` 2.0.8) register a command the user types as `/agents-chat` that prints the current session's chat locally — no model turn — in the same format as the existing `agent-chat view` CLI? If yes, what is the exact API? If not, what is the closest route?

**Verdict: yes.** A v2 **CLI (TUI) plugin** does exactly this. Verified end to end on the installed `opencode2 v2.0.8` with a throwaway plugin: `/probe-chat` appeared in prompt slash completion, ran a local JS handler with no model turn, and printed output to a TUI dialog. The handler can resolve the active session, read the per-session SQLite chat file with `bun:sqlite`, and show text in a dialog, a plugin route, or a session panel.

Two caveats shape the implementation:

1. `context.keymap.layer(...)` must be registered from **inside a Solid component scope** (an `app` slot render), not directly from `setup()`. Direct registration produced no slash command on 2.0.8.
2. TUI-side plugin options (`chatDir`) arrive via **`cli.json`**, not via the `opencode.json` plugin entry. Options on the `opencode.json` entry were not visible to `context.options` on 2.0.8.

## Method

- Read the v2 docs pages (HTML, via scrape): <https://opencode.ai/v2/docs/build/plugins/cli> (the TUI/CLI plugin reference), `/v2/docs/build/plugins`, `/v2/docs/plugins`, `/v2/docs/commands`, `/v2/docs/cli/plugins`.
- Read the installed package's exact types: `node_modules/@opencode/plugin@2.0.8/dist/tui/{index,plugin,context}.d.ts`, `dist/promise/command.d.ts`, `dist/effect/command.d.ts`, `package.json` (`exports`), and `@opencode/schema/dist/plugin.js` (`Plugin.Info`).
- Diffed 2.0.8 against the npm `@opencode/plugin@2.0.11` tarball (`/tmp/opencode/plugin-211`) — the only `dist/tui` difference is one optional field (below).
- **Live probes** on the host binary `opencode2 v2.0.8` (`/etc/profiles/per-user/kido/bin/opencode2`), run in `tmux`, using throwaway plugins under `/tmp/opencode/` and an isolated `HOME=/tmp/opencode/probe-home`. No production code was touched.
- GitHub code search for real-world usage (`context.keymap.layer`, `slash:`), plus upstream repository files (`anomalyco/opencode`).

## Fact 1 — Plugin-provided TUI commands: VERIFIED

A v2 CLI plugin is a package (or file) exporting `Plugin.define({ id, setup(context) })` from `@opencode/plugin/tui`. It registers slash/palette/keyboard commands through a reactive keymap layer:

```ts
import { Plugin } from "@opencode/plugin/tui"

export default Plugin.define({
  id: "acme.cli",
  setup(context) {
    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "acme.status",              // stable command id
          title: "Show Acme status",
          group: "Acme",
          bind: "ctrl+g",                 // optional default keybind
          palette: true,                  // show in the command palette
          slash: { name: "acme", aliases: ["status"], arguments: true },
          enabled: () => true,
          suggested: true,
          run: async (input) => context.ui.toast.show({ message: input ?? "Ready" }),
        },
      ],
      bindings: ["acme.status"],          // activate config-configured keybinds
    }))
  },
})
```

Exact types (`node_modules/@opencode/plugin/dist/tui/context.d.ts`):

- `KeymapCommand` (lines 321–347): `id?`, `title?`, `description?`, `group?`, `enabled?: boolean | (() => boolean)`, `bind?: false | string`, `palette?: true`, `slash?: { name: string; aliases?: string[]; arguments?: true }`, `suggested?: boolean | (() => boolean)`, and
  ```ts
  run: (input?: string, event?: KeyEvent) => void | false | Promise<void>
  ```
  `slash` is documented as "Adds a named command to prompt slash completion"; `run` may return `false` to continue keyboard dispatch.
- `Keymap.layer(input: () => KeymapLayer): void` (line 375) — reactive layer owned by the calling component; layers are disposed with their owner.
- `Plugin.Definition` (`dist/tui/plugin.d.ts`): `{ id: string; setup(context: Context): Promise<Cleanup | void> | Cleanup | void }`.

Docs: <https://opencode.ai/v2/docs/build/plugins/cli> §"Commands and keymaps". Live probe (P1, below): `/probe-chat` appeared in the composer's slash completion (with title) and ran the handler.

**Registration-scope caveat (verified).** In probe P3, registering the same command directly inside `setup(context)` produced **no** command ("No matching commands" in the completion popup). Registering it from an `app` slot render (probe P1) worked. This matches the official "Session panels" example in the same doc page (layer registered inside an `app` slot render) and comments in several third-party plugins ("`setup()` runs OUTSIDE the Solid tree in this beta... built-in plugins do exactly this"). The doc page's "Commands and keymaps" example puts the layer in `setup()`; that example did not reproduce on 2.0.8.

## Fact 2 — Output mechanism: VERIFIED

Output surfaces exposed on `context.ui` (all local, no model turn):

| Surface | API | Notes |
|---|---|---|
| Toast | `ui.toast.show({ title?, message, variant?: "info"\|"success"\|"warning"\|"error", duration? })` | transient; 2.0.11 adds `sessionID?` (defaults title to session title and offers to open it) |
| Dialog | `ui.dialog.alert({title,message})`, `confirm`, `prompt`, `select`, and `show(render: () => JSX.Element, onClose?)` | `set({size, centered})`, `clear()`; custom JSX dialog |
| Plugin route/page | `ui.router.register({ name, render: ({data}) => JSX })` + `ui.router.navigate({ type: "plugin", name, data })` | full-screen route; `Route` type in `context.d.ts:112–131` |
| Session panel | `ui.slot({ append: "session.panel", render })` + `ui.panel.open(name, { presentation?: "panel"\|"fullscreen" })` | host owns layout/focus/fullscreen; `open` returns `false` outside a session; panel input carries `sessionID`, `width`, `presentation`, `focused`, `focus`, `close`, `toggleFullscreen` |
| Slots | `ui.slot({ prepend/append/before/after/replace: <path>, render })` | persistent inline UI (`app`, `prompt.footer`, `sidebar.content`, …) |

There is **no API to append text to the session message log**; output is an overlay/route/panel, not a conversation message.

No model turn: `run` is arbitrary local code; nothing in the handler needs to call a prompt API. Live probe P1 showed only a dialog, `sessions=0`, and no user prompt submitted.

## Fact 3 — Context available to a TUI plugin: VERIFIED

`Context` (`dist/tui/context.d.ts:442–458`):

- `options: Readonly<Record<string, any>>` — plugin options.
- `location: LocationRef | undefined`, `app: {version, channel}`, `renderer`, `theme`, `themeMode`.
- `client: OpenCodeClient` — "can call the connected server, including a remote server".
- `data` — `session.list()/get/root/family/cost/status()`, `session.message.list(sessionID)/get/sync`, `session.pending`, `session.permission`, `project`, `shell`, `location.*` (agents, commands, models, providers, skills, MCP), `on(type, handler)` / `listen(...)`.
- `keymap`, `storage` (durable `store`, ephemeral `memory`), `ui`, `attention`, `markdown`.

**Active session id.** No session field is passed to the command handler; the direct source is `context.ui.router.current()` → `Route` union, `{ type: "session", sessionID: string }` (`context.d.ts:112–125`, `current(): Route` at line 403). Live probe returns the current route object (observed `{"type":"home","location":{...}}` at home; the `session` variant is type- and doc-verified but was not reached live because no session could be opened without a model turn). Alternatives: `ui.tabs.list()` (`active: boolean`), and slot inputs (`PromptFooterInput.sessionID`, `PanelInput.sessionID`).

**Options (`chatDir`).** Live probes:

- opencode.json entry `{ "package": "/tmp/opencode/tui-probe", "options": { "chatDir": … } }` → `context.options === {}` (P1).
- `cli.json` entry `{ "package": "/tmp/opencode/tui-probe", "options": { "chatDir": "…", "marker": "cli-json" } }` → `context.options` contained both keys (P2).

Docs match: TUI plugin **options** are documented for `cli.json` (<https://opencode.ai/v2/docs/cli/plugins>), while `opencode.json(c)` plugins that expose a TUI component are auto-loaded by the CLI **without** an options path. `context.client.plugin.list()` cannot recover them either: `Plugin.Info` is `{ id?, source, features, state }` (`@opencode/schema/dist/plugin.js`) — no options field.

## Fact 4 — Alternative routes

**(a) Custom command files (`/v2/docs/commands`): do not satisfy the requirement.** `.opencode/commands/*.md` (the legacy singular `command/` directory is still discovered) expand a template and **submit a durable user prompt** — always a model turn. A `!`…`` shell block runs locally, but its output is inserted into that prompt before submission, so it is not a local print surface either.

**(b) Server-plugin command (`ctx.command.transform`): partial, no output channel.** In 2.0.8 (`dist/promise/command.d.ts`, `dist/effect/command.d.ts`):

```ts
ctx.command.transform((editor) => {
  editor.add({
    name: "security-review",
    description: "…",
    execute: async ({ sessionID, prompt, delivery }) => { … },  // Effect flavor: Effect.Effect<void, unknown>
  })
})
```

`execute` receives `{sessionID, prompt, delivery}` and is arbitrary code — it could avoid calling `ctx.session.prompt` and thus avoid a model turn — but it returns `void`, and the `CommandDefinition` has no rendering/output field. Nothing carries text to the TUI except a side channel (e.g., a custom event consumed by a TUI plugin). So it cannot on its own "print the chat", and it still needs a TUI component for display.

**(c) Keybinds and slots.** `bind` on the same `KeymapCommand` gives a keyboard shortcut to the identical handler; slots/panels render persistent UI. These complement the slash command rather than replace it. `context.markdown.registerCodeBlockRenderer` only styles fenced code inside host-rendered markdown; it is not a print surface.

## Fact 5 — What already works elsewhere; experimental status

- The official CLI-plugin doc example is itself a plugin slash command (`slash: { name: "acme", ... }`).
- Real-world open-source plugins registering `context.keymap.layer` slash/palette commands (GitHub code search, this session):
  `TTWK/opencode-tokenwatch` (`src/host/v2/commands.ts` — `/usage`), `alvinunreal/oh-my-opencode-slim` (`src/v2/tui.ts`), `cortexkit/magic-context` (`packages/plugin/src/v2/tui/index.ts`), `prevalentWare/opencode-goal-plugin` (`src/tui.ts`), `quangdang46/dynamic_context_pruning` (`opencode-dcp-plugin/lib/tui/commands.ts`), `leanderriefel/opencode-go-usage-plugin` (`src/tui.ts`), `omnicus/opencode2-mobile` (`packages/opencode-notification-plugin/src/tui.ts`), `betalyra/opencode-sandbox` (`src/tui.ts`), `timrichardson/opencode-btw` (`v2.ts`), `ranjithrajv/opencode-plugin-kit` (`src/commands.ts`). Several independently document the Solid-owner requirement.
- **Not marked experimental** in the v2 docs. Mechanics are identical across the target range: the 2.0.8→2.0.11 `dist/tui` diff is only `ToastOptions.sessionID?`.
- Version state: npm `@opencode/plugin` latest is **2.0.11**; host bin is **2.0.8**; both support everything above (no post-2.0.8 API needed).
- Namespace churn risk (UNVERIFIED as a direction, but present upstream): the public `anomalyco/opencode` main branch still ships the older **v1** TUI-plugin system (`@opencode-ai/plugin/tui`, `tui.json`, module `{id, tui}` with `(api, options, meta)`, `api.keymap.registerLayer` — see `packages/opencode/specs/tui-plugins.md`, `packages/opencode/src/plugin/tui/runtime.ts`, and `packages/plugin/package.json` at main, which is `@opencode-ai/plugin` 1.18.31). That is a *different namespace* from the v2 `@opencode/plugin/tui` API documented under `/v2/docs`. Do not mix them; pin `~2.0.8` and code against `@opencode/plugin/tui`.

## Recommended route (exact shape)

Add a TUI entrypoint to the package (`package.json` gains `"./tui": "./src/tui.tsx"`; OpenTUI peers as in the docs), register the keymap layer **from an `app` slot render**, resolve the session in the handler, read the chat DB, and show it on a plugin route (or panel).

```tsx
// src/tui.tsx
import { Plugin } from "@opencode/plugin/tui"
import { Database } from "bun:sqlite"

export default Plugin.define({
  id: "opencode-agent-chat",
  setup(context) {
    let registered = false
    const stop = context.ui.slot({
      append: "app",
      render: () => {
        if (!registered) {
          registered = true
          context.keymap.layer(() => ({
            mode: "global",
            priority: 10,
            commands: [
              {
                id: "agent-chat.view",
                title: "View agent chat",
                group: "Agent Chat",
                slash: { name: "agents-chat", aliases: ["agent-chat"] },
                run: async () => {
                  const route = context.ui.router.current()
                  if (route.type !== "session") {
                    context.ui.toast.show({ message: "no active session", variant: "warning" })
                    return
                  }
                  const chatDir =
                    (context.options.chatDir as string | undefined) ??
                    `${process.env.XDG_DATA_HOME ?? `${process.env.HOME}/.local/share`}/opencode/chats`
                  const db = new Database(`${chatDir}/${route.sessionID}.db`, { readonly: true })
                  const text = renderChat(db) // reuse the `agent-chat view` renderer
                  db.close()
                  context.ui.router.register({
                    name: "agent-chat.view",
                    render: ({ data }) => <text>{String(data?.text ?? "")}</text>,
                  })
                  context.ui.router.navigate({
                    type: "plugin",
                    name: "agent-chat.view",
                    data: { text },
                  })
                },
              },
            ],
          }))
        }
        return null
      },
    })
    return () => stop()
  },
})
```

Notes on the shape:

- **Session**: `ui.router.current()` is the source; `{type:"session", sessionID}` is the typed variant. `ui.panel.open` instead returns `false` outside a session, which also makes it a natural guard for a panel variant.
- **Panel variant**: register a `session.panel` slot, `ui.panel.open("agent-chat.view", { presentation: "fullscreen" })`; the panel input (`panel.sessionID`, `panel.width`, `panel.focus`, `panel.close`, `panel.toggleFullscreen`) is a better fit for long output than a dialog.
- **Output**: minimal first cut is `ui.dialog.alert` (plain text, no scrolling — long chats untested); a plugin route gives a full-screen page. The docs' route example renders `<text>`; scrolling-friendly OpenTUI primitives are not verified in this session.
- **Reading the chat**: `bun:sqlite` is available in the TUI plugin process (probe P4 read a row from a chat-like DB). This matches `src/core/storage.ts:1` and `src/cli.ts:2`.
- **Format reuse**: the CLI viewer's line renderer is `renderMessage(message, idWidth)` exported at `src/cli.ts:150`; `src/cli.ts:348` guards `main()` with `import.meta.main`, so importing the module does not run the CLI. Exact parity still needs its private helpers (`clock`, `chunks`, `GLYPHS`, `LINE_WIDTH`, `SENDER_MAX`, `TO_MAX`, `messageIdWidth`, `headerLine`) exported or moved to `src/core/render.ts`.
- **Options**: default `chatDir` (as above) so the TUI works without `cli.json`; document a `~/.config/opencode/cli.json` entry for overrides. The `opencode.json` options used by the server plugin are not visible to the TUI component.

## Blocking caveats (for a 2.0.8-compatible implementation)

1. **Solid owner requirement**: layer registration from `setup()` yields no command on 2.0.8 (probe P3). Use the `app`-slot pattern (probe P1) with a once-guard; keep the docs' `setup()` example out of the implementation until re-verified on a newer bin.
2. **TUI options only via `cli.json`** (probes P1/P2). A user who installs with `opencode2 plugin add opencode-agent-chat` and only edits `opencode.json` gets default `chatDir`; custom `chatDir` needs the cli.json entry (or another discovery path).
3. **Package shape**: 0.1.2 has no `./tui` export, so the TUI component will not load until 0.2.0 adds one (and OpenTUI/solid peer deps if JSX is used).
4. **No message-log injection**: the chat view is a dialog/route/panel overlay. If "prints the chat" must appear inline in the conversation, no such API exists in 2.0.8.
5. **Exact format parity needs a small refactor** of the viewer renderer out of `src/cli.ts` (not scoped in this research; no production code changed).
6. **Young API**: v2 doc-documented and stable across 2.0.8–2.0.11, but upstream main still carries the unrelated v1 TUI-plugin namespace; pin `~2.0.8`/`2.0.11` and avoid `@opencode-ai/plugin`.
7. **No session-route live capture**: active-session resolution is type-verified and `router.current()` was live-verified at the home route; the session branch could not be reached without sending a model prompt. Logic is trivial (`route.type === "session" ? route.sessionID : …`), but treat the end-to-end session case as type-verified, not probe-verified.

## Probe log (throwaway, /tmp only)

- **P1** — package `/tmp/opencode/tui-probe` (`index.ts` server + `tui.ts` slot-registered slash command `/probe-chat`), project `/tmp/opencode/tui-probe-project/opencode.json` with the path plugin + options. `opencode2 --standalone` in `tmux`: completion showed `/probe-chat`, Enter produced dialog `PROBE-RAN route={"type":"home"} sessions=0 options={}`.
- **P2** — same plugin, `HOME=/tmp/opencode/probe-home` with `cli.json` `{package, options:{chatDir,marker}}`: dialog showed `options={"chatDir":"/tmp/opencode/probe-chats","marker":"cli-json"}`.
- **P3** — second package `/tmp/opencode/tui-probe-direct` registering `context.keymap.layer` directly in `setup()`: completion showed "No matching commands" for `/probe-direct`.
- **P4** — plugin handler `import { Database } from "bun:sqlite"` opened `/tmp/opencode/probe-chats/test.db` read-only and read a row: `readback=hello-from-sqlite`.
- **P5** — built-in `/new` slash command exists but did not produce a session route (still home, `sessions=0`); no model prompt was sent.
- Version check: `/etc/profiles/per-user/kido/bin/opencode2 --version` → `opencode v2.0.8`; npm `@opencode/plugin` dist-tags `latest: 2.0.11`.

## Primary sources

- Docs: <https://opencode.ai/v2/docs/build/plugins/cli> (TUI plugin API: context, commands/keymaps, dialogs/toasts, routes/tabs, slots/panels, publish/load), <https://opencode.ai/v2/docs/build/plugins>, <https://opencode.ai/v2/docs/plugins>, <https://opencode.ai/v2/docs/cli/plugins>, <https://opencode.ai/v2/docs/commands>.
- Types: `node_modules/@opencode/plugin/dist/tui/context.d.ts`, `dist/tui/plugin.d.ts`, `dist/promise/command.d.ts`, `dist/effect/command.d.ts`, `package.json` (2.0.8); `@opencode/plugin@2.0.11` tarball (npm).
- Repo: `src/cli.ts:150` (`renderMessage`), `src/cli.ts:348` (`import.meta.main`), `src/core/storage.ts:1` (`bun:sqlite`), `package.json` (exports).
- Upstream: `anomalyco/opencode` `packages/opencode/specs/tui-plugins.md`, `packages/opencode/src/plugin/tui/runtime.ts`, `packages/plugin/package.json` (v1 namespace, main branch).
