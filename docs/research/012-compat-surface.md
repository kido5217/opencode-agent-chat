# 012 — 2.0.x compatibility surface

Research ticket: [kido5217/opencode-agent-chat#40](https://github.com/kido5217/opencode-agent-chat/issues/40).

Question: can `@opencode/plugin` be relaxed from the exact pin `2.0.8` to a 2.0.x range
(`~2.0.8`)? Method: diff the published npm artifacts `@opencode/plugin` 2.0.8 vs 2.0.11 and
their transitive `@opencode/*` dependencies, check host-binary availability, quote the current
v2 docs, and run the plugin's tests/typecheck against 2.0.11 in a scratch worktree.

Local baseline: host `opencode2 --version` prints `opencode v2.0.8` (2026-09-20).
npm `@opencode/plugin` publishes 2.0.0–2.0.11; `latest` = 2.0.11.

Artifacts were fetched to `/tmp/opencode/oc-compat`:

```sh
curl -s https://registry.npmjs.org/@opencode%2Fplugin/2.0.11 \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["dist"]["tarball"])'
# -> https://registry.npmjs.org/@opencode/plugin/-/plugin-2.0.11.tgz
tar -xzf plugin-2.0.11.tgz        # and the 2.0.8 tarball likewise
diff -rq pkg-2.0.8/package/dist pkg-2.0.11/package/dist
```

## 1. API drift — 2.0.8 → 2.0.11

### Verdict table

| Surface used by `src/plugin.ts` | Verdict | Evidence |
| --- | --- | --- |
| `Plugin.define` / `Cleanup` | **unchanged** | `dist/promise/plugin.d.ts` byte-identical (not in `diff -rq`) |
| `SubscribeOptions.signal` | **unchanged** | `@opencode/client` `dist/shared-events.d.ts` byte-identical: `readonly signal?: AbortSignal` |
| `ctx.session.get({sessionID})` → `id`/`parentID`/`agent` | **unchanged** | `dist/promise/session.d.ts` byte-identical; `@opencode/client` `dist/promise/api.d.ts` unchanged |
| `ctx.session.hook("context")` payload + `event.system` mutation | **unchanged** | `SessionHooks`/`SessionContext` byte-identical in `dist/promise/session.d.ts`; `SystemPart` schema unchanged in `@opencode/ai` `dist/schema/messages.d.ts` |
| `ctx.event.subscribe` names/payloads (`session.created`, `session.execution.started/succeeded/failed/interrupted`, `session.inbox.enqueued`) | **unchanged** | `@opencode/protocol` `dist/groups/event.d.ts`: all six names present 5× in both versions; only diff is union-member ordering of shell status (`"running"\|"exited"\|"timeout"\|"killed"` → `"timeout"\|"running"\|"exited"\|"killed"`), semantically identical |
| `ctx.tool.transform` / `ToolEditor` (`list/get/namespace/add/update/remove`) | **unchanged** | `dist/promise/tool.d.ts`: `ToolEditor` block byte-identical |
| `Tool.Result` / `Tool.Options` (`options.namespace`) / `Tool.Namespace` | **unchanged** | `@opencode/schema` `dist/tool.d.ts` byte-identical |
| `ctx.tool` domain | **additive** | 2.0.11 adds `ToolDomain.list(): Promise<readonly (Info & {id})[]>` (`dist/promise/tool.d.ts` + `dist/effect/tool.d.ts`); `dist/promise/adapter.js` wires it. New API, nothing removed |
| Host-version gate in published runtime | **none added** | no `engines`/`semver`/version-mismatch checks anywhere in `dist/*.js` of either version; `source.js`, `host.js`, `source.package.js` byte-identical |

### What actually differs between the two plugin packages

`diff -rq pkg-2.0.8/package/dist pkg-2.0.11/package/dist` reports exactly four files:

1. `dist/promise/tool.d.ts` — adds `ToolDomain.list` (above). Additive.
2. `dist/effect/tool.d.ts` — Effect twin of the same addition. Additive.
3. `dist/promise/adapter.js` — runtime mapping for `host.tool.list()`. Additive.
4. `dist/tui/context.d.ts` — `ToastOptions.sessionID?: string` (CLI/TUI only, additive). The
   server-side plugin never touches the TUI surface.

`package.json` bumps the pinned deps/optional peer `@opencode/theme` from 2.0.8 to 2.0.11
(all `@opencode/*` deps move in lockstep: `ai`, `client`, `protocol`, `schema`, `util`).

### Transitive drift (`@opencode/schema`, `-protocol`, `-client`, `-ai`, `-util`)

- `@opencode/schema` 2.0.8→2.0.11: only `agent.d.ts`, `model.d.ts`, `provider.d.ts`,
  `config/provider.*` differ. `dist/tool.d.ts` is byte-identical.
- `@opencode/protocol` 2.0.8→2.0.11: `groups/event.d.ts` differs only in shell-status union
  ordering; `groups/session.d.ts` likewise; `groups/agent.d.ts`, `groups/model.d.ts`,
  `groups/provider.d.ts`, `simulation.*` also differ but are outside this plugin's imports.
- `@opencode/client` 2.0.8→2.0.11: rebuilt with a chunk bundle (`dist/chunks/` appears).
  Type surfaces that matter here are unchanged: `dist/shared-events.d.ts` (subscribe options)
  is byte-identical, `dist/promise/api.d.ts` is unchanged, and the whole
  `dist/promise/generated/types.d.ts` diff (91 insertions / 89 deletions) contains no
  `SessionInfo`/`SessionCreated`/`SessionExecution*`/`SessionInboxEnqueued`/`parentID` change —
  it reshapes `ProviderCompaction`, `ProviderSettings`, `ModelSettings`, and adds `FormReplied`,
  `ReferenceInfo`. Client 2.0.11 service discovery still matches versions only when the caller
  passes `options.version` (`dist/promise/service.js`, `matchesVersion`), as in 2.0.8.
- `@opencode/ai` 2.0.8→2.0.11: diffs are confined to provider protocol adapters;
  `dist/schema/messages.d.ts` (home of `SystemPart`, used by `event.system`) is unchanged.
- `@opencode/util` 2.0.8→2.0.11: no `dist` diff at all.

### Runtime behavior notes

- `ctx.tool.transform(editor => …)` callbacks remain synchronous and `editor.list()` inside a
  transform is unchanged — the 2.0.11 addition is a separate `ctx.tool.list()` outside the
  transform. `src/plugin.ts:295-298` (`editor.list().filter(tool => tool.options?.namespace === "chat")`)
  keeps working.
- The `session.created` V2 event still carries `data.sessionID`, optional `data.parentID`,
  optional `data.agent` (protocol `groups/event.d.ts`), which is exactly
  `src/plugin.ts:135-141` destructures.
- No host-version gate exists in either published runtime; 2.0.8's no-gate behavior is retained.

## 2. Host binaries — can a live cross-version smoke run on 2.0.9/2.0.10/2.0.11?

**Obtainable via npm; not via nixpkgs; not via GitHub release assets.**

- nixpkgs `unstable` `opencode` is `1.18.31` (search.nixos.org via NixOS MCP, 2026-09-20) — the
  v1 line. No 2.0.x package/attribute is published in nixpkgs.
- Upstream repo `anomalyco/opencode` has tags `v2.0.0` … `v2.0.11` (git refs confirmed via
  `gh api repos/anomalyco/opencode/git/matching-refs/tags/v2.0`), but **no GitHub release
  objects** for them: `gh api repos/anomalyco/opencode/releases/tags/v2.0.11` returns 404 and
  the release list contains no `v2.0.x`. So no release-asset binaries.
- npm is the distribution channel for v2:
  - meta package `@opencode/cli`: versions 2.0.0–2.0.11 (`latest` = 2.0.11); `bin` maps both
    `opencode` and `opencode2` to `bin/opencode.exe`; optional platform packages
    `@opencode/cli-<os>-<arch>` (e.g. `@opencode/cli-linux-x64`) are pinned to the same version.
  - platform package `@opencode/cli-linux-x64` 2.0.9, 2.0.10, 2.0.11 all exist on the registry
    and each contains `package/bin/opencode`.

Verified working command (2026-09-20):

```sh
curl -sL https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-2.0.11.tgz | tar -xz
./package/bin/opencode --version
# -> opencode v2.0.11
```

The 2.0.11 Linux x64 binary is a 200,508,896-byte ELF and ran natively on this NixOS host.
2.0.9 and 2.0.10 tarballs list the same `package/bin/opencode` layout; their binaries were not
executed here. Conclusion: a live cross-version smoke against 2.0.9/2.0.10/2.0.11 is feasible
by installing `@opencode/cli@<version>` (or extracting the platform tarball) into a scratch dir.

## 3. Upstream guidance (opencode.ai/v2 docs, read 2026-09-20)

From <https://opencode.ai/v2/docs/build/plugins> ("Publish" section):

> A package plugin uses the same default export as a local plugin. A minimal manifest is:
>
> ```json
> {
>   "name": "opencode-acme-plugin",
>   "version": "1.0.0",
>   "type": "module",
>   "exports": { ".": "./src/index.ts", "./rpc": "./src/rpc.ts" },
>   "dependencies": { "@opencode/plugin": "latest" }
> }
> ```
>
> Use versions compatible with the OpenCode release you target and test the installed
> package, not only a workspace-linked copy. Publish a compatible plugin update when you
> adopt a newer API contract.

The same page's "Support V1" section says the V1 object form is supported in OpenCode
`1.18.29`, and that older V1 releases may expect function exports, so plugins should be tested
"with the oldest V1 release you intend to support and with V2".

From <https://opencode.ai/v2/docs/plugins>: package installation accepts "npm names with
versions, tags, or ranges"; unpinned npm plugins are checked for updates without changing the
installed package, while "exact npm versions and full Git commit hashes stay pinned".

No v2 doc page states a numeric minimum host version for `@opencode/plugin` 2.0.x; the guidance
is to keep the dependency compatible with the targeted OpenCode release.

## 4. Lock-bump result — 2.0.8 → 2.0.11 in a scratch worktree

Scratch checkout (main checkout untouched):

```sh
git worktree add /tmp/opencode/oc-compat/wt-012 -b research/012-compat main
cd /tmp/opencode/oc-compat/wt-012
nix develop -c bun add @opencode/plugin@2.0.11   # -> installed @opencode/plugin@2.0.11, saved lockfile
nix develop -c bun install                        # -> Checked 289 installs across 300 packages (no changes)
nix develop -c bun test                           # -> 96 pass, 0 fail, 251 expect() calls, 9 files
nix develop -c bun run typecheck                  # -> tsc --noEmit, exit 0
```

Result: **green, no breakages**. The lockfile moves `@opencode/plugin`, `-ai`, `-client`,
`-protocol`, `-schema`, `-util` from 2.0.8 to 2.0.11 (sha512 integrity changes only); no source
file in the repo needed a change, no test failed, and `tsc --noEmit` reported no error. The
`smoke` scenario was not run (it needs a host binary; both 2.0.8 and 2.0.11 hosts are available
per section 2, but it is outside this ticket's test scope).

The bump was reverted before committing, so this branch contains only this document.

## Bottom line

`@opencode/plugin` 2.0.11 is source- and type-compatible with every surface this plugin uses
that 2.0.8 provided; the only package-level deltas are additive (`ToolDomain.list`,
`ToastOptions.sessionID`). No runtime host-version gate is added. Relaxing the pin to `~2.0.8`
is supported by the artifact diff and by a green test/typecheck run against 2.0.11.
