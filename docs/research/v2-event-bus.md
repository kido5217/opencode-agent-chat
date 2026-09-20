# OpenCode V2 event bus and session lifecycle signals

Researched 2026-09-20 on this host (NixOS), for a plugin targeting **opencode2 v2.0.8 only**.
Evidence order: live probes with a real plugin (authoritative for behaviour) → source tree at tag
`v2.0.8` → npm packages `2.0.8` shipped with/used by the binary → type declarations.

Target: `/nix/store/dg787j4sa7hmxrgmcp0n2vajwmv3cbg3-opencode2-2.0.8/bin/opencode2` (Bun-compiled
ELF; reports `2.0.8`). Source of record: GitHub tag
[`v2.0.8`](https://github.com/anomalyco/opencode/tree/v2.0.8) (sha `7673ed6bd6547ee0dcb81aab55f1392fb751d652`).

Ticket: research map #4 — verify the v2 event bus and session lifecycle signals.

---

## 0. Verdict in one screen

| Question | Answer | Status |
|---|---|---|
| Does `ctx.event.subscribe` deliver on 2.0.8? | **Yes.** Three real sessions with the plugin loaded streamed events normally (59 events in the subagent run, 23 in the follow-up); two full turns including a background subagent were captured end-to-end. | VERIFIED |
| Root session starting | `session.created` (no `parentID`), `session.inbox.enqueued` (first user message), `session.execution.started`. Caveat: a session created **before** the plugin's subscription is established is not replayed (bootstrap race, observed). | VERIFIED (with caveat) |
| Subagent child spawn + parent | `session.created` with `data.parentID` = parent session id; also `session.tool.progress`/`session.tool.success` carry `metadata.sessionID` = child id. | VERIFIED |
| Subagent finishing | Child's `session.execution.succeeded` (or `.failed`/`.interrupted`), plus parent's `session.inbox.enqueued` with a `synthetic` item whose `payload.metadata = {source:"subagent", childID, agent, state}`. | VERIFIED |
| Agent idle/busy | `session.execution.started` = busy; `session.execution.succeeded` / `failed` / `interrupted` = idle for that session. `session.status` / `session.idle` are **declared but never published** on 2.0.8 (deprecated, zero publishers in source). | VERIFIED |
| Root from a child | Walk `session.created.data.parentID` up until it is absent; `ctx.session.get(id)` returns `parentID` (`Session.Info.parentID` optional). | VERIFIED |
| Live-only / no replay | Subscribe is a volatile channel: events published before the subscription (or during a disconnect) are lost. A late subscriber in-run missed all earlier events. No cursor/Last-Event-ID exists. Durable events are persisted and *can* be replayed per session via `GET /api/experimental/session/{id}/log?after=&follow=` (experimental HTTP; **not** exposed through the plugin `ctx.session`). | VERIFIED |
| Issue `#44788` zero-events | **Not reproducible on 2.0.8.** The issue is against beta builds (`0.0.0-beta-18050`, `-17519`). | VERIFIED for 2.0.8 / issue remains open for betas |

---

## 1. Method and artefacts

Probe project (all scratch under `/tmp/opencode/events-probe`):

- `.opencode/plugins/events-probe/index.ts` — auto-discovered plugin; `ctx.event.subscribe()`
  appends one JSON line per event (`type`, `id`, `created`, `location`, `data`; raw JSON for
  selected events) to `/tmp/opencode/events-probe/events*.jsonl`.
- State isolated with `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`,
  `XDG_STATE_HOME` all under `/tmp/opencode/events-probe/xdg/`; the user's real
  `~/.local/share/opencode` (13 GB db) and real config were never touched.
- Model: `deepseek/deepseek-flash` (provider `deepseek`), enabled by importing the user's
  DeepSeek key into the scratch credential table. No credential value is reproduced here.
- Sessions driven with `opencode2 run --standalone --auto` (the background service mode is
  blocked on this host because the user's own service owns port 49374).

Log artefacts:

| File | Content |
|---|---|
| `/tmp/opencode/events-probe/events-run1.jsonl` | 66 records: root session + **background subagent** (`subagent` tool, `background: true`) complete lifecycle |
| `/tmp/opencode/events-probe/events2.jsonl` | 23 events + late-subscriber test + a root session created *after* subscription (raw envelopes) |
| `/tmp/opencode/events-probe/events.jsonl` | copy of the run-1 log (same 59 events; left over from the probe) |
| `/tmp/opencode/events-probe/src/opencode-2.0.8/` | extracted source tarball of tag `v2.0.8` (codeload) |

Run 1 timeline (ms epoch, `events-run1.jsonl`), root = `ses_…f39…`, child = `ses_…84…`:

```
793065  session.inbox.enqueued   root (user prompt)
793080  session.execution.started root          <- root busy
794059  session.step.started     root  (agent build)
794202  session.tool.input.started  name="subagent"
794410  session.tool.called         input {agent, description, prompt, background:true}
794417  session.created          child   parentID=root, agent "general"   <- child spawn
794418  session.tool.progress    metadata {sessionID: child, status:"running"}
794422  session.tool.success     metadata {sessionID: child, status:"running"}
794449  session.execution.started child        <- child busy
795290  session.execution.succeeded child      <- child finished
795293  session.inbox.enqueued   root  synthetic completion (childID, state="completed")
796180  session.execution.succeeded root       <- root idle
796196  location.shutdown
```

---

## 2. Envelope and delivery semantics

### 2.1 Wire envelope (VERIFIED)

From the raw JSON captured by the probe (probe 2 logs `raw`):

```jsonc
// ephemeral event
{"id":"evt_…","created":1789906882116,"type":"integration.updated",
 "location":{"directory":"/tmp/opencode/events-probe"},"data":{}}

// durable event (session.created)
{"id":"evt_…","created":1789906882197,"type":"session.created",
 "durable":{"aggregateID":"ses_f413c71a4ffe…","seq":0,"version":1},
 "location":{"directory":"/tmp/opencode/events-probe"},
 "data":{"sessionID":"ses_f413c71a4ffe…", …}}
```

- Fields: `id`, `created` (epoch ms), `type`, optional `location` `{directory, workspaceID?}`,
  optional `metadata`, `data`.
- **Durable** events additionally carry `durable: {aggregateID, seq, version}`. Ephemeral events
  omit the key entirely. (The `durability`/`durable` discriminants in the `.d.ts` are type-level;
  the observable marker is the `durable` object. `durable.aggregateID` is the session id for
  session events; `seq` is per-aggregate.)
- Source: `bus.publishAll` adds `durable: envelope(aggregateID, seq, version)` when persisting
  ([`packages/core/src/bus.ts` L565-600](https://github.com/anomalyco/opencode/blob/v2.0.8/packages/core/src/bus.ts#L565));
  protocol union [`packages/schema/src/session-event.ts`](https://github.com/anomalyco/opencode/blob/v2.0.8/packages/schema/src/session-event.ts).

### 2.2 How the plugin's subscription is wired (VERIFIED in source)

1. User plugin contexts are built at
   [`packages/core/src/plugin.ts` L46/L65](https://github.com/anomalyco/opencode/blob/v2.0.8/packages/core/src/plugin.ts#L46):
   `plugin.effect({ ...host, storage })` where `host = PluginHost.make(...)`.
2. The host context implements
   [`packages/core/src/plugin/host.ts` L255](https://github.com/anomalyco/opencode/blob/v2.0.8/packages/core/src/plugin/host.ts#L255):

   ```ts
   event: {
     subscribe: () =>
       bus.subscribe().pipe(
         Stream.filter((event) => EventManifest.isServer(event) || isRpcEvent(event)),
       ),
   }
   ```

   i.e. a **direct in-process bus subscription**, not the HTTP SSE endpoint.
3. The promise adapter converts that stream to the `AsyncIterable` the plugin sees
   ([`packages/plugin/src/promise/adapter.ts` L323-331](https://github.com/anomalyco/opencode/blob/v2.0.8/packages/plugin/src/promise/adapter.ts#L323)):
   each event is encoded through the public `OpenCodeEvent` union first.
4. Consequences, all consistent with the probe observations:
   - **`server.connected` is never seen by plugins.** It is constructed only in the HTTP SSE
     handler ([`packages/server/src/handlers/event.ts` L14-20](https://github.com/anomalyco/opencode/blob/v2.0.8/packages/server/src/handlers/event.ts#L14)) and is not published on the bus.
   - The HTTP feed's 4096-event dropping queue / `EventFeed.SubscriberOverflow` and the client's
     4096-event `SharedEvents` capacity apply to *HTTP* consumers, not to the plugin bus stream.
   - `onActivity` is part of the public `subscribe(options?: {signal?, onActivity?})` type
     (`@opencode/client@2.0.8`, `dist/promise/client.d.ts` L11), but the promise adapter's stream
     wrapper only honours `signal`; `onActivity` is ignored for plugins (source-level; not
     behaviourally tested).

### 2.3 Live-only, no replay (VERIFIED)

- Bus documentation, [`packages/core/src/bus.ts` L121-130](https://github.com/anomalyco/opencode/blob/v2.0.8/packages/core/src/bus.ts#L121):
  *"Volatile live channel: every event published from now on, nothing before or across a
  disconnect. Consumers that need reliability combine it with `log`."*
- No `Last-Event-ID`/`since` parameter exists on `GET /api/event`; the only HTTP event operation is
  `event.subscribe` (`@opencode/client@2.0.8` generated client, `path: /api/event`).
- **Experiment (probe 2):** a second subscriber started after the main subscriber had received
  3 events. Its first event was `session.execution.started` (published much later); it never
  received `agent.updated`/`command.updated`/… or the earlier `session.inbox.enqueued`, but did
  receive everything from `session.execution.started` onward. No replay, no backfill.

### 2.4 Replay exists only outside the plugin surface (VERIFIED in source, not exercised)

- `Bus.log({aggregateID, after?, follow?})` and `Session.log({sessionID, after?, follow?})` replay
  durable events after an exclusive cursor, emit a `Synced` marker, then optionally continue live
  ([`packages/core/src/session.ts` L161-170](https://github.com/anomalyco/opencode/blob/v2.0.8/packages/core/src/session.ts#L161)).
- Exposed over HTTP as an SSE stream:
  `GET /api/experimental/session/{sessionID}/log?after=&follow=`
  ([`packages/server/src/handlers/session.ts` L598](https://github.com/anomalyco/opencode/blob/v2.0.8/packages/server/src/handlers/session.ts#L598),
  client `@opencode/client@2.0.8` `session.log`).
- The plugin `ctx.session` type is
  `Pick<SessionApi, "create"|"get"|"switchAgent"|"switchModel"|"prompt"|"generate"|"command"|"synthetic"|"interrupt"|"update"|"move"|"wait"|"context">`
  (`@opencode/plugin@2.0.8`, `dist/promise/session.d.ts` L143) — **no `log`**. A plugin cannot
  replay through its context; only a client that can call the experimental HTTP route (or read the
  DB event tables) can.

### 2.5 Reliability observed

Within a live subscription, events were delivered in order with no observed loss: 59 events in
run 1 across two sessions (66 log records including setup/cleanup), 23 in run 2; the stream ends
only at plugin cleanup / `location.shutdown`.
The durable `seq` lets a consumer detect gaps (per aggregate) if it also has a replay source.
Nothing in the plugin path applies the 4096-drop policy; but the bus stream is live-only, so the
"reliability" answer is: ordered and gapless *while connected*, no delivery guarantees across
subscription start or disconnects.

---

## 3. Which events detect what

### (a) Root session starting

- `session.created` with **no `parentID`** is the direct signal. It is durable.
- In the standalone `run` bootstrap the root session is created before the plugin's subscription
  becomes active, so its `session.created` was **not** delivered (both runs). Sessions created
  after the subscription (the subagent child, and a root session created via `ctx.session.create`
  in probe 2) did deliver `session.created`.
- Practical detection:
  - `session.inbox.enqueued` (first user message; durable) — always observed, including bootstrap.
  - `session.execution.started` — turn start / busy.
  - `ctx.session.get(sessionID)` → `parentID === undefined` to classify root (Session.Info schema:
    [`packages/schema/src/session.ts` L33](https://github.com/anomalyco/opencode/blob/v2.0.8/packages/schema/src/session.ts#L33)).

### (b) Subagent child spawning and its parent

Three independent signals, all observed:

1. `session.tool.input.started` `{…, name:"subagent"}` then `session.tool.called` with
   `input: {agent, description, prompt, background:true}` — tool name is only in `input.started`.
2. `session.created` with `data.parentID = <parent session id>`, `agent` (e.g. `"general"`),
   `model {id, providerID, variant}`, `title`, `slug`, `version`.
3. `session.tool.progress` (ephemeral) and `session.tool.success` (durable) with
   `metadata: {sessionID: <child id>, status: "running", truncated: false}`; the child id is also
   embedded in the success text (`The subagent is working in the background (sessionID: …)`).
4. The child also emits its own `session.inbox.enqueued` / `session.execution.started`.

Parent linkage: `session.created.data.parentID`. Children-of-a-parent can also be listed with
`GET /api/session?parentID=<id>`; there is no API to create a session with an explicit parent
(`session.create` body has no `parentID`).

### (c) Subagent finishing

- Child session `session.execution.succeeded` (durable) — or `failed` / `interrupted`.
- Parent session `session.inbox.enqueued` (durable) with `item.type === "synthetic"`:

  ```jsonc
  {"sessionID":"ses_…parent…","inboxID":"msg_…",
   "item":{"type":"synthetic",
     "payload":{
       "text":"<subagent sessionID=\"ses_…child…\" state=\"completed\" description=\"probe-child\">\nCHILD_OK\n</subagent>",
       "description":"probe-child",
       "metadata":{"source":"subagent","childID":"ses_…child…","agent":"General","state":"completed"}},
     "delivery":"steer"}}
  ```

  Source of this shape:
  [`packages/core/src/session/subagent-completion.ts` L27-44](https://github.com/anomalyco/opencode/blob/v2.0.8/packages/core/src/session/subagent-completion.ts#L27)
  (`state` is `completed | error | cancelled` there; the observed value is `completed`).
- Note the root `session.execution.started` from its first step stayed open until the synthetic
  completion was processed, i.e. the parent execution brackets the background wait (run 1:
  started 793080 → succeeded 796180, child succeeded 795290 in between). Using execution events
  alone, a background child keeps the parent "busy" until its completion notification is consumed.

### (d) Agent idle / busy

- **Busy:** `session.execution.started` `{sessionID}` (durable).
- **Idle:** `session.execution.succeeded` `{sessionID}` (durable); abnormal endings:
  `session.execution.failed {sessionID, error}` (captured: `{type:"provider.no-route", message:"Model unavailable: …"}`),
  `session.execution.interrupted {sessionID, reason:"user"|"shutdown"|"superseded"|"inactivity"}`
  (source only).
- Finer granularity: `session.step.started` `{sessionID, assistantMessageID, agent, model, started}`
  and `session.step.ended {…, finish, rawFinish, cost, tokens}`.
- `session.status` and `session.idle` were **never emitted** in any probe. Source agrees:
  `session.idle` is annotated `// deprecated` and no code publishes either type
  ([`packages/schema/src/session-status-event.ts` L25-49](https://github.com/anomalyco/opencode/blob/v2.0.8/packages/schema/src/session-status-event.ts#L25);
  repo-wide grep finds only the definitions and the manifest). Do not build idle detection on them.
- `ctx.session.wait({sessionID})` is the documented idle wait (SessionDomain includes `wait`);
  the issue reporter's workaround relies on it (see §5). Not exercised in this probe.

### (e) Root session from a child

Walk `parentID` upward:

```
child = session.created.data.sessionID
parent = session.created.data.parentID          // absent ⇒ this session is root
grandparent = ctx.session.get(parent).parentID  // Session.Info.parentID optional
```

For the observed subagent, `child.parentID === root`, so one hop. The completion synthetic payload
also carries `metadata.childID` and the parent session id is the event's `data.sessionID`.

### (f) What live-only means for bootstrap

- Subscribe as early as possible (plugin `setup`) and treat the first event for an unknown
  `sessionID` as a session you must hydrate with `ctx.session.get(sessionID)` — you will not get a
  replay of its `session.created` if it predates your subscription (observed for `run`'s root
  session).
- There is no cursor to resume from on the plugin side. If you need history, you must obtain it
  from a source that can read the durable log (experimental HTTP session log, or the event tables
  in `opencode.db`); the plugin context deliberately does not expose it.
- Durable events carry `{aggregateID, seq, version}`, so a consumer that also has the durable log
  can detect gaps and exactly where to resume.
- Sessions created **after** the subscription always produce a live `session.created` (verified
  twice), so early subscription + first-seen hydration covers the bootstrap hole.

---

## 4. Exact payload shapes (captured on 2.0.8)

Durability from source (session-event.ts) — D = durable, E = ephemeral (captured raw for
`session.created` = durable; ephemeral shape inferred from other captured ephemeral events and the
absence of the `durable` key).

| Event | Dur. | `data` (observed values) |
|---|---|---|
| `session.created` | D | `{sessionID, projectID, location:{directory}, subpath, parentID?, slug, title?, agent?, model?{id,providerID,variant}, metadata?, permissions?, version}` |
| `session.execution.started` / `.succeeded` | D | `{sessionID}` |
| `session.execution.failed` | D | `{sessionID, error:{type, message}}` |
| `session.execution.interrupted` | D | `{sessionID, reason}` (source only) |
| `session.step.started` | D | `{sessionID, assistantMessageID, agent, model{id,providerID,variant}, started}` |
| `session.step.streamed` | D | `{sessionID, assistantMessageID}` |
| `session.step.ended` | D | `{sessionID, assistantMessageID, finish, rawFinish, cost, tokens{input,output,reasoning,cache{read,write}}}` |
| `session.text.started` | D | `{sessionID, assistantMessageID, ordinal}` |
| `session.text.delta` | E | `{sessionID, assistantMessageID, ordinal, delta}` |
| `session.text.ended` | D | `{sessionID, assistantMessageID, ordinal, text}` |
| `session.reasoning.started` | D | `{sessionID, assistantMessageID, ordinal, state{reasoningField}}` |
| `session.reasoning.delta` | E | `+ delta` |
| `session.reasoning.ended` | D | `+ text` |
| `session.tool.input.started` | D | `{sessionID, assistantMessageID, id, name}` (`name:"subagent"`) |
| `session.tool.input.ended` | D | `{…, text}` — raw JSON string of the tool input |
| `session.tool.called` | D | `{sessionID, assistantMessageID, id, input, executed:false}` |
| `session.tool.progress` | E | `{sessionID, assistantMessageID, id, metadata}` |
| `session.tool.success` | D | `{…, content:[{type:"text",text}], metadata, executed:false}` |
| `session.inbox.enqueued` | D | `{sessionID, inboxID, item:{type:"user"\|"synthetic", payload:{text, files?}\|{text, description, metadata}, delivery:"steer"}}` |
| `session.inbox.delivered` | D | `{sessionID, inboxID}` |
| `session.usage.updated` | E | `{sessionID, cost, tokens{input,output,reasoning,cache{read,write}}}` |
| `session.renamed` | D | `{sessionID, title}` |
| `session.instructions.updated` | D | `{sessionID, delta:{…instruction hashes}}` |
| `location.shutdown` | E | `{}` (envelope carries `location`) |

Message-level events: **there is no `message.*` family.** Live message traffic is
`session.text.*`, `session.reasoning.*`, `session.tool.*`, `session.step.*`, `session.inbox.*`.
The durable schema additionally defines `session.message.content.updated`,
`session.usage.recorded`, `session.synthetic`, `session.agent.selected`, `session.model.selected`,
`session.permissions`, `session.viewed`, `session.moved`, `session.forked`, `session.deleted`,
`session.skill.activated`, `session.shell.started/ended`, `session.compaction.*`,
`session.retry.scheduled`, `session.revert.*` (not observed in these probes).

Full durability table for session events (source-mapped): `session.created`, `execution.*`,
`step.*`, `text.started/ended`, `reasoning.started/ended`, `tool.input.started/ended`,
`tool.called/success/failed`, `inbox.*`, `instructions.updated`, `retry.scheduled`, `synthetic`,
`usage.recorded`, `message.content.updated` = durable; `session.text.delta`,
`session.reasoning.delta`, `session.tool.input.delta`, `session.tool.progress`,
`session.usage.updated`, `session.status`, `session.idle` = ephemeral. Manifest:
[`durable-event-manifest.ts`](https://github.com/anomalyco/opencode/blob/v2.0.8/packages/schema/src/durable-event-manifest.ts)
(`Durable = Event.durableMap([...SessionEvent.DurableDefinitions, Worktree.Event.Resolved])`).

### `session.created` in full (child capture, verbatim)

```jsonc
{"type":"session.created","durability":null,
 "data":{"sessionID":"ses_f413dc84fffeQUPdrGPLd6Dnta",
   "projectID":"83553b4a48e24760ab75e6a74bcf228950680417",
   "location":{"directory":"/tmp/opencode/events-probe"},
   "subpath":"",
   "parentID":"ses_f413dcf39ffehUUSFWIv2kvH3j",
   "slug":"kind-falcon","title":"probe-child","agent":"general",
   "model":{"id":"deepseek-flash","providerID":"deepseek","variant":"default"},
   "version":"2.0.8"}}
```

(A root session created via `ctx.session.create({title})` produced the same shape minus
`parentID`, `agent`, `model`. `durability:null` above is an artefact of the probe's jq projection;
the raw JSON has no `durability` key and durable events carry `durable` instead.)

### Subagent tool input (as the plugin sees it)

`session.tool.called.data.input` (run 1):

```json
{"agent":"general","description":"probe-child",
 "prompt":"Reply with exactly CHILD_OK and nothing else.","background":true}
```

Tool schema in source: [`packages/core/src/tool/plugin/subagent.ts` L25-52](https://github.com/anomalyco/opencode/blob/v2.0.8/packages/core/src/tool/plugin/subagent.ts#L25)
(`agent`, `description`, `prompt`, optional `model`, `sessionID`, `background`). Background result
`{sessionID, status:"running", output}`.

---

## 5. Issue `anomalyco/opencode#44788` — zero events from `ctx.event.subscribe`

<https://github.com/anomalyco/opencode/issues/44788> (open; label `2.0`, assignee rekram1-node).
Reported against beta `0.0.0-beta-18050` (CLI 1.18.21, macOS arm64); a commenter reproduced a
similar subscribe failure on `0.0.0-beta-17519`. On those builds the reporter found that
`ctx.event.subscribe()` delivered zero events while an authenticated external `GET /api/event`
did stream events.

On **2.0.8 the plugin path works**, so the bug cannot be reproduced on the installed target:

- An earlier run that failed model routing still streamed the bootstrap vocabulary
  (`session.inbox.enqueued`, `session.execution.started/failed`, `models-dev.refreshed`, …);
  that log was overwritten, but the probe-1 log shows the same path working.
- Probe 1 (background subagent): 59 events over two sessions.
- Probe 2: 23 events, plus a subscriber that joined late (it received live events, proving the
  stream is functional, just not replaying).
- `session.created` for both the subagent child and a plugin-created root session were delivered.

The issue's own observation that the external SSE endpoint worked while the plugin saw nothing is
consistent with the architecture here (plugin subscribes to the bus directly; external clients use
`/api/event`), but the plugin path itself delivered on 2.0.8. The beta reports remain unverified
here; nothing in this research explains them for 2.0.8.

Related complaint in the same issue (context-hook mutations not reaching the model): the probe's
`ctx.session.hook("context")` fired 4 times on 2.0.8 (logged in `events-run1.jsonl`), but whether
its mutations reach the prompt was **not** tested — out of scope for this ticket.

---

## 6. VERIFIED / UNVERIFIED

**VERIFIED (live probe on 2.0.8, or source of tag v2.0.8):**

- `ctx.event.subscribe()` delivers ordered events on 2.0.8; 3 sessions observed.
- Wire envelope and `durable:{aggregateID,seq,version}` for durable events.
- Plugin subscription is a direct bus subscription filtered to public/rpc events
  (`packages/core/src/plugin/host.ts` L255); promise adapter encodes via `OpenCodeEvent` and only
  honours `signal` (`packages/plugin/src/promise/adapter.ts` L323).
- `server.connected` is HTTP-SSE-only; plugins never see it (handler source + 2 probes).
- Live-only semantics: late subscriber missed earlier events; bus doc says so explicitly; no
  `Last-Event-ID`/cursor on `/api/event`.
- `session.created` payload including `parentID`, `agent`, `model`; root = no `parentID`.
- Child spawn detection via `session.created.parentID` and `session.tool.* metadata.sessionID`.
- Child completion via child `session.execution.succeeded` + parent `session.inbox.enqueued`
  synthetic item (`metadata.childID`, `state`).
- Busy/idle via `session.execution.started` / `.succeeded|failed|interrupted`.
- `session.status`/`session.idle`: declared, deprecated/never published on 2.0.8 (0 observations;
  no publishers in source).
- Bootstrap race: a session created before the plugin's subscription is established produces no
  delivered `session.created` (observed for `run`'s root session twice); sessions created after
  subscription always do.
- Durability classification of all session events (source map).
- `#44788` zero-event behaviour is absent on 2.0.8.

**UNVERIFIED / open:**

- Payloads of events never triggered: `session.execution.interrupted`,
  `session.tool.failed`, `session.tool.input.delta`, `session.retry.scheduled`,
  `session.compaction.*`, `session.revert.*`, `session.shell.*`, `session.deleted/forked/moved`,
  `session.message.content.updated`, `session.usage.recorded`.
- `onActivity`: typed in `@opencode/client`, ignored by the promise adapter for plugins — not
  behaviourally tested.
- Behaviour across an SSE/bus disconnect or plugin reload (server restart): not tested.
- Overflow behaviour on the plugin bus stream: not tested; the 4096-drop policy is documented for
  the HTTP feed and client `SharedEvents`, not for the bus stream.
- The experimental `session.log` replay endpoint was not exercised (source-only finding).
- Multi-child / concurrent subagents, foreground (`background:false`) subagents, and nested
  subagents: not tested.
- Whether beta builds (`-18050`, `-17519`) really delivered zero events: only the issue text was
  read; no beta binary was run.

## Sources

- Live probe logs and plugin: `/tmp/opencode/events-probe/` (`events-run1.jsonl`,
  `events2.jsonl`, `.opencode/plugins/events-probe/index.ts`).
- Source tag `v2.0.8` (codeload tarball extracted at
  `/tmp/opencode/events-probe/src/opencode-2.0.8/`): `packages/schema/src/session-event.ts`,
  `session-status-event.ts`, `event-manifest.ts`, `durable-event-manifest.ts`,
  `packages/schema/src/session.ts`; `packages/core/src/bus.ts`, `plugin.ts`,
  `plugin/host.ts`, `session.ts`, `session/subagent-completion.ts`, `session/subagent-job.ts`,
  `tool/plugin/subagent.ts`; `packages/plugin/src/promise/adapter.ts`;
  `packages/server/src/handlers/event.ts`, `handlers/session.ts`, `event-feed.ts`;
  `packages/client/src/shared-events.ts`, `effect/client.ts`.
  On GitHub: <https://github.com/anomalyco/opencode/tree/v2.0.8>.
- npm packages 2.0.8 used by the plugin: `@opencode/plugin`, `@opencode/client`,
  `@opencode/protocol`, `@opencode/schema` (installed at
  `/tmp/opencode/events-probe/node_modules/@opencode/`).
- Issue: <https://github.com/anomalyco/opencode/issues/44788>.
- V2 docs entry point: <https://opencode.ai/v2/docs> (no event-bus reference page was found that
  adds facts beyond the source above).
