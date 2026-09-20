# OpenCode V2 `session.inbox.*` events — research notes

Researched 2026-09-20 on this host (NixOS) against the installed **opencode2 v2.0.8**
(`/nix/store/dg787j4sa7hmxrgmcp0n2vajwmv3cbg3-opencode2-2.0.8/bin/opencode2`), the npm
packages that exactly match it (`@opencode/{protocol,client,plugin,schema}@2.0.8`), the v2
docs at `https://opencode.ai/v2/docs`, and a live isolated-XDG probe.

Ticket: research ticket #6, "Determine what v2's session.inbox events are".
Companion doc: `docs/research/opencode-v2-plugin-api.md` (the event list there is confirmed
and extended here).

Evidence order: installed binary → npm 2.0.8 packages (authoritative API for the installed
binary) → official v2 docs → repo specs (older branch, used only for design intent) → live probe.

**Verdict up front:** the native inbox is a **session-scoped durable prompt-admission
queue**, not a chat bus or mailbox. Our plugin should **integrate at the delivery boundary**
(admit via `session.prompt`/`synthetic` and observe `session.inbox.*` events), **mirror**
queue state in its own viewer if it shows delivery status, but **keep its own storage and
viewer** for cross-session chat — the native inbox cannot replace them. Details in §7.

---

## 1. What the native inbox is (storage + domain)

`session_inbox` is a real SQLite table in the 2.0.8 database. The migration is embedded in
the binary (`strings` of the installed binary; migration id `20260812181746_session_inbox`):

```sql
CREATE TABLE `session_inbox` (
  `id` text PRIMARY KEY,
  `session_id` text NOT NULL,
  `type` text NOT NULL,
  `payload` text NOT NULL,
  `delivery` text NOT NULL,
  `enqueued_seq` integer NOT NULL,
  `time_created` integer NOT NULL,
  CONSTRAINT `fk_session_inbox_session_id_session_v2_id_fk`
    FOREIGN KEY (`session_id`) REFERENCES `session_v2`(`id`) ON DELETE CASCADE
);
CREATE INDEX `session_inbox_session_delivery_seq_idx`
  ON `session_inbox` (`session_id`,`delivery`,`enqueued_seq`);
CREATE UNIQUE INDEX `session_inbox_session_enqueued_seq_idx`
  ON `session_inbox` (`session_id`,`enqueued_seq`);
```

- A fresh 2.0.8 DB built by the server during the probe (isolated `XDG_DATA_HOME`) contains
  both `session_inbox` and a second table `session_pending`
  (`id, session_id, type, data, delivery, admitted_seq, time_created`). Only `session_inbox`
  matched observed behavior; `session_pending` stayed at 0 rows throughout the probe
  (`sqlite3` on the probe DB). Its purpose is **not verified** — it appears to be a
  leftover/parallel admission table from an earlier design. Do not build on it.
- Domain vocabulary (`CONTEXT.md` on `anomalyco/opencode`): an **Admitted Prompt** is
  "a durable user input accepted into the Session inbox but not yet included in Session
  History"; **Prompt Promotion** "atomically consumes the pending inbox entry and appends
  its model-visible user message".
- Delivery vocabulary (`specs/v2/session.md`, same repo; older `session_input` naming):
  `steer` inputs "promote at the next safe provider-turn boundary, including continuation
  inside the current drain"; `queue` inputs "remain in a FIFO while the current drain
  requires continuation. When the Session would otherwise become idle, the runner promotes
  exactly one queued input, then reevaluates continuation before promoting another."
- Item kinds (2.0.8 client types): `user`, `synthetic`, `compaction`, `move`.
  - `user` payload = `{ text, files?, agents?, skills?, metadata? }` (mirrors `PromptInput`)
  - `synthetic` payload = `{ text, description?, metadata? }`
  - `compaction` payload = `{}`
  - `move` payload = `{ projectID, subpath?, location }`
- `metadata` on `user`/`synthetic` payloads is free-form JSON — the only native place to
  carry correlation data (e.g. a bus message id / sender) for a queued prompt.
- `resume` on prompt admission: omitted/true = durable admission **plus** an advisory
  execution wake; `false` = **admit-only** (probe: item enqueued and listed, no model call).

## 2. The four events: emitters, payloads, lifecycle

Authoritative schemas: `@opencode/protocol@2.0.8` `dist/groups/session.d.ts` and
`dist/groups/event.d.ts`; readable generated forms in `@opencode/client@2.0.8`
`dist/promise/generated/types.d.ts` lines 974–1028 (delivered/cancelled/delivery.changed),
3144–3163 (enqueued/Info/Item). All four are **durable** events (`durable.version: 1`).

| Event | `data` payload | Emitted when |
|---|---|---|
| `session.inbox.enqueued` | `{ sessionID, inboxID, item: { type, payload, delivery } }` | A prompt/synthetic/compaction/move input is durably admitted to the inbox |
| `session.inbox.delivered` | `{ sessionID, inboxID }` | Promotion consumes the row at a safe provider-turn boundary and appends the visible message |
| `session.inbox.delivery.changed` | `{ sessionID, inboxID, delivery }` | `PATCH …/inbox/:inboxID` changes delivery between `steer` and `queue` |
| `session.inbox.cancelled` | `{ sessionID, inboxID }` | `DELETE …/inbox/:inboxID` cancels a not-yet-delivered item |

Envelope: `{ id, created, metadata?, type, durable: { aggregateID, seq, version }, location?, data }`.
`inboxID` is branded `Session.Message.ID` (`^msg_`); `sessionID` is branded `SessionID` (`^ses`).

Emitter implementation names found in the binary (`strings`): `SessionInbox.make`,
`SessionInbox.admit` / `admitCompaction` / `steer` / `queue` / `cancel` / `promote` /
`reconcile` / `moveIDs` / `nextPromotable` / `has` / `publish`, projection helpers
`projectEnqueued` (binary: `projectAdmitted`) / `projectDelivered` / `projectCancelled` /
`projectDeliveryChanged`, errors `Session.InboxConflictError` and
`Session.Inbox.LifecycleConflict`. That is the whole lifecycle: admit → enqueue → deliver
(promote) → become a normal session message; or cancel; delivery can change while pending.
`LifecycleConflict` / `ConflictError` means the row was already delivered/cancelled.

### Live probe (all four events observed on 2.0.8)

Setup: `/tmp/opencode/inbox-probe`, isolated `XDG_*` dirs, `opencode2 serve --port 7411`,
a project plugin subscribed with `ctx.event.subscribe()`, plus the generated
`@opencode/client@2.0.8` driver. No auth was configured; the server used the built-in free
default model (`opencode/jev-1.13-free`) only when a drain was explicitly woken (it
errored on the provider and retried; no paid calls).

1. Admit-only: `session.prompt({ text: "probe message", delivery: "steer", resume: false })`.
   - `inbox.list` returned the item (`id`, `type: "user"`, `delivery: "steer"`), then
     `"queue"` after `inbox.update`, then `[]` after `inbox.cancel`.
   - Events received (driver SSE **and** the server plugin's `ctx.event.subscribe()`):
     ```
     {"type":"session.inbox.enqueued","data":{"sessionID":"ses_…","inboxID":"msg_…",
       "item":{"type":"user","payload":{"text":"probe message"},"delivery":"steer"}}}
     {"type":"session.inbox.delivery.changed","data":{"sessionID":"ses_…","inboxID":"msg_…","delivery":"queue"}}
     {"type":"session.inbox.cancelled","data":{"sessionID":"ses_…","inboxID":"msg_…"}}
     ```
   - `sqlite3`: `session_inbox` = 0 rows after cancel (row deleted).
2. Drain: `session.prompt({ text: "drain probe", delivery: "steer", resume: true })`.
   - Event order observed: `session.inbox.enqueued` → `session.execution.started` →
     `session.instructions.updated` → **`session.inbox.delivered`** → `session.step.started`.
     So `delivered` fires at promotion, before the provider turn begins; the item is gone
     from `inbox.list` afterwards.

Ordering guarantees under concurrency were not tested; the events are durable, so replay is
possible, but no explicit cross-event ordering contract beyond "promotion is atomic with the
`Prompted` message" was found in the docs (`specs/v2/session.md`).

## 3. API surface in 2.0.8

Docs: `https://opencode.ai/v2/docs/api` (operation IDs quoted from that page). Client:
`@opencode/client@2.0.8` `dist/promise/client.d.ts`, `dist/promise/generated/types.d.ts`.

- `GET /api/session/{sessionID}/inbox` — operation `session.inbox.list`.
  "List durable enqueued session work not yet delivered, ordered by enqueue sequence.
  Includes user, synthetic, compaction, and move items." Returns `{ data: Session.Inbox.Info[] }`.
- `PATCH /api/session/{sessionID}/inbox/{inboxID}` — operation `session.inbox.update`.
  Body `{ delivery: "steer" | "queue" }`. "Change a pending inbox item's delivery mode.
  Steering wakes session execution." 204; can return `ConflictError`.
- `DELETE /api/session/{sessionID}/inbox/{inboxID}` — operation `session.inbox.cancel`.
  "Cancel an inbox item that has not yet been delivered. Unavailable items are a no-op." 204.
- `POST /api/session/{sessionID}/prompt` — operation `session.prompt`. Body includes
  `id?`, `text`, `files?`, `agents?`, `skills?`, `metadata?`, `delivery?`, `resume?`.
  This is the admission write path; `resume:false` is admit-only.
- `GET /api/event` — operation `event.subscribe`, SSE (`HttpApiSchema.StreamSse`), group
  `server.event` (`@opencode/protocol@2.0.8` `dist/groups/event.d.ts` line 5). The same
  stream plugins consume via `ctx.event.subscribe()`.
- Generated promise client (`dist/promise/client.d.ts`): `session.prompt`, `session.synthetic`,
  `session.compact`, `session.command` return `SessionInbox{User,Synthetic,Compaction,…}`, and
  `session.inbox.list / cancel / update` expose the queue.

## 4. Can plugins read or write inbox state?

| Capability | Server plugin (`@opencode/plugin` promise) | TUI/CLI plugin (`@opencode/plugin/tui`) |
|---|---|---|
| Admit input (write) | **Yes** — `ctx.session.prompt` / `synthetic` / `command` / `compact`; input carries `delivery` and `resume` (`dist/promise/session.d.ts:143` domain `Pick`, input type from `@opencode/client`) | Yes — `context.client.session.prompt/…` |
| Observe events | **Yes** — `ctx.event.subscribe()`; `V2Event` union includes all four `SessionInbox*` events (`@opencode/client@2.0.8` types.d.ts:3279; `EventDomain extends Pick<EventApi, "subscribe">`). Verified live: plugin received `enqueued`, `delivery.changed`, `cancelled` | Yes — `context.data.on("session.inbox.…")` / `data.listen` (docs) |
| Read pending queue | **No** — the server plugin session domain is `Pick<SessionApi, "create"|"get"|"switchAgent"|"switchModel"|"prompt"|"generate"|"command"|"synthetic"|"interrupt"|"update"|"move"|"wait"|"context">`; no `inbox.*` | **Yes** — `context.data.session.pending.list(sessionID)` / `sync` / `invalidate` (docs + `dist/tui/context.d.ts:45`) |
| Cancel / change delivery | **No** in the plugin domain (HTTP client or TUI context only) | **Yes** — `context.client.session.inbox.update/cancel` (full generated client; docs: "can call the connected server") |

Practical consequence for our plugin: from the server side we can **write** admissions and
**observe** transitions, but we cannot enumerate someone else's pending queue or cancel it
through the plugin API. If the viewer needs a live pending list, either mirror it from the
event stream, use the generated HTTP client (`session.inbox.list`), or accept eventual
consistency from events alone. `metadata` can carry bus correlation ids.

## 5. Does it surface in the TUI?

Yes — the built-in TUI has a **"Queued prompts"** dialog. Evidence: the installed binary
embeds the TUI bundle as readable source strings (bounded `strings` extraction):

```
s(On,{title:"Queued prompts", get options(){return fe().map((ee,ce)=>
  ({title:ee.text,value:ee.id,footer:`${ce+1} of ${fe().length}`}))},
  onSelect:(ee)=>{zt("steer",ee.value)…},
  actions:[{command:"queued_prompt.delete",title:"delete", onTrigger:…}],
  footerHints:[{title:"steer",label:"enter"}]})
```

The same string also shows the TUI calling the API directly:
`ue.api.session.inbox.update({sessionID, inboxID, delivery:"steer"|"queue"})` and
`ue.api.session.inbox.cancel({sessionID, inboxID})`, with an error toast
`` `Failed to ${action} pending prompt` `` and the command ids `queued_prompt.delete` /
`queued_prompt_delete` / `queued_prompts`. So end users already get queue visibility,
steering, and deletion for pending prompts in the native TUI. Our viewer should not
compete with that inside OpenCode; cross-session/bus visibility is the part the native
inbox does not provide.

## 6. What the inbox is *not* (scope limits)

- **Per-session only.** Every API and event is keyed by `sessionID`; there is no
  cross-session inbox query or delivery.
- **Prompt-shaped payloads.** Items are `user | synthetic | compaction | move`; no
  arbitrary message kinds, no sender/recipient fields beyond `payload.metadata`.
- **Not durable after promotion.** Promotion consumes the row and appends a visible session
  message; the inbox API only lists *undelivered* work. (Probe: `inbox.list` empty after
  delivery; `session_inbox` row count 0.)
- **No addressability.** A prompt is admitted to one session; a "chat bus" routing layer
  that picks target sessions and correlates replies still has to exist outside it.

## 7. Verdict: integrate, mirror, keep our own viewer

- **Integrate (recommended).** Deliver bus messages into a target session through
  `session.prompt` / `session.synthetic` rather than writing transcript rows directly.
  The native queue gives durable admission, steer-vs-queue scheduling, cancellation, and
  restart durability for free, and bus correlation can ride in `metadata`. Never call
  `session.inbox.update`/`cancel` from a server plugin — those endpoints are not in the
  plugin domain (HTTP client / TUI only).
- **Mirror (optional).** Subscribe to `session.inbox.*` to show per-session delivery
  status (pending / delivered / cancelled, steer vs queue) in our viewer. A live queue
  listing needs `session.inbox.list` through the HTTP client or the TUI context, because
  the server plugin domain has no read method.
- **Do not replace the viewer with it.** The native inbox is session-local pending-input,
  not a cross-session mailbox; the built-in TUI already renders "Queued prompts" for its
  own sessions. Our cross-session viewer/storage remains necessary.

## 8. VERIFIED / UNVERIFIED

**VERIFIED (this session)**

- The `session_inbox` table schema, migration id, and index names, read from the installed
  2.0.8 binary (bounded `strings`) and confirmed present in the probe DB (fresh bootstrap,
  47 migrations).
- All four event names, their `data` payloads, and `durable.version: 1` — from
  `@opencode/protocol@2.0.8` and `@opencode/client@2.0.8` generated types, **and observed
  live** with the 2.0.8 server: `enqueued`, `delivered`, `delivery.changed`, `cancelled`.
- `delivered` fires at promotion after `session.execution.started` /
  `session.instructions.updated` and before `session.step.started` (one live observation).
- Admit-only (`resume:false`) enqueues without a model call; `inbox.list` / `update` /
  `cancel` work over the API; promotion empties the pending list.
- Server plugins receive all observed inbox events via `ctx.event.subscribe()`, verified by
  a live plugin (`/tmp/opencode/inbox-probe/project/.opencode/plugins/probe.ts`).
- The v2 docs API page documents `session.inbox.list/update/cancel` and their semantics
  (quoted strings), and the client's `session.prompt` input has `delivery` and `resume`.
- TUI presence: built-in "Queued prompts" dialog, `queued_prompt.delete` command, and
  direct `session.inbox.update/cancel` calls, read from the installed binary.
- TUI plugin data APIs `data.session.pending.list/sync/invalidate` per official CLI-plugin
  docs and `@opencode/plugin@2.0.8` `dist/tui/context.d.ts`.

**UNVERIFIED / open**

- Purpose of the co-existing `session_pending` table; it was empty in every probe state.
- Behaviors for `synthetic`, `compaction`, and `move` items were not exercised live
  (schemas are verified; the `compaction` item is presumably emitted by automatic/overflow
  compaction, the `move` item by `session.move`).
- Whether the promoted visible message keeps the same `msg_*` id as the inbox row
  (`inboxID`) — not checked after delivery.
- Concurrency ordering / exactly-once semantics for plugin event delivery; durability
  fields (`durable.aggregateID`, `seq`) were not exercised for replay.
- Does a newer binary build than 2.0.8 change anything above? Only 2.0.8 was inspected.
- What would settle these: a probe that exercises `session.synthetic` and `session.move`
  with a mock provider for deterministic promotion, reads back the promoted message id, and
  replays `/api/event` after reconnect using the durable cursor.

## Sources

- Installed binary: `/nix/store/dg787j4sa7hmxrgmcp0n2vajwmv3cbg3-opencode2-2.0.8/bin/opencode2`
  (`opencode2 --version` → `opencode v2.0.8`); bounded `strings` for symbols, SQL migrations,
  and the embedded TUI source.
- `@opencode/protocol@2.0.8`: `dist/groups/session.d.ts` (inbox endpoint + event schemas),
  `dist/groups/event.d.ts` (`event.subscribe`, `GET /api/event`).
  Local copy: `/home/kido/.bun/install/cache/@opencode/protocol@2.0.8@@@1/`.
- `@opencode/client@2.0.8`: `dist/promise/generated/types.d.ts` (event payload types,
  `V2Event` union line 3279, `SessionInbox*` types), `dist/promise/client.d.ts`
  (`session.inbox.*`), `dist/solid/data.d.ts` (`session.input`/`session.pending`).
- `@opencode/plugin@2.0.8`: `dist/promise/session.d.ts` (session domain Pick),
  `dist/promise/event.d.ts` (`EventDomain`), `dist/tui/context.d.ts` (`data.session.pending`).
- Official docs: `https://opencode.ai/v2/docs/api` (inbox operations/strings),
  `https://opencode.ai/v2/docs/build/plugins` (session prompt/RPC, events),
  `https://opencode.ai/v2/docs/build/plugins/cli` (TUI data APIs).
- Repo design docs (older branch than 2.0.8; naming `session_input`):
  `anomalyco/opencode` `specs/v2/session.md` (SHA f3c4211), `CONTEXT.md` (SHA 5e5955d).
- Probe: `/tmp/opencode/inbox-probe/` (`drive.ts`, `drive2.ts`,
  `project/.opencode/plugins/probe.ts`, `logs/plugin-events.log`, `logs/serve.log`),
  isolated `XDG_*` dirs, `opencode2 serve --port 7411`, generated 2.0.8 client.
