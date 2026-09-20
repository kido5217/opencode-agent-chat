# OpenCode V2 plugin API — research notes

Researched 2026-09-20 on this host (NixOS), for a plugin targeting **opencode v2 only**.
Evidence order: installed package → official v2 docs → npm packages shipped with it → source repo.

## 1. Version and installation

- `opencode --version` → `1.18.31+014614d` (V1). `which opencode` →
  `/etc/profiles/per-user/kido/bin/opencode` → `/nix/store/kxlsfbdgj742jm3niqbwi07893d8vn1n-opencode-1.18.31+014614d/bin/opencode`.
- `opencode2 --version` → `opencode v2.0.8` (the target). `which opencode2` →
  `/nix/store/dg787j4sa7hmxrgmcp0n2vajwmv3cbg3-opencode2-2.0.8/bin/opencode2`.
- The store path contains a single 212 MB native binary (no JS sources, no `.d.ts`, no README).
  `file` → ELF, not stripped; embedded strings show **Bun v1.4.2** — the server is a compiled Bun binary.
- V1 and V2 coexist as separate products/commands (`opencode` vs `opencode2`).
- Types are **not** shipped with the binary. They come from the npm package `@opencode/plugin`.

### CLI facts (`opencode2 <cmd> --help`)

- `opencode2 debug paths`:
  `data=/home/kido/.local/share/opencode`, `config=/home/kido/.config/opencode`,
  `cache=/home/kido/.cache/opencode`, `state=/home/kido/.local/state/opencode`,
  `db=/home/kido/.local/share/opencode/opencode.db`. `XDG_CONFIG_HOME` / `XDG_DATA_HOME` are honoured
  (verified with a dry run in a temp dir).
- `opencode2 plugin list|add|check|update|remove` manages package plugins globally.
- `opencode2 plugin list --builtin` lists the server's built-in plugin ids, e.g.
  `opencode.agent`, `opencode.config.instruction`, `opencode.prompt.meta`,
  `opencode.mcp.codemode.exclusion`, `opencode.plan` — built-ins are plugins too.
- Other relevant subcommands: `serve` (v2 API/web server), `run`, `session`, `debug agents|config|paths`.

## 2. Docs and source map

V1 docs (not the target): `https://opencode.ai/docs/…` (e.g. `/docs/plugins`).
V2 docs root: `https://opencode.ai/v2/docs`; plugin pages:

- Overview: `https://opencode.ai/v2/docs/build/plugins`
- Configure/discover/manage: `https://opencode.ai/v2/docs/plugins`
- RPC: `https://opencode.ai/v2/docs/build/plugins/rpc`
- V1 → V2 migration: `https://opencode.ai/v2/docs/build/plugins/migrate-v1`
- Effect variant: `https://opencode.ai/v2/docs/build/plugins/effect`
- Also used: `/v2/docs/agents`, `/v2/docs/instructions`, `/v2/docs/tools`, `/v2/docs/api`.

No `llms.txt`, no raw `.md` endpoints (404). Pages are static HTML.

Source repo: `github.com/anomalyco/opencode` (monorepo, `packages/*`).
V2 runtime sources live in `packages/opencode/src/plugin/` (`index.ts`, `loader.ts`, `install.ts`,
`shared.ts`, `meta.ts`, plus built-in provider plugins). The published **V2** package is a separate
npm artifact (`@opencode/plugin`); the repo's `packages/plugin` is the **V1** package
(`@opencode-ai/plugin`, v1.18.31) which also carries experimental `./v2/*` exports.

Published package versions (npm registry):

| Package | Version | Notes |
|---|---|---|
| `@opencode/plugin` | **2.0.8** | V2 API, exact match for installed opencode2 2.0.8 |
| `@opencode/client` | 2.0.8 | context/client domains |
| `@opencode/protocol` | 2.0.8 | event schemas (`groups/event.d.ts`, ~14.7k lines) |
| `@opencode/schema` | 2.0.8 | `Agent`, `Session`, `SessionMessage`, `Tool`, `PromptInput`, … |
| `@opencode-ai/plugin` | 1.18.31 | V1 (docs import `@opencode/plugin` for V2 only) |

`@opencode/plugin@2.0.8` exports: `.` (promise), `./effect`, `./host`, `./tui`, `./*`
(includes `/rpc` → `dist/rpc`). Deps pin `@opencode/{ai,client,protocol,schema,util}@2.0.8`,
`effect@4.0.0-rc.112`, `zod@4.1.8`, `@ai-sdk/provider@3.0.8`.

## 3. Authoring a V2 plugin

### File layout and registration

- Auto-discovered (no config needed):
  - project: any discovered `.opencode/plugins/` directory — direct `.ts`/`.js` files and immediate
    package directories (e.g. `.opencode/plugins/acme-package/`).
  - global: `~/.config/opencode/plugins/`.
- Config `plugins` array in any `opencode.jsonc` (global `~/.config/opencode/opencode.jsonc`,
  project `opencode.jsonc`, `.opencode/opencode.jsonc`). Arrays merge low→high precedence.
  Entries: npm name, `name@1.2.0`, scoped `@acme/opencode-plugin`, relative/absolute dirs or files,
  `file://…`, or `{ "package": "...", "options": { ... } }` (read via `ctx.options`).
  A `plugins/` dir next to a project-root `opencode.jsonc` is **not** auto-discovered.
- Disable control: prefix with `-`; `*` = all; `.*` = id prefix; a later id re-enables.
- CLI: `opencode plugin add opencode-acme-plugin@1.2.0` etc. (npm, git, `github:org/repo#ref::path:`).
  Package plugins are compatibility-checked against the OpenCode version; local file plugins skip the gate.
- Reload: watched config dirs reload automatically; server startup loads cached package plugins
  immediately and installs missing packages in the background.

### Minimal skeleton (official, includes required stable id)

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "example",
  async setup(ctx) {
    await ctx.storage.set("loaded", true)
  },
})
```

- `setup(ctx)` runs when the plugin loads; it may return a cleanup function run on unload.
- Every plugin needs a stable `id`; storage is scoped by it.
- `ctx.app` = `{ name, version, channel }`; `ctx.location` =
  `{ directory, workspaceID?, project: { id, directory, canonical } }`.
- The context "is essentially an OpenCode server client": read/action methods mirror the client API
  plus plugin-only transforms, hooks, reloads, registrations and options.

### Verified loader behaviour (empirical probe, /tmp scratch project)

- Server log on startup: `msg="loading plugin" id=…/.opencode/plugins/bus-probe entrypoint=file://…/index.ts`.
- With no `node_modules` in the project, load **fails**:
  `Cannot find package '@opencode/plugin' imported from …/index.ts` → local plugins must have the
  package (or a local copy of the types) resolvable from the plugin directory / project root.
- After `bun add @opencode/plugin@2.0.8` in the project root the plugin loaded with no error and
  `setup()` ran (verified by its storage side effect; see §9).
- `console.log` from `setup` did **not** appear in `--print-logs` output (routing unverified).

## 4. Hooks (exact names and signatures)

Source of truth: `@opencode/plugin@2.0.8` `dist/promise/*.d.ts`, package docs pages.

Registration returns a `Registration` (`{ dispose(): Promise<void> }`); `dispose()` is idempotent.
Multiple plugins may register the same hook; they run in plugin registration order, later hooks see
earlier changes.

### Session hooks — `ctx.session.hook(name, cb, options?)`

`SessionDomain.hook = ModelHooks<SessionHooks>`: for hooks whose payload has `model`, an optional
`{ providerID?: string }` scope is accepted.

```ts
interface SessionPrompt {            // "prompt"
  readonly sessionID: Session.ID
  readonly messageID: SessionMessage.ID
  prompt: PromptInput.Prompt         // mutable: text, files, agents mentions, skills
  metadata?: Record<string, unknown>
  delivery: "steer" | "queue"
}
interface SessionRequest {           // base for context/generate/title/compaction
  readonly sessionID: Session.ID
  readonly model: Model.Ref          // { providerID, id, variant? }
  system: SystemPart[]
  messages: Message[]
  options: GenerationOptionsFields & Record<string, unknown>   // typed + provider options
}
interface SessionContext extends SessionRequest { readonly agent: Agent.ID; tools: Record<string, { description, input: JsonSchema }> }
interface SessionCompaction extends SessionContext { result?: { summary: string; providerState?; metadata?; tokens? } }
interface SessionGenerate extends SessionContext {}
interface SessionTitle extends SessionRequest { result?: string }
interface SessionModelRequest { readonly sessionID; readonly agent; readonly model; readonly kind: "primary"|"compaction"|"title"|"generate"; baseURL?: string; headers: Record<string,string> }
interface SessionHttpRequest  { …; request: Request }
interface SessionHttpResponse { …; readonly request: Request; response: Response }
interface SessionWebSocketHandshake { …; url: string; headers: Record<string,string> }
interface SessionWebSocketSend / Receive { …; frame: string }
interface SessionRetry { …; readonly error: SessionError.Error; readonly attempt: number; decision: { retry:false } | { retry:true; delay:number } }

interface SessionHooks {
  prompt: SessionPrompt            // admission of user prompts (see below)
  context: SessionContext          // agent loop model requests (both)
  compaction: SessionCompaction
  generate: SessionGenerate
  title: SessionTitle
  "model.request": SessionModelRequest
  "http.request": SessionHttpRequest
  "http.response": SessionHttpResponse
  "experimental.ws.handshake" | "experimental.ws.send" | "experimental.ws.receive"
  retry: SessionRetry
}
```

Notes from docs:

- `context` runs for the agent loop incl. tool-driven continuations; each auxiliary flow
  (`compaction`, `generate`, `title`) has its own hook with the same payload base.
- Mutations affect only the outgoing model call, not persisted history. `options` starts empty per
  call; typed keys are generation settings, any other key is passed to the protocol as a provider
  option. Deleting/`undefined` falls back to configured defaults.
- `prompt` runs after location plugins are ready, before attachment/skill resolution and durable
  inbox admission; commands that submit through `session.prompt` run it; synthetic messages, shell,
  compaction and move controls do not. Hooks are retry-unsafe: retrying an already pending/delivered
  id returns the original admission without rerunning. Edits become the canonical persisted input.
- `retry`: `attempt` is 1 for the initial request; hooks can make a terminal failure retryable or
  veto a retry; built-in max attempts stay a hard limit.
- WebSocket hooks are explicitly experimental.

### Tool hooks — `ctx.tool.hook(name, cb)`

```ts
interface ToolHooks {
  "execute.before": {
    tool: string
    readonly sessionID: Session.ID
    readonly agent: Agent.ID
    readonly messageID: SessionMessage.ID
    readonly id: Tool.CallID
    input: unknown
  }
  "execute.after": { tool; sessionID; agent; messageID; id; input } &
    ({ status: "completed"; result: Tool.Result } | { status: "error"; error: Tool.Error })
}
```

### Permission hook — `ctx.permission.hook("evaluate", cb)`

```ts
interface PermissionEvaluation {
  readonly sessionID: Session.ID
  readonly agent?: Agent.ID
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly metadata?: Record<string, unknown>
  readonly source?: Permission.Source
  effect: "allow" | "ask" | "deny"
  message?: string
}
```

Runs after configured rules, for allow and ask decisions; an explicit configured `deny` is final and
does not invoke the hook. A hook may change the effect and add a message.

### Shell hook — `ctx.shell.hook("create.before", cb)`

```ts
interface ShellCreateBefore { command: string; cwd: string; timeout: number; shell: string; env: Record<string, string|undefined> }
```

### Other hook-ish extension points

- `ctx.aisdk.hook("sdk" | "language", cb)` → override the AI SDK model/language instance
  (`{ model, package, options, sdk? }` / `{ model, sdk, options, language? }`).
- `ctx.session.hook("context", …)`, `ctx.agent.transform`, `ctx.tool.transform` (see §5), etc.

### App/session/message lifecycle: no dedicated hooks

There are **no** `session.created` / `message.updated` / `task.*` hooks. Lifecycle is observed via
the event stream (`ctx.event.subscribe()` — §8) plus `session.context` / `session.wait`.

## 5. Custom tools

```ts
await ctx.tool.transform((editor) => {
  editor.add({
    name: "greeting",
    description: "Create a greeting",
    input: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    async execute(input) {
      return { content: `Hello ${(input as { name: string }).name}!` }
    },
  })
})
```

`ctx.tool` domain:

```ts
interface ToolDomain {
  transform(cb: (editor: ToolEditor) => void): Promise<Registration>
  reload(): Promise<void>
  hook: Hooks<ToolHooks>
}
interface ToolEditor {
  list(): readonly (Info & { id: string })[]
  get(id): (Info & { id: string }) | undefined
  namespace(namespace: { name: string; description: string }): void
  add(tool: Info): void
  update(id: string, update: (tool) => void): void   // missing ids ignored
  remove(id: string): void
}
```

`Info` (promise form) = `@opencode/schema/tool` `Info` with `execute` retyped:

```ts
execute: (input, context: ToolContext) => Promise<Tool.Result<Output>>
// ToolContext: { sessionID, agent, messageID, id, progress(update): Promise<void> }
```

- `input` may be an Effect `Schema.Codec`, any Standard-Schema validator (Zod/Valibot/ArkType), or
  plain JSON Schema.
- `Result` = `{ output?, content?: string | ReadonlyArray<{type:"text",text} | {type:"file",uri,mime,name?}>, metadata? }`.
- `options`: `{ namespace?, permission?, codemode?, pinned? }`.
- Tool ids are namespaced (`acme_greeting`); a later valid registration overrides the same effective
  name. `registration.dispose()` removes it; plugin unload disposes all registrations.

## 6. Injecting text into a specific agent's system prompt

Three mechanisms, by use case:

1. **Runtime, per agent (recommended for a chat bus).** The `context` hook carries
   `readonly agent: Agent.ID`; filter on it and push a text part:

   ```ts
   await ctx.session.hook("context", (event) => {
     if (event.agent !== "reviewer") return
     event.system.push({ type: "text", text: "New chat-bus messages are available." })
   })
   ```

   Applies only to the outgoing call; register per flow (`context` for the main loop, plus
   `generate`/`title`/`compaction` if those should see it). The same hook sees subagent calls with
   the subagent's id.

2. **Configuration transform, persisted.** `ctx.agent.transform((editor) => editor.update("reviewer",
   (a) => { a.system = "…" }))` mutates `Agent.Info.system` (and `editor.default(id)`, `remove(id)`).
   Docs: a non-empty `system` replaces the provider's base prompt for that agent, but project
   instructions, skills, references and other instruction sources are still added.

3. **Prompt/session input** (not system prompt): `ctx.session.prompt({ sessionID, text, delivery })`
   and `ctx.session.synthetic({ sessionID, text, description? })` (docs: synthetic messages skip the
   `prompt` hook). `ctx.session.command({ sessionID, command, arguments })` for configured commands.

AGENTS.md: the docs describe instruction assembly per session, in order: agent/provider system prompt
→ built-in environment/date context → Code Mode guidance → global and project `AGENTS.md` → skill/
reference/MCP guidance → session-specific instruction entries supplied through the API. `AGENTS.md`
is loaded from `~/.config/opencode/AGENTS.md` plus project files from workspace toward home/project
root; nested files are discovered as the agent reads directories. **Not verified in source whether a
subagent child session loads project AGENTS.md** — docs imply it (subagents "run with fresh context
in foreground or background child sessions", and agent `system` docs say instruction sources are
still added), but this was not directly confirmed.

## 7. Subagents in v2

- The tool is named **`subagent`** (not `task`). Input: configured agent id, short `description`,
  complete `prompt`. `background: true` returns immediately and notifies the parent when the child
  finishes; foreground calls wait. The result carries the child `sessionID`, which can be passed
  again to continue the same child conversation. Default nesting depth is one. Permission action:
  `subagent` with the agent id as resource.
- Agents have `mode: "primary" | "subagent" | "all"`; project agents live in
  `.opencode/agents/<name>.md` (nested path becomes part of the id) or the `agents` config map.
  Built-ins: `build`, `plan` (primary), `general`, `explore` (subagent); hidden maintenance agents
  `compaction`, `title`, `summary`. V2 has no `scout`.
- Sessions: `Session.Info` has `id` and optional **`parentID`**, plus `projectID`, `agent?`, `model?`,
  `fork?`, `title`. A subagent runs in its **own child session with fresh context** — it does not
  share the parent's message stream. The parent sees it via the `subagent` tool call/result.
- Observing subagents from a plugin:
  - `ctx.event.subscribe()`: `session.created` for the child (payload has `parentID`), then that
    session's `session.execution.*`, `session.step.*`, `session.text.*`, `session.tool.*`,
    `session.usage.updated`, `session.idle` / `session.status`.
  - `ctx.tool.hook("execute.before"/"execute.after")` where `event.tool === "subagent"` — exact
    input/result of the spawn, including the returned session id.
  - `ctx.session.context({ sessionID })` reads any session's messages (incl. child);
    `ctx.session.wait({ sessionID })` blocks until completion; `session.get` resolves `parentID`.
  - There is no `task.*` / `subagent.*` event namespace (see §8).

## 8. Runtime, client and events

- **Runtime:** plugins are imported into the OpenCode server process. Repo `packages/opencode/src/plugin/loader.ts`
  does `await import(row.entry)` after resolving/installing the target; npm plugins are
  version-gated (`checkPluginCompatibility`) and installed on demand, file plugins are not gated.
  The server binary embeds **Bun v1.4.2**, so Bun builtins (e.g. `bun:sqlite`) are available to plugin code.
- **Context object** (`promise/plugin.d.ts`): domains `app`, `location`, `options`, `agent`, `aisdk`,
  `command`, `event`, `experimental.terminal`, `integration`, `mcp`, `model`, `generate`,
  `permission`, `plugin` (list only), `provider`, `reference`, `rpc`, `session`, `shell`, `skill`,
  `storage`, `tool`, `vcs`, `websearch`, `worktree`.
- **Sessions domain** (promise plugin): `create`, `get`, `switchAgent`, `switchModel`, `prompt`,
  `generate`, `command`, `synthetic`, `interrupt`, `update`, `move`, `wait`, `context`, plus
  `hook`. (The full HTTP client has more: `session.list/remove/fork/diff/inbox/instructions/message/form/...`,
  but the plugin domain is the `Pick` above.)
  - `session.prompt(input)`: `{ sessionID, text, id?, files?, agents?, skills?, metadata?, delivery?: "steer"|"queue", resume? }`
    → `SessionInboxUser`.
  - `session.synthetic(input)`: `{ sessionID, text, description?, metadata?, delivery?, resume? }`.
  - `session.create(input?)`: `{ id?, title?, agent?, model?, location?, metadata?, permissions? }` → `SessionInfo`.
  - `session.context({ sessionID })` → `SessionMessageInfo[]`; `session.wait({ sessionID })`.
- **Event bus:** `ctx.event.subscribe(options?: { signal?: AbortSignal; onActivity?: () => void }): AsyncIterable<OpenCodeEvent>`.
  `OpenCodeEvent` is the `V2EventEncoded` / `EventSubscribeOutput` union. Envelope fields:
  `id`, `created`, `metadata?`, `type`, `location?` (`{ directory, workspaceID? }`), `data`, `durability`.
  Subscribe once and filter by `event.type` and `event.data.sessionID`.
  Event names in `@opencode/protocol@2.0.8` (discriminants, deduped):

  | Group | Events |
  |---|---|
  | Session lifecycle | `session.created`, `session.deleted`, `session.idle`, `session.status`, `session.viewed`, `session.moved`, `session.renamed`, `session.forked`, `session.agent.selected`, `session.model.selected`, `session.permissions`, `session.instructions.updated`, `session.skill.activated`, `session.synthetic` |
  | Execution / steps | `session.execution.started`, `…succeeded`, `…failed`, `…interrupted`; `session.step.started`, `…streamed`, `…ended`, `…failed` |
  | Text / reasoning | `session.text.started`, `…delta`, `…ended`; `session.reasoning.started`, `…delta`, `…ended` |
  | Tools | `session.tool.called`, `…input.started`, `…input.delta`, `…input.ended`, `…progress`, `…success`, `…failed` |
  | Inbox | `session.inbox.enqueued`, `…delivered`, `…cancelled`, `…delivery.changed` |
  | Compaction / retry / shells | `session.compaction.started`, `…delta`, `…ended`, `…failed`; `session.retry.scheduled`; `session.shell.started`, `…ended` |
  | Revert / usage | `session.revert.staged`, `…committed`, `…cleared`; `session.usage.updated` |
  | Other domains | `agent.updated`, `command.updated`, `config.updated`, `credential.updated`, `…switched`, `form.created`, `…replied`, `…cancelled`, `installation.update-available`, `…updated`, `integration.updated`, `mcp.status.changed`, `…resources.changed`, `model.updated`, `permission.asked`, `…replied`, `plugin.updated`, `project.updated`, `provider.updated`, `pty.created`, `…updated`, `…exited`, `…deleted`, `reference.updated`, `retry`, `server.connected`, `skill.updated`, `tui.*`, `vcs.branch.updated`, `websearch.updated`, `worktree.resolved`, `…updated`, `filesystem.changed`, `location.shutdown`, `models-dev.refreshed` |

  RPC events are namespaced `rpc.<rpc-id>.<event>`.
- **RPC (plugin-defined API):** `import { Rpc } from "@opencode/plugin/rpc"`,
  `const reg = await ctx.rpc.register(Acme, handlers)`, then `ctx.rpc(Acme).search({...})` locally,
  `reg.events.emit("updated", data)`, and externally `client.rpc(Acme)` over HTTP. Subscriptions:
  `rpc.events.on(name, cb)` / `events.subscribe(name)` (live only; unload closes them).
- **Disclaimer on the event stream:** GitHub issue `anomalyco/opencode#44788` (against a
  `0.0.0-beta-18050` server) reports `ctx.event.subscribe` delivering no events and `context` hook
  mutations not reaching the model. Not reproduced on 2.0.8 here; treat as a risk to re-verify.

## 9. Where plugin state lives / storage / SQLite

- **Official KV storage:** `ctx.storage` = `get(key): Promise<Json|undefined>`, `set(key, Json)`,
  `remove(key)`, `scan({ prefix, after?, limit? }) → { entries: [{key,value}], next? }`. It is scoped
  by plugin id.
- Observed persistence (probe + this host): stored in the server's SQLite DB
  `~/.local/share/opencode/opencode.db`, table `kv`, key
  `plugin:<utf16le-hex(plugin-id)>:<key>`. Example probe row:
  `"key":"plugin:0062...0065:probe"` → `{"sqlite":"ok:hello","version":"2.0.8"}`.
  A V1-era directory `~/.local/share/opencode/storage/plugin/<id>/` also exists on this host
  (written by the V1 DCP plugin); V2 `ctx.storage` uses the DB.
- **No official SQLite/storage API in the SDK beyond the KV store.** The server itself uses SQLite
  (`packages/effect-drizzle-sqlite`, `effect-sqlite-node`; migrations run at startup:
  `database schema bootstrap started/completed`), same `opencode.db` (13 GB on this host — don't
  touch/share it).
- **`bun:sqlite` works inside a plugin — empirically verified** (probe did
  `const { Database } = await import("bun:sqlite")`, created a table, inserted and read back
  `hello`; result was written via `ctx.storage`).
- Recommended placement for this project's SQLite chat bus: a dedicated DB file, not `opencode.db` —
  e.g. under the project's `.opencode/` (project-local, travels with config) or under the OpenCode
  data dir keyed by plugin id. `ctx.options` can point it elsewhere. Plugin config location for this
  repo: global `~/.config/opencode/plugins/` or project `.opencode/plugins/`; if packaged, add
  `@opencode/plugin` to the plugin's `dependencies` and install via `opencode plugin add`.
- Useful env: `OPENCODE_DISABLE_PROJECT_CONFIG=1` skips project `AGENTS.md` discovery (docs);
  XDG vars move config/data dirs (verified via `debug paths`).

## 10. Examples to model after

- Official docs snippets (all on the pages above): minimal `Plugin.define` skeleton; greeting custom
  tool; `context` hook pushing a system part and deleting a tool; `prompt` hook rewriting text and
  adding a file; `retry` hook; `permission.evaluate` hook using `ctx.generate.text`; RPC plugin
  (define → register → emit → call → subscribe); publish `package.json` manifest; dual V1/V2 export
  (`{ ...Plugin.define({...}), async server() {...} }`).
- Repo built-ins: `packages/opencode/src/plugin/` (`loader.ts`, `install.ts`, `shared.ts`, `meta.ts`,
  provider plugins `azure.ts`, `cerebras.ts`, `openai/`, `github-copilot/`, …) and
  `packages/opencode/src/plugin/tui/`. Enumerate with `opencode plugin list --builtin`.
- Real-world V2 plugins (ecosystem, found via code search):
  `@tarquinen/opencode-dcp` (installed here), `opencode-beads`, `alibaba/open-code-review`
  (`plugins/open-code-review/opencode/open-code-review.ts`), `smartfrog/opencode-froggy`,
  `NeuralNomadsAI/CodeNomad` (`packages/server/src/opencode/session-pruning/plugin.ts`),
  `vectorize-io/hindsight` (`opencode2.ts` harness).
- Repo's own `.opencode/plugins/tui-smoke.tsx` is a **TUI** plugin example, not a server plugin.

## 11. Explicitly unverified / caveats

- Subagent child sessions loading project `AGENTS.md`: docs imply yes, not source-verified.
- `console.log` routing from a plugin `setup` was not visible with `--print-logs`.
- Exact `data` payloads of streaming events (`session.text.*`, `session.tool.*`) were partially
  extracted; use the hook payload types in §4 when exactness matters.
- The GitHub issue about a silent event stream / no-op context hook is on a beta build, not 2.0.8;
  re-test on 2.0.8 before relying on `subscribe`.
- `@opencode/plugin` must be installed/resolvable; the installed `opencode2` binary does not bundle
  it, and local plugins fail to load without it.
- The main repo branch version numbered 1.18.31 even though it hosts V2 sources; the npm
  `@opencode/plugin@2.0.8` artifact (not the repo's `packages/plugin`) is the authoritative API for
  installed 2.0.8.
