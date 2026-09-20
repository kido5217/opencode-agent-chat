# V2 plugin packaging, loading, configuration, and smoke-test loop — verified notes

Researched 2026-09-20 on this host (NixOS), target **opencode2 v2.0.8**
(`/nix/store/dg787j4sa7hmxrgmcp0n2vajwmv3cbg3-opencode2-2.0.8/bin/opencode2`).
Method: source at tag `v2.0.8` (`github.com/anomalyco/opencode`, sha `7673ed6bd6547ee0dcb81aab55f1392fb751d652`),
official v2 docs, npm registry, and empirical probes in `/tmp/opencode/pkg-probe` (p1–p9) with
**isolated XDG dirs** (`XDG_CONFIG_HOME=$P/iso/config`, `XDG_DATA_HOME=$P/iso/data`,
`XDG_CACHE_HOME=$P/iso/cache`, `XDG_STATE_HOME=$P/iso/state`).

Every item below is labelled **VERIFIED** (probe output this session) or **UNVERIFIED** (docs/source
only, or not reproduced). The v1-era notes in `docs/research/opencode-v2-plugin-api.md` were treated
as hypotheses and re-tested; corrections are called out.

---

## 1. Discovery — where a local plugin is looked for (VERIFIED)

Directories scanned for local plugins, per discovered config root:

| Root | Scanned dirs |
|---|---|
| project | `<project>/.opencode/plugin/` **and** `<project>/.opencode/plugins/` |
| global | `~/.config/opencode/plugin/` **and** `~/.config/opencode/plugins/` (XDG_CONFIG_HOME respected) |

- Both **singular and plural** directory names are scanned — verified (p8 loaded `.opencode/plugin/singular.ts`;
  source `packages/core/src/plugin/source-directory.ts`: `names = ["plugin", "plugins"]`).
- Accepted children: files ending `.ts`/`.js` (loaded directly) and **immediate package directories**
  (p1 direct file, p5/p9 package dirs).
- `$XDG_CONFIG_HOME` substitutes cleanly for `~/.config` (p2 global probe, `debug paths` output).
- A `plugins/` dir next to a project-root `opencode.jsonc` is **not** auto-discovered (docs
  `https://opencode.ai/v2/docs/plugins`; source-consistent — only `<config-root>/.opencode/…` roots
  are enumerated). UNVERIFIED by direct probe.
- `opencode2 serve` alone loads **no** plugins: activation needs a session/location, i.e. a `run`
  (VERIFIED: bare `serve --port 0` bootstraps the DB, logs no `loading plugin`).

### Entrypoint resolution inside a package dir (VERIFIED, p5)

For a directory target, resolution order is `server` → `main`/`index` → `tui` → `rpc`
(source `packages/plugin/src/host.ts`). A `package.json` `exports["./server"]` wins over `index.ts`:
p5 had both, and `server.ts` was loaded (`entrypoint=file://…/server.ts`). A directory without a
resolvable entry fails with `Plugin entrypoint not found: <target>` (source `module.ts`).

### Config `plugins` array (VERIFIED)

Entries tested in `.opencode/opencode.jsonc`:

```jsonc
{ "plugins": ["./plugins/local-dir", "/abs/path/dir", { "package": "./plugins/opt-probe", "options": { "strict": true } }] }
```

- **Relative dir** and **absolute dir** targets load (p4b).
- **Relative and absolute file targets are rejected** (p4/p4b) with
  `level=WARN message="configured plugin path must be a directory" target=<resolved absolute path>`.
  This **contradicts the current docs**, which still show `"../shared/plugin.ts"` and
  `"/absolute/path/plugin.ts"` as valid values (`https://opencode.ai/v2/docs/plugins`). On 2.0.8 the
  value must be a directory (containing `index.ts`/`server` entry, or a package).
- `{ "package": …, "options": … }` object form works, and `ctx.options` receives the object verbatim (p3).
- Bare npm spec string works (`"opencode-beads@0.8.0"`, p6); resolution/install via the npm service.
- Explicit config is applied **after** auto-discovery; a directory that is both auto-discovered and
  listed in config is loaded **twice** — once with `options: {}` (discovery) and once with the config
  options (p3: two `loading plugin` lines; the later/config marker won). To pass options, either keep
  the plugin outside the auto-discovered dirs or accept the double load.
- `file://` directory targets and git specs are handled by source (`packages/core/src/config/plugin/source.ts`,
  `packages/util/src/npm.ts`) but were not exercised; see UNVERIFIED.

---

## 2. Making `@opencode/plugin@2.0.8` resolvable (VERIFIED)

`@opencode/plugin@2.0.8` **is on npm** (`npm view @opencode/plugin@2.0.8`: dist-tag `latest` is
2.0.11, tarball `https://registry.npmjs.org/@opencode/plugin/-/plugin-2.0.8.tgz`; runtime deps
`@opencode/{ai,client,protocol,schema,util}@2.0.8`, `effect@4.0.0-rc.112`, `zod@4.1.8`).
The server binary does not bundle it; plugins must resolve it themselves.

Without it, load fails with exactly:

```
level=WARN message="failed to load plugin" target=…/.opencode/plugins/probe.ts ref=err_<8hex>
cause="Cause([Die(ResolveMessage: Cannot find package '@opencode/plugin' imported from …/.opencode/plugins/probe.ts)])"
```

Three verified ways to make it resolvable (Bun resolves from the plugin file upward):

1. **Repo/project root** (for `.opencode/plugins/*.ts`): `bun add @opencode/plugin@2.0.8` at the
   project root creates `package.json` (`{"dependencies":{"@opencode/plugin":"2.0.8"}}`), `bun.lock`,
   `node_modules` (~271 packages, ~2 s, "Blocked 1 postinstall"). Load then succeeds (p1).
   `npm install @opencode/plugin@2.0.8` also works (p2 did this in the global config dir).
2. **Global config dir** (for `$XDG_CONFIG_HOME/opencode/plugins/*.ts`): `npm install` / `bun add`
   inside the config dir gives `$XDG_CONFIG_HOME/opencode/node_modules` and resolves (p2).
3. **Self-contained package dir** (recommended for a plugin that lives in this repo, which has **no
   root `package.json`**): put the plugin at `.opencode/plugins/<name>/` with its own `package.json`
   and run `bun add @opencode/plugin@2.0.8` **inside that directory** (p9: `node_modules` under the
   plugin dir, `server.ts` loaded, marker written). No repo-root manifest needed. When the network
   stalls, `bun add --offline @opencode/plugin@2.0.8` succeeds from bun's cache.

Dependency placement:
- For a **published** plugin, declare `@opencode/plugin` in `dependencies`: the npm service reifies
  the package with arborist `saveType: prod` and the plugin's imports resolved from the cache
  (VERIFIED indirectly: `opencode-beads@0.8.0` installed to
  `$XDG_CACHE_HOME/opencode/npm/opencode-beads@0.8.0/<gen>/node_modules/opencode-beads` and its
  imports resolved; it failed only on export shape).
- `peerDependencies` vs `devDependencies` semantics are **not documented and not tested** — for local
  dev the only requirement is that resolution succeeds from the plugin location.

---

## 3. Options (VERIFIED)

Config form:

```jsonc
{ "plugins": [{ "package": "./plugins/opt-probe", "options": { "strict": true, "label": "p3-from-config" } }] }
```

`Plugin.define({ id, async setup(ctx) { ctx.options } })` receives the object **exactly**:
p3 marker recorded `{"strict":true,"label":"p3-from-config"}`. Auto-discovered plugins get `{}`.
Docs example: `const strict = ctx.options.strict === true`.
Source: `module.ts` builds `plugin.effect({ ...host, options: operation.options })`.

---

## 4. Version gate: none in 2.0.8 (VERIFIED)

- Source `packages/core/src/plugin/module.ts` and `packages/util/src/npm.ts` contain **no**
  compatibility check; binary strings contain no `checkPluginCompatibility` (0 matches). The V1
  function and its error text exist only in V1 code on the default branch.
- Empirically (p6), `opencode-beads@0.8.0` (a V1-era package depending on `@opencode-ai/plugin`
  ^1.0.143) was installed and **imported** with no gate. It failed later, only because its default
  export is not the V2 module shape:

```
level=WARN message="failed to load plugin" target=opencode-beads@0.8.0 … cause="Cause([Fail(PluginModule.LoadError: Plugin must export a default definition with an id and an effect or setup function. (cause: SchemaError(Missing key\n  at [\"default\"])))])"
```

- Docs never mention a runtime version gate. `opencode2 plugin check`/`update` skip **exact
  revisions** (`plugin check` on `opencode-beads@0.8.0` printed nothing, exit 0) — that is cache
  freshness policy, not compatibility checking.
- Consequence for local dev: no gate to satisfy. The only hard requirement is the module contract:
  default export `{ id: string, setup }` or `{ id: string, effect }`.

Correction to `opencode-v2-plugin-api.md` §3/§8: the claim "package plugins are compatibility-checked
against the OpenCode version; local file plugins skip the gate" is **false for 2.0.8 V2**; it reflected
V1 code.

---

## 5. Exact headless recipe (VERIFIED)

`opencode2 run` drives a real session headlessly; `--standalone` gives a private server and makes
`--print-logs` emit server logs to stderr.

```bash
P=/tmp/opencode/pkg-probe/p1                     # project with .opencode/plugins/probe.ts
cd "$P"
export XDG_CONFIG_HOME=$P/iso/config XDG_DATA_HOME=$P/iso/data \
       XDG_CACHE_HOME=$P/iso/cache XDG_STATE_HOME=$P/iso/state
timeout -k 5s 75s /nix/store/dg787j4sa7hmxrgmcp0n2vajwmv3cbg3-opencode2-2.0.8/bin/opencode2 \
  run --standalone --format json --print-logs "reply with the single word ok" > run.log 2>&1
```

- The plugin loads and `setup()` runs **before** any model call: the log shows
  `level=INFO … msg="loading plugin" id=<target> entrypoint=<file-url>` within seconds.
- `--format json` emits JSONL (`{"type":"step_start",…}`, then step/result/error records).
- **Model calls were flaky from /tmp** (`{"type":"error",…,"message":"Transport"}`), so the CLI can
  hang; exit 124 under `timeout` is expected and does **not** invalidate plugin-side assertions. One
  run from the repo dir completed exit 0 (`> build · nemotron-3.5-lightning-free`, output `ok`).
- `opencode2 session list --standalone --format json` lists sessions headlessly, including ones the
  plugin created (verified: listed `ses_f41438d15ffeF1NPIzyrAzFZwU`). Without `--standalone` in an
  isolated XDG env it printed nothing (exit 0) while the row existed in the DB — use `--standalone`.
- `opencode2 serve` does **not** activate plugins (no session). Use `run`.

---

## 6. Smoke-test assertions (VERIFIED)

A minimal plugin can assert without any model output:

```ts
// .opencode/plugins/probe.ts
import { Plugin } from "@opencode/plugin"
import { appendFileSync, writeFileSync } from "node:fs"

export default Plugin.define({
  id: "probe.p1",
  async setup(ctx) {
    writeFileSync("/tmp/marker.json", JSON.stringify({ app: ctx.app, options: ctx.options }))
    await ctx.storage.set("smoke", { at: "setup", version: ctx.app.version })
    const session = await ctx.session.create({ title: "probe-smoke" })
    const controller = new AbortController()
    ;(async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        appendFileSync("/tmp/events.log", event.type + "\n")
      }
    })().catch(() => {})
    setTimeout(() => controller.abort(), 20_000)
  },
})
```

Assertions, all reproduced this session:

1. **Marker file** — written during `setup`; `ctx.app` was `{name:"cli",version:"2.0.8",channel:"latest"}`
   (p1). Node `fs` works inside plugins (Bun runtime).
2. **KV row** — `ctx.storage.set("smoke", …)` lands in the server DB `table kv` under
   `plugin:<utf16le-hex(plugin-id)>:<key>`; observed
   `plugin:00700072006f00620065002e00700031:smoke` → `{"at":"setup","version":"2.0.8"}`. Read it
   with the embedded runtime, e.g.
   `bun -e 'const {Database}=require("bun:sqlite");const db=new Database(process.env.XDG_DATA_HOME+"/opencode/opencode.db",{readonly:true});console.log(db.query("select key,value from kv").all())'`
   Or just re-read it in a later `setup`.
3. **Session row** — `ctx.session.create({title:"probe-smoke"})` during setup returns an id and the
   session appears in `opencode2 session list --standalone --format json` and in DB `session_v2`.
4. **Event stream** — `ctx.event.subscribe()` **works on 2.0.8**. A 75 s run recorded 14 types:
   `agent.updated`, `command.updated`, `integration.updated`, `model.updated`, `plugin.updated`,
   `provider.updated`, `reference.updated`, `session.execution.started`, `session.inbox.delivered`,
   `session.inbox.enqueued`, `session.instructions.updated`, `skill.updated`, `vcs.branch.updated`,
   `websearch.updated`. `session.created` did not appear because the plugin created its session
   *before* subscribing; subscribe in `setup` before any session is created if that event is needed.
   (This resolves the `anomalyco/opencode#44788` risk from the prior notes for 2.0.8.)
5. `console.log` from `setup` was not visible via `--print-logs` in the earlier probe (prior notes);
   use marker files, storage, or the event log instead of stdout for assertions.

---

## 7. UNVERIFIED / caveats

- **`plugins/` beside a root `opencode.jsonc` is not auto-discovered** — docs + source, not probed.
- **`file://` directory targets** — handled in `config/plugin/source.ts` (`fileURLToPath`), not probed.
  Presumably same "must be a directory" rule.
- **Git specs** (`github:org/repo#ref::path:…`) — accepted by `npm.ts` per source and docs; not
  installed in a probe.
- **`peerDependencies` vs `devDependencies`** for a published plugin — docs silent; arborist's default
  peer install behaviour not tested.
- **Live reload / watch semantics** — watcher lines (`message="watcher subscribe"`) were observed, but
  a config edit mid-session was not exercised. Docs: watched config dirs reload; unwatched local deps
  may need `opencode service restart`.
- **Docs are stale** on config file-path entries (show `.ts` paths that 2.0.8 rejects) and silent on
  the no-version-gate reality.
- The previously reported failure mode "run hangs after model transport error" is environmental
  (model endpoint flakiness from /tmp), not plugin-related.

---

## 8. Sources

- Installed binary: `/nix/store/dg787j4sa7hmxrgmcp0n2vajwmv3cbg3-opencode2-2.0.8/bin/opencode2`,
  `opencode2 <cmd> --help`, binary strings grep.
- Source at tag v2.0.8 (sha `7673ed6bd6547ee0dcb81aab55f1392fb751d652`):
  `packages/core/src/plugin/module.ts`, `packages/core/src/plugin/source-directory.ts`,
  `packages/core/src/config/plugin/source.ts`, `packages/plugin/src/host.ts`,
  `packages/plugin/src/source.ts`, `packages/util/src/npm.ts`.
- npm registry: `npm view @opencode/plugin@2.0.8` (deps, exports, tarball URL).
- Docs: `https://opencode.ai/v2/docs/plugins`, `https://opencode.ai/v2/docs/build/plugins`.
- Probes: `/tmp/opencode/pkg-probe/p1` (project file, bun add), `p2` (global dir, npm), `p3`
  (config object options + double load), `p4/p4b` (file targets rejected, dir targets accepted),
  `p5` (package dir, `exports["./server"]` precedence), `p6` (npm package install + no version gate),
  `p8` (singular `plugin/` dir), `p9` (self-contained package dir with own `node_modules`).

---

## 9. Addendum (ticket #15): config composition and removal entries (SOURCE-READ, not probed)

Read at tag v2.0.8: `packages/core/src/config/plugin/source.ts`, `packages/core/src/config/discovery.ts`.

- **Each config document contributes its own `plugins` array.** `scan()` iterates the discovered
  config entries (global, then project `opencode.json(c)` / `.opencode/opencode.json(c)`) and
  flat-maps each document's `info.plugins`; there is no array merging, so a project config *adds*
  to a global one rather than replacing it.
- **Removal entries exist.** `parse()` treats a string starting with `-` as
  `{ type: "remove", target: input.slice(1) }`; a bare `"-"` throws
  `Plugin remove operation requires a target`. Operations are ordered `[...discovered, ...configured]`
  and the source comment says explicit config is applied last "so it can remove auto-discovered
  packages".
- **Options arrive only with an add entry.** Object entries `{package, options}` pass `options`
  verbatim; auto-discovered targets and string-add entries get `{}`.
- **Correction — removal matches the plugin definition id, not the add target.**
  `packages/core/src/plugin/supervisor.ts` `resolve()` folds the operations in order over an
  `enabled` id set. For a remove it calls `matches(operation.target, plugin.id)` against every
  loaded plugin's **definition id** (the `id` in its default export) and drops the match from
  `enabled`. Two wildcards exist: `*` (all plugins, and it clears the failure records) and
  `prefix.*` (id prefix). The removal string is passed through raw (`input.slice(1)`), so a path
  like `-./dir` is matched as a literal id and cannot cancel a directory add; `-agent-chat`
  cancels whichever plugin's definition id is `agent-chat`. The earlier "matching is on the
  resolved target" claim was wrong.
- **Ordering consequence.** Configured operations are applied after discovered ones, in config
  document order (global, then project), so a project `"plugins": ["-agent-chat"]` cancels a
  global add or an auto-discovered plugin whose definition id is `agent-chat`. An add whose target
  string equals an already-present plugin id only re-enables it (no reload, and its options are
  ignored); an add under a different target string for the same definition id loads a second
  generation whose duplicate id then fails setup — consistent with the double-load observation in
  §3. Keep the plugin's definition id equal to the install name so add/remove strings align.
- **Still worth a live probe (ticket #16):** end-to-end global add + project remove, since config
  document ordering and the two-pass resolve (`install: false`, then `install: true`) are
  source-read only.
