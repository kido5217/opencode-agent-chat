# 0.1.1 nitpick inventory against `main`

- **Ticket**: [#29](https://github.com/kido5217/opencode-agent-chat/issues/29) — which candidate
  nitpicks from the 0.1.0 review cycle still exist on `main`, which are already fixed, and what new
  small defects or drift does a fresh read find?
- **Commit examined**: `178c8b49c767968534d6b45070f246f9376ec02a` (`v0.1.0`, `main` / `origin/main`),
  working tree clean.
- **Method**: read every tracked file at that commit — `src/core/*`, `src/plugin.ts`, `src/cli.ts`,
  `smoke/run.ts`, all eight test files, `package.json`, `README.md`, `DESIGN.md`, `CONTEXT.md`,
  `docs/chat-protocol.md`. API claims were checked against the pinned `@opencode/plugin` `2.0.8`
  typings in `node_modules`, the SQLite transaction default against Bun's docs/source, and file modes
  against `git ls-files --stage`. The commit's gates pass (`nix develop -c bun test`: 84 pass / 0 fail;
  `bun run typecheck`: clean), so nothing below is a failing test.
- **Tally**: 39 candidates — **still present: 39** (T2 only partially: the guard exists at 3 of the 5
  `try/catch` assertion sites and is missing at 2), **already fixed: 0**, **newly found: 3**.

## Core

| # | Candidate | Verdict | Evidence |
|---|---|---|---|
| C1 | Dead `messageCount` export | **still present** | `src/core/storage.ts:106-109`; repo-wide search finds no caller (only the definition and the old plan doc) |
| C2 | `getMessage(...) as Message` non-null assertion | **still present** | `src/core/protocol.ts:80` casts a `getMessage` result that is typed `Message \| null` (`:127-130`) |
| C3 | Non-integer `limit` falls back to 20 instead of clamping | **still present** | `src/core/protocol.ts:48` returns `DEFAULT_READ_LIMIT` for any non-integer, so `limit: 5.5` → 20, not 5 |
| C4 | `RunGuard.runs` never evicted | **still present** | `src/core/protocol.ts:154` map; `begin` only overwrites (`:161`) and nothing deletes, so one entry per session lives for the plugin's lifetime |
| C5 | Unbegun `RunGuard.check`/`record` are silent no-ops | **still present** | `src/core/protocol.ts:166` and `:183` (`if (run === undefined) return;`); a missed `begin` silently disables both caps |
| C6 | `MESSAGE_COLUMNS` duplicated into `digest.ts` | **still present** | byte-identical literals at `src/core/protocol.ts:40` and `src/core/digest.ts:12`; the protocol copy is not exported |
| C7 | `buildJoinBriefing` ignores `limits.maxChars` | **still present** | `src/core/digest.ts:33-57` reads only `limits.maxMessages` (`:49`); `maxChars` is passed in (`src/plugin.ts:182`) but never used |
| C8 | `db.transaction` uses the default deferred mode | **still present** | plain `db.transaction(fn)` at `src/core/digest.ts:40`, `:66` and `src/core/migrations.ts:39`; Bun's default is plain `BEGIN` (deferred), with `.immediate()`/`.exclusive()` available (Bun SQLite docs, "Specify transaction modes"; `src/js/bun/sqlite.ts`) |
| C9 | `isLive()` asymmetry on unresolved roots | **still present** | `src/core/membership.ts:55-58` sets `live`/`busy` before the `root === null` return, so `isLive()` (`:106`) is true while `roster()` (`:110-124`) drops the unnamed member; only the never-started case is tested (`test/membership.test.ts:248`) |
| C10 | `reconcile` never demotes absent/`live:false` entries | **still present** | `src/core/membership.ts:73-86` only promotes sessions with `live: true`; a member already `live` in the map and absent (or `live: false`) in the list keeps `live = true`, `busy = true` |
| C11 | Repeated `executionStarted` while live re-emits a join row | **still present** | `src/core/membership.ts:51-61` has no already-live guard; `assignName` returns the frozen name and `:60` appends another `"<name> joined"` with no intervening leave row; rejoin tests only cover a start after `executionEnded` (`test/membership.test.ts:139`) |

## Tests

| # | Candidate | Verdict | Evidence |
|---|---|---|---|
| T1 | Briefing tests nested under `describe("buildDigest")` | **still present** | `test/digest.test.ts:10` block holds `buildJoinBriefing` cases at `:14`, `:51`, `:60` |
| T2 | `try/catch` assertions lack `expect.unreachable()` | **still present (partial)** | missing at `test/protocol.test.ts:47` and `:57`; present at `:35`, `:145`, `:152` |
| T3 | Tests assert only 2 of the 4 required pragmas | **still present** | `test/storage.test.ts:40-41` checks `journal_mode` and `busy_timeout` only; `openChat` sets four (`src/core/storage.ts:66-69`) |
| T4 | `test/types.test.ts` asserts runtime only despite its narrowing name | **still present** | `test/types.test.ts:12-16` only calls `expect(isKind(...))`; nothing exercises the `value is Kind` narrowing |

## Adapter

| # | Candidate | Verdict | Evidence |
|---|---|---|---|
| A1 | `open_only: false` counts as absent (consuming) | **still present** | `src/plugin.ts:243-248` requires `q.open_only === true` to enter the ranged branch, so an explicit `false` falls through to the consuming unread read (`:260-265`). The 0.1.0 ruling keeps the behaviour; only its documentation is in scope (see D-group) |
| A2 | Hydration race on a first tool call for pre-subscription sessions | **still present** | hydration happens only from the event stream (`src/plugin.ts:127-170`, `hydrate` at `:113`); tool handlers assume membership exists (`:203`, `:240`, `:278`) and throw `not attached to a chat` when a call arrives first |
| A3 | Hydrate does not walk the parent chain | **still present** | `src/plugin.ts:113-125` calls `ctx.session.get` for the one session and never recurses through `parentID`; a pre-subscription ancestor stays unknown |
| A4 | `editor.namespace({name:"chat"})` description not registered | **still present** | tools set `options.namespace = "chat"` (`src/plugin.ts:199`, `:236`, `:276`) but no `editor.namespace(...)` call exists; the API supports `{ name, description }` (`@opencode/plugin/dist/promise/tool.d.ts:22`; `@opencode/schema/dist/tool.d.ts:17-20`) |
| A5 | `setup` returns no Cleanup | **still present** | `src/plugin.ts:70-291` returns nothing; `Cleanup` is a supported return (`@opencode/plugin/dist/promise/plugin.d.ts:54-57`) and the event subscription (`:127`) plus the `dbs` map (`:83`) have no teardown |

## Viewer

| # | Candidate | Verdict | Evidence |
|---|---|---|---|
| V1 | Unbroken tokens can exceed 100 columns | **still present** | `src/cli.ts:111-125` `chunks` never splits a word longer than the width; the width floor is 40 (`:137`) |
| V2 | Follow id-padding drifts across poll batches | **still present** | each poll derives padding from its own batch (`src/cli.ts:235`), while the initial dump uses all messages (`:310`) |
| V3 | `--dir` accepts a following `-` token | **still present** | `src/cli.ts:157-162` assigns `argv[i + 1]` with no leading-dash check, so `--dir --follow` silently consumes the flag |
| V4 | `listChats` leaks a handle when a query throws mid-read | **still present** | `src/cli.ts:207-219`; `db.close()` sits on the success path (`:212`) and the catch (`:217`) reports without closing |
| V5 | `src/cli.ts` mode `100644` | **still present** | `git ls-files --stage src/cli.ts` → `100644`, though it is the `bin` (`package.json:8`) and carries a shebang (`src/cli.ts:1`) |
| V6 | Usage text flattened by `sanitize` | **still present** | `src/cli.ts:35-38` sanitizes the whole message; callers pass multi-line `\n${USAGE}` strings (`:159`, `:169`, `:170`, `:271`, `:279`) |
| V7 | `>100`-message paging unexercised | **still present** | `src/cli.ts:75-85` pages at `READ_PAGE = 100`; `test/` has no viewer test and nothing else records a >100 run |

## Smoke

| # | Candidate | Verdict | Evidence |
|---|---|---|---|
| S1 | Config scenario never inspects the run's exit code | **still present** | neither `removalRun.exitCode` nor `addRun.exitCode` is asserted (`smoke/run.ts:491-505`, `:512-521`); the codes appear only inside messages (`:500`, `:519`). The chat arm checks only 124 (`:359`) |
| S2 | `sessionRows` swallows query errors and returns 0 | **still present** | `smoke/run.ts:276-288`; the catch at `:283-285` returns 0, so a malformed DB reads as "no sessions" |
| S3 | Hard dependency on the host `models-dev:catalog` kv row | **still present** | `smoke/run.ts:246-250` reads and asserts the row from the host DB; no fallback and no README/DESIGN statement of the requirement |
| S4 | Per-run temp dirs never cleaned and success prints no path | **still present** | `mkdtempSync` at `:346`, `:486`, `:507`; no `rmSync`/cleanup anywhere in `smoke/`, credential material copied at `:240-273` (auth at `:273`), and success prints only `PASS <scenario>` (`:551`) |
| S5 | The two config arms duplicate scaffold | **still present** | `smoke/run.ts:486-505` and `:507-521` repeat the scaffold → mount → seed → run sequence with only names changed |

## Docs and packaging

| # | Candidate | Verdict | Evidence |
|---|---|---|---|
| D1 | README: `chatDir`'s `~/.local/share` fallback unstated | **still present** | `README.md:50` documents `$XDG_DATA_HOME/opencode/chats`; the fallback lives only in `src/core/options.ts:26` |
| D2 | `--scenario all` undocumented | **still present** | `README.md:87-88` names `chat` and `config` only; `all` is accepted (`smoke/run.ts:536`) |
| D3 | First-request join briefing unmentioned | **still present** | `README.md:57-64` describes only digests; the join-briefing branch is `src/plugin.ts:184-187` and is defined in `CONTEXT.md:47` |
| D4 | Viewer's Bun runtime unstated | **still present** | `README.md:15-19` / `:36-44` present the installed `agent-chat` bin with no runtime note; the bin is `#!/usr/bin/env bun` (`src/cli.ts:1`) |
| D5 | `typescript: "^7.0.2"` is caret-ranged | **still present** | `package.json:25`; `@opencode/plugin` is pinned exactly (`:21`) and `DESIGN.md:323` states the deliberate-pin discipline |
| D6 | `package.json` `files` omits `server.ts` | **still present** | `package.json:14` lists `src`, `docs/chat-protocol.md`, `README.md`, `LICENSE`; `server.ts` exists and is the target of a directory mount (`smoke/run.ts:194-202`), but the decision is undocumented |
| D7 | `DESIGN.md` §11 still describes the smoke chat scenario as only posting/answering | **still present** | `DESIGN.md:282` says the prompt "posts a `finding` and a `question`, then has main answer"; the prompt also calls `chat_read`/`chat_roster` (`smoke/run.ts:40-50`) and asserts a full-body read (`:447-482`) |

## Newly found

| # | Finding | Evidence |
|---|---|---|
| N1 | The 100-column contract can be broken even after V1's hard-break: `to` is accepted with no length cap (`src/plugin.ts:207`), rendered uncapped (`src/cli.ts:133`), and the body width floor is a constant 40 (`src/cli.ts:137`) — a long recipient name makes every wrapped line exceed the target width | `src/plugin.ts:207`, `src/cli.ts:133-138` |
| N2 | `openChat`'s file `chmodSync(path, 0o600)` is unguarded (`src/core/storage.ts:64`) while the directory chmod is a warned best-effort (`:22-26`); a chmod failure aborts `openChat` and with it context injection and every chat tool, rather than warning. May be deliberate fail-closed for file privacy — worth a ruling | `src/core/storage.ts:22-26`, `:64` |
| N3 | `DESIGN.md:273` lists the mirrored core modules as "storage, protocol, digest, membership, options, migrations"; `render` and `types` also have test files (`test/render.test.ts`, `test/types.test.ts`), so the list reads stale next to the §11 sentence D7 corrects | `DESIGN.md:273-274` |

## Ownership map

| Owner ticket | Items |
|---|---|
| **Fix the core hygiene nits** (#30) | C1, C2, C3, C4, C5, C6, C7, C8, C9, C10, C11 |
| **Close the test-coverage nits** (#31) | T1, T2, T3, T4 |
| **Polish the adapter nits** (#32) | A2, A3, A4, A5 |
| **Polish the viewer nits** (#33) | V1, V2, V3, V4, V5, V6, V7 (+ the render half of N1) |
| **Polish the smoke harness nits** (#34) | S1, S2, S3, S4, S5 |
| **Polish the docs and packaging nits** (#35) | D1, D2, D3, D4, D5, D6, D7, plus A1's documentation half (`open_only: false` is a ratified 0.1.0 behaviour; only its doc gap is in scope) |
| **Decide the open-questions footer cap** (#36) | not one of the 39: the adjacent uncapped-footer issue is already tracked there |
| **Unowned** | N1's input-cap half (a cap on `to` in `src/plugin.ts:207` is not in #32's or #30's list); N2 (the unguarded file chmod); N3 (the stale §11 module list — #35's "docs read true" acceptance could absorb it, but no ticket names it) |
