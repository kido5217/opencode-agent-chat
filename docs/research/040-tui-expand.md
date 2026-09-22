# The TUI's collapse/expand surface: windowed `/agent-chat` transcript, expand on click (0.4.0 research)

**Date**: 2026-09-22.
**Environment**: opencode v2.0.12 at `/etc/profiles/per-user/kido/bin/opencode` →
`/nix/store/mqbqyiflb6siw8bnyrfisn6wv0j62mlw-opencode-2.0.12/bin/opencode` — a 200,533,472-byte Bun
`--compile` ELF whose embedded JS is **not minified** (readable function bodies and string literals);
plugin SDK `@opencode/plugin` ~2.0.8 (local `node_modules`).

**Question** (ticket #67, part of map #66). What does the opencode TUI offer for a
collapsed-by-default, click-to-expand rendering of plugin-provided content, so the windowed
`/agent-chat` transcript (last 10 rendered lines + `· showing last 10 of N`, settled at charting) can
be opened to the full transcript?

**Verdict: the synthetic notice cannot collapse — the route is a plugin-rendered surface.**
`session.synthetic` exposes no collapse/expand/truncate field and the TUI renders the synthetic
`description` in full with no affordance (Q1). The plugin can render its own windowed/expandable
content in a fullscreen `session.panel` (Q2, Q4b) and drive it from a `keymap` command (Q4c). The
TUI's own collapse primitives are hand-rolled per renderer and not exposed to plugins (Q3).

| # | Question | Verdict |
|---|---|---|
| 1 | Collapse/expand/truncate field on `session.synthetic`? How does the TUI render the synthetic `description`? | **VERIFIED (negative)** — no such field on the input, inbox, or message types; the description renders in full as a ◈ "Notice" row, no truncation, no click affordance. |
| 2 | The plugin's rendering surfaces — what each renders, how a plugin opens them? | **VERIFIED** — `ui.slot` targets incl. `session.panel` (`panel\|fullscreen`), `ui.dialog.show`, `ui.router` plugin pages, `keymap.layer`/`dispatch`; declarations quoted verbatim below. |
| 3 | How the TUI's own `thinking` groups and long tool outputs collapse/truncate; is the primitive plugin-reachable? | **VERIFIED** — thinking: hand-rolled local-state collapse, collapsed by default, `+`/`-` click toggle; no generic primitive in the bundle; tool-output truncation is server-side, fixed defaults, global config only, static notice. |
| 4 | Ranked plugin-accessible routes to "windowed by default, expand on click"? | **VERIFIED** — (a) impossible on the notice; (b) fullscreen `session.panel` (recommended); (c) keymap/slash command; (d) built-in truncation not a route. |

## Method

- **Bundle strings**: the 2.0.12 ELF embeds non-minified JS, so exact strings were located with
  bounded byte-offset windows (`grep -abo <pattern>` + `tail -c +OFF | head -c N | tr -c '[:print:]' ' '`).
  TUI source lives around offsets 139M–170M; server/Effect services around 142M–144M.
- **SDK types (local)**: `@opencode/plugin@2.0.8` `dist/tui/context.d.ts` (459 lines, read verbatim)
  plus transitive deps `@opencode/client@2.0.8` and `@opencode/schema@2.0.8` (`dist/*.d.ts`).
- No live TUI probe was needed: every verdict rests on verbatim type declarations and verbatim
  bundle strings.

## Q1 — `session.synthetic` surface: VERIFIED (no collapse field; full, uncollapsible render)

**SDK types.** `node_modules/@opencode/client/dist/promise/client.d.ts:48`:

```ts
synthetic: (input: import("./index.js").SessionSyntheticInput, requestOptions?: OpenCode.RequestOptions)
  => Promise<import("./index.js").SessionInboxSynthetic>;
```

`SessionSyntheticInput` (`@opencode/client/dist/promise/generated/types.d.ts:5824`):

```ts
{ sessionID: string; id?: string; text: string; description?: string;
  metadata?: { [x: string]: JsonValue }; delivery?: "steer" | "queue"; resume?: boolean }
```

Result `SessionInboxSynthetic` (`types.d.ts:854`):
`{ id, sessionID, time: { created }, type: "synthetic", payload: { text, description?, metadata? },
delivery: "steer" | "queue" }`; promoted message `SessionMessageSynthetic` (`types.d.ts:128`):
`{ id, metadata?, time: { created }, text, description?, type: "synthetic" }` (same shape in
`@opencode/schema/dist/session-inbox.d.ts`). **No input, inbox, or message field controls
collapse/expand/truncation.** An exhaustive `grep -rniE 'collapse|expand|truncat|show.?more'` over
every `.d.ts` and `.js` in `@opencode/plugin/dist` returns **zero hits** — the SDK never mentions the
concept. (HTTP route in the bundle, offset ~137169043: `POST /api/session/:id/synthetic`, body
`{ id, text, description, metadata, delivery, resume }` — same surface.)

**Bundle render path (v2.0.12).** The timeline builder drops empty synthetics (offset ~140247737):

```js
if(O.type==="synthetic"&&!O.description?.trim())return C;
```

(the same guard guards the `session.synthetic` / `session.inbox.enqueued` event handlers). The row
renderer routes a synthetic message (non-skill) to component `Gc` (offset ~140300365), whose body
for our `metadata.source: "agent-chat"` case is:

```js
B=()=>r.message.type==="synthetic"?r.message.description??"":"";
… fallback: a(Jr,{icon:"\u25C8", color:m.text.muted, pending:"Notice", complete:!0, children: B()})
```

i.e. a `◈` (U+25C8; appears as the `\u25C8` escape in the bundle) icon, the muted label `Notice`,
and the **entire description text** — the text node is `flexGrow:1`, `wrapMode:"row"`: no
truncation, no windowing, no collapse. The shared notice header `Jr` (offset ~140260059) has no
general collapse/expand prop; its only expand affordance is `errorExpanded`, which expands error
text.

*One variant to rule out:* when `metadata.source` is `"subagent"` or `"shell"`, `Gc` instead renders
a single-line `↓ Subagent finished · <description>` truncated to terminal width
(`W=()=>j1(` · ${q()}`,Math.max(0,i.width-3-Pe(_())))`) whose click **navigates** to the child
session (`{type:"session",sessionID:childID}`). That is a navigation affordance, not expansion, and
it mislabels agent-chat content — not usable for the window.

## Q2 — Plugin rendering surfaces: VERIFIED

All from `node_modules/@opencode/plugin/dist/tui/context.d.ts` (2.0.8), verbatim.

**Slots** — `ui.slot(claim) => unsubscribe`; `SlotMap` (lines 161–179) is the full published list:

| Slot | Input |
|---|---|
| `app` | — |
| `home.footer`, `home.footer.status` | — |
| `prompt.footer` (+ `.status`, `.file`) | `{ sessionID?, mode: "normal" \| "shell", showDetails }` |
| `session.composer.top` | `{ sessionID }` |
| `session.panel` | `PanelInput` (below) |
| `sidebar.content`, `sidebar.footer` | `{ sessionID }` |

Claim placements: `prepend \| append \| before \| after \| replace` (mutually exclusive; `replace`
suppresses the original content and inner claims; at one target the last enabled claim wins).

**Panels** — `PanelInput` (lines 139–149):

```ts
{ name: string; sessionID: string; width: number;
  presentation: "panel" | "fullscreen"; focused: boolean;
  focus(): void; close(): void; toggleFullscreen(): void }
```

`ui.panel`: `open(name, { presentation? })`, `close()`, `current()`. A slot claim on
`session.panel` renders into the panel; its `presentation` selects the chrome.

**Dialogs** — `ui.dialog.show(render: () => JSX.Element, onClose?: () => void)`,
`ui.dialog.set({ size: "medium" | "large" | "xlarge", centered? })`, plus `alert/confirm/prompt/select`
helpers. Render functions return Solid JSX (`@opentui/solid`; `context.renderer` is the
`@opentui/core` `CliRenderer`), so a plugin can build arbitrary interactive content (headers,
clickable rows, its own windowed↔full toggle).

**Router** — `ui.router.register(page: { name, render(input: { data? }) })`, `navigate(destination)`,
`current(): Route`; routes (lines 112–122):

```ts
{ type: "home" } | { type: "session", sessionID: string } | { type: "plugin", id, name, data? }
```

**Keymap** — `context.keymap` (lines 373–393): `layer(fn => KeymapLayer)`, `dispatch(id, input?)`,
`shortcuts(id)`, `commands()`, `mode { current, push }`; `KeymapLayer` carries
`mode?, enabled?, target?, priority?, commands?: KeymapCommand[], bindings?`; `KeymapCommand`
(lines 321–347):

```ts
{ id?, title?, description?, group?, enabled?, bind?: false | string,
  palette?: true, slash?: { name: string; aliases?; arguments? }, suggested?,
  run(input?, event?) }
```

**Data** — `context.data.session.message.list` (plus `.get/.sync/.invalidate`) exposes the session
transcript to plugin render code; the plugin's own chat store is available to it as well.

## Q3 — The TUI's own collapse/truncation: VERIFIED (hand-rolled, not plugin-reachable)

**Thinking groups.** The reasoning-group renderer `Uc` (offset ~140285387): when the user setting
`thinkingMode()` is `"hide"` it renders the raw parts; otherwise a `Jr` header with
`icon: y()?"-":"+"` where `y` is a local Solid signal initialized `w(false)` — **collapsed by
default** — toggled by `onMouseUp:()=>{if(selection)return;D(q=>!q)}` (mouse click; label shows
`Thinking: …` / `· N steps` / `· duration`). Expanded, each reasoning part renders as a full `code`
block (left border, `paddingLeft:1`, syntax-highlighted). The state is local to that renderer —
no reusable primitive. Separately, the user config `mini.thinking: "show" | "hide"` (defaults at
offset ~158729000, `thinking:t?.mini?.thinking??"show"`; verbosity presets
`["quiet","default","everything"]` at ~158726600; persisted via
`m.update(i=>{i.mini[n.key]=n.value; …})` from the settings "Transcript" menu) only decides whether
thinking shows at all — it does not control collapsing.

**Generic primitive: none.** No `Collapsible`/`Expandable` component exists in the bundle; the only
general expand prop anywhere on the notice-row machinery is `Jr`'s `errorExpanded` (error text
only). `Uc`'s collapse is per-renderer local state — a plugin cannot reference it.

**Long tool output.** Truncation is **server-side** in `@opencode/ToolOutput` (offset ~143230905):

```js
var fd=2000,Id=51200,HU=gC(7),$d="tool-output";
```

with config `tool-output { maxLines, maxBytes }` (initial: those defaults; user-editable in the
config editor: `if(i.maxLines!==void 0)E.maxLines=i.maxLines`). It keeps the first `maxLines` lines
up to `maxBytes`, writes the full text to `tool-output/tool_<12hex>` under the data dir, and the
content ends `… N lines truncated; full content saved to <path>` — a **static notice**, no
click-expand (`metadata: { truncated: true, outputPath }`). `Shell.result` (offset ~143235454)
reads `tool_output.max_lines??fd` / `max_bytes??Id` (snake_case) and keeps the **last** n lines
(`LH.slice(-nH)`) plus `[output truncated; full output saved to: ${vH.file}]`. The only "Show
more" strings in the bundle are keybind help text ("Show more diff viewer shortcuts"). A plugin
cannot tune these per message; only the global config can.

## Q4 — Ranked routes to "windowed by default, expand on click": VERIFIED

| Rank | Route | Evidence |
|---|---|---|
| — (not a route) | **(a) Collapse the synthetic notice itself.** Not possible: no input/message field (Q1, `SessionSyntheticInput`), and the render path prints the full description with no expand prop on `Jr` (Q1, `Gc`/`Jr` bundle strings). |
| 1 | **(b) Plugin-rendered surface: `session.panel`, `presentation: "fullscreen"`.** Claim the slot and self-render the transcript with a `+`/`-` header — `· showing last 10 of N` ↔ full list, windowed↔full toggle on click, mirroring the TUI's own thinking-group affordance; data from the plugin's chat store or `data.session.message.list`; open via `ui.panel.open(name, { presentation: "fullscreen" })`. This is the DESIGN.md §10 fallback ("A fullscreen `session.panel` remains the fallback surface if the notice proves unusable for long chats"), now confirmed usable. Lighter variants: `ui.dialog.show` (size `xlarge`) as a modal, or a `ui.router` plugin page (`{ type: "plugin", name, data }`). |
| 2 | **(c) `keymap.layer` command.** A `KeymapCommand` with `bind` (key) and/or `slash: { name, … }` and/or `palette: true` whose `run` opens route (b)'s surface — or re-issues `session.synthetic` with the windowed description so the notice itself stays short; `keymap.dispatch(id)` triggers it programmatically. The synthetic notice row is not clickable, so (c) is the on-demand trigger that complements (b). |
| — (not a route) | **(d) Built-in tool-output truncation.** Server-side; fixed defaults 2000 lines / 51200 bytes; global `tool-output` config only; static notice with a file path — not plugin-influenceable per message, and the wrong mechanism for chat content (Q3). |

**Recommendation:** route (b) — a fullscreen `session.panel` with the self-rendered expandable
transcript — opened by route (c)'s keymap/slash command; the inline notice keeps the last-10
window, the panel shows the full chat.

## Primary sources

- SDK types (local 2.0.8): `@opencode/client/dist/promise/client.d.ts:48`;
  `@opencode/client/dist/promise/generated/types.d.ts:5824` (`SessionSyntheticInput`), `:854`
  (`SessionInboxSynthetic`), `:128` (`SessionMessageSynthetic`); `@opencode/schema/dist/session-inbox.d.ts`;
  `@opencode/plugin/dist/tui/context.d.ts` (112–122 `Route`, 139–149 `PanelInput`, 161–179 `SlotMap`,
  321–347 `KeymapCommand`, 373–393 `Keymap`, 394–441 `UI`).
- Bundle (v2.0.12 ELF, byte offsets): synthetic drop rule ~140247737; row routing ~140284404;
  `Gc` ~140300365; `Jr` ~140260059; thinking group `Uc` ~140285387; `mini` settings ~158726600 /
  ~158729000; `@opencode/ToolOutput` ~143230905; `Shell.result` ~143235454; HTTP route
  `POST /api/session/:id/synthetic` ~137169043.
- Repo: `DESIGN.md` §10 (viewer; fullscreen `session.panel` fallback); prior probe
  `020-synthetic-route.md` (branch `research/020-synthetic`).
