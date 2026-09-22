# Why agents stay silent: a local-evidence diagnosis

Research for ticket #77 (map #75, 0.5.0). Question: why do real-session agents post
almost no questions or answers?

Baseline (verified 2026-09-22): 20 chat DBs under `~/.local/share/opencode/chats/*.db`,
1,079 message rows — **1,014 system, 31 status, 28 finding, 5 answer, 1 question**.
All sessions are this repo's own development work (0.3.0/0.4.0 release waves, a scripted
research "discussion round", the 2026-09-21 horadric wave, and the current 0.5.0
wayfinder drive).

## 1. Session shape

### Participants and lifetimes

| Session (chat DB) | Window (UTC) | Participants | Posts |
|---|---|---|---|
| `ses_f3bcf34c9ffeGiiXB9ByJ3MlAB` (horadric wave) | 09-21 13:38 → 20:44 | main (YOLO) + 6 dig workers + questioner | 286 rows: 14 finding, 1 question, 1 answer, 17 status |
| `ses_f3872d5afffecY3KQnbSbxOJPU` (0.3.0 impl wave) | 09-22 05:18 → 05:36 | main + 2 impl subagents (3 subagent sessions for ticket #60) | 56 rows: 8 status, rest system |
| `ses_f381e008bffeXv43v61AI0Pfeb` (0.4.0 charting) | 09-22 06:51 → 08:23 | main + 1 background probe subagent | main: 6 posts (3 status, 3 finding) |
| `ses_f37b90a77ffe7hNS0sha3DUOqq` (research "discussion round") | 09-22 08:41 → 08:50 | main + 40 subagent sessions (wave 1) / 40 active (wave 2) | 199 rows: 10 finding, 4 answer (cross-replies), 1 status |
| `ses_f37920862ffet6t4GWyxbSSAYl` (current 0.5.0 wayfinder drive) | 09-22 09:24 → | main + 2 task subagents (#76, #77) | 28+ rows: 2 main status, cursors only elsewhere |
| 11 more DBs (e.g. `f37c895a1`, `f3822c85e`, `f3860c8c0`, `f3a59d414`, `f3bb9ad12`) | 09-20 → 09-22 | subagent sessions that joined and left | system rows only (join/leave); zero agent posts |

Subagent lifetimes range from ~40–110 s (research wave 1: 40 distinct names joined
08:42:34–35, left "completed" 08:43:22–08:44:25) to 2–4 h (horadric dig
`ses_f3bcbd6c4ffeOhx45y29vWCqRY`, 13:42:28 → 17:21:55, per `session_v2` in
`~/.local/share/opencode/opencode.db`). Wave-2 subagents were interrupted en masse at
08:50:27 when main interrupted.

### Task shape (primary sources: `session_message` user rows in opencode.db)

Every observed subagent task was **self-contained by construction**:

- Research task, `ses_f37b809c6ffe88w06xdcOWBNs5` seq 4 @08:42:34:
  "Single task: use web search to find the year the first iPhone was released and its
  initial screen size. … Cite the specific source you actually checked … Keep your ENTIRE
  response under 3 sentences. Return a summary, not a transcript."
- Phase-2 script, same session seq 33 @08:45:11 (verbatim): "Follow-up phase 2: your
  original research is done. Now work in the session's shared chat … 1) Post your verified
  result … as one message of kind 'finding' … 2) Then read the roster and the chat a few
  times over the next ~20-30 seconds … 3) When peers' findings appear, reply to 1-2 of
  them with something substantive … Keep every chat post under 3 lines."
- Implementation tickets arrive with full ticket bodies (0.3.0 wave, chat `#4` @05:20:34:
  "two subagents, one worktree each"); wayfinder tickets (#76/#77) carry the full
  question text in the session's user message.

**Were there situations where a peer's input was genuinely needed?** Exactly one across
the whole dataset: the `0x55cf50` marker ambiguity in the horadric wave (question `#30`,
section 2). Every other task needed no peer input — facts verifiable on a live source,
or tickets written to be executed alone.

## 2. Where questions should have happened

**Zero posts in wave 1.** All 40 research subagents ran phase 1 (self-contained fact
task, protocol text present) and completed with **no chat posts of any kind** — not
even `status`. Chat `ses_f37b90a77ffe`: 40 join system rows 08:42:34–35, 40 completed
leave rows 08:43:22–08:44:25, no agent posts between.

**Read-then-silent in wave 2.** With the scripted phase 2, 10/10 posted their finding
(`#134`–`#143`, 08:45:22–08:47:01) and 3 posted cross-replies (`#144`–`#148`,
08:49:37–08:50:12: `general-2tq1xihm` ×2, `general-rgna47u9` ×2, `general-4907zg6m` ×1).
The **7 non-replying subagents** (`ridzeonb`, `0lv6rw0i`, `xz7n8f57`, `bzgipmhs`,
`ma9v7ndu`, `r4nxr1k3`, `q1tthzgu`) have cursor rows with `last_read_id` 143–148,
`updated_at` 08:47:12–08:50:20 — they consumed peers' findings *and the cross-replies*
at their model steps, then stayed silent.

**Concrete assume-instead-of-ask case:** `ma9v7ndu`
(`ses_f37b809b8ffebz3R5IUeCsomi1`, "Search: B-tree index"), opencode.db rows:
posted finding `#137` @08:45:12, read roster + open-questions + `since:137` @08:45:45,
re-read @08:48:13 with reasoning "Both verified live: 1. Wikipedia 'Computer worm' … 2.
Wikipedia 'Boiling point' …" (i.e. it live-verified two peers' claims), then went idle
@08:50:27 with **no reply posted** — despite the task explicitly commanding "reply to
1-2 of them with something substantive." It verified what peers needed and concluded
there was nothing to say.

**Silent-death case (0.3.0 wave).** Ticket #60's subagent attempts 1–2 died without
deliverables; the subagents posted **nothing** (no `blocker`, no `status`) before dying.
Failure became visible only when the orchestrator posted: main `#27` @05:24:44 "first
subagent run ended without committing anything; retry (attempt 2 of 3) is now running";
main `#34` @05:28:24 "retry (attempt 2) also ended without a deliverable … the run died
mid-way through a single oversized test-file rewrite (same signature as attempt 1)".
A dead attempt's cursor shows it was alive and consuming mid-run statuses until its
death: `general-2` (`ses_f387061eaffeoADjX6SlP064Ef`) `last_read_id=27`, updated
05:25:18 — 34 s after main's `#27`.

**The one question ever posted** — `ses_f3bcf34c9ffe` `#30` @15:06:35
(`agent/general`, `to:` ALL):

> "re #409 Ghidra writes: entry 9 … 0x55cf50 … carries no explicit '— TAG re:verified'
> marker. One question: should 0x55cf50 (a) get the same [runtime] plate paragraph, and
> (b) get the re:verified tag? **Default I will apply if no answer:** plate only, no
> tag, reported as ambiguous. I am writing all the other addresses meanwhile."

It was pre-armed with a declared default by its author (the prepared write file
`/tmp/opencode/409-ghidra-writes.md`, written by YOLO-3 at 15:04:27–51, seq 4409) and by
the asker — ask-but-don't-wait, per the protocol's "say what you will do while you
wait". Self-answered in `#31` @15:08:16 (`in_reply_to=30`): "No answer arrived before
the session finished, so I applied the stated default …"

## 3. Lifecycle

### Reconstruction of the question window (opencode.db, horadric wave)

| Time (UTC 09-21) | Who (session) | Event |
|---|---|---|
| 15:04:57 → 15:05:03 | YOLO-3 `ses_f3bcbd6c4ffe` seq 4427 | `subagent` tool call "Ghidra plates for #409" — **returns in ~6 s (asynchronous spawn)** |
| 15:05:03 | questioner `ses_f3b803967ffe` created | task: apply prepared write file; "Return a compact summary (max 15 lines)" |
| 15:05:16 → 15:09:19 | YOLO-3 seq 4445 | `shell` "sleep 240" + poll sweep — **inside a 4-minute tool call spanning the entire question window** |
| 15:06:35 | questioner | posts question `#30` (same model step as continued work) |
| 15:07:25 | questioner | polls chat: `chat.read({open_only: false})` ("Let me check chat for an answer about 0x55cf50 before tagging") |
| 15:07:29 | questioner | no answer → applies declared default |
| 15:08:05 | questioner | second poll: `chat.read({open_only: true})` |
| 15:08:09–15:08:16 | questioner | posts answer `#31` (`in_reply_to=30`), self-closing; question leaves the open-questions predicate |
| 15:08:24 | questioner | `idle` — execution done; session finished |
| 15:09:19 | YOLO-3 | next model request after the `sleep 240` — **after the question was already closed** |

- **The question was open 101 s** (15:06:35 → 15:08:09).
- Both peers with answer authority had **no model requests during the whole window**:
  YOLO-3 was inside `sleep 240` (started 15:05:16, before the question existed); main
  (`ses_f3bcf34c9ffe`) has **zero `session_message` rows between 14:50 and 15:30** —
  blocked in its own `subagent` tool wait since 13:42 (waiting on the six digs).
- **Do questions die with the sender?** Yes, in the only observed case: the asker's
  execution ended at 15:08:24, 9 s after self-closing; any late answer would have gone
  to a finished session. The asker polled twice while alive and got nothing because the
  only plausible answerer was asleep inside a tool call.
- **Does the main agent consume digests mid-run?** Yes, whenever it is not blocked in a
  tool call: 0.3.0-wave main cursor `last_read_id=53`, updated 05:36:10 — 3.2 s after
  its own status `#53` @05:36:07 (posted after subagent statuses `#39`/`#46`); current
  drive main `last_read_id=22` @09:32:47. Main-side consumption is **not** the
  bottleneck.
- **Structural timing gap:** digests ride the context hook on the *next model request*
  (`src/plugin.ts` context hook + `src/core/handle.ts` `nextDelivery()`). An agent
  inside a tool call receives nothing until the call returns; an agent whose task
  finished receives nothing at all. The only question's 101 s open lifetime was shorter
  than the answerer's single 240 s tool call — no model request on either side of the
  exchange could have bridged it.

## 4. Text and presentation hypotheses

### Current wording (`docs/chat-protocol.md`, main @ 89df0a0)

- L4: "Use it to keep peers current and **to ask when you are in fog**."
- L18: "An empty digest means silence — keep working."
- L26: "`question` — **a fact or decision you cannot reach alone**."
- L31: "**Silence is the default; a post that changes nothing is noise.**"
- L37: "Close your questions: reply with `answer` when you settle one, **yours or a peer's**."
- The tool description repeats the same bar (`src/plugin.ts` `POST_DESC`): "Silence is
  the default — post what changes a peer's decisions."

Read plainly, this sets a **high ask bar** (only "fog" you "cannot reach alone") and a
**sanctioned non-blocking exit** (declare a default, close your own question). The one
observed question is exactly shaped this way. "Silence is the default" appears in the
protocol *and* the tool description *and* as the empty-digest instruction — three
reinforcements that posts (of any kind, let alone questions) are the exceptional move.

**Behavioral contrast, same cohort:** protocol text alone (wave 1) → 0/40 subagents
posted anything; imperative user message (wave 2 phase-2 script) → 10/10 posted the
scripted finding, but only 3/10 performed the scripted peer reply. User-message
imperatives override protocol text for the *minimum* scripted post; even then the
"reply to peers" half was executed by a third. The protocol text demonstrably does not
elicit proactive questioning.

### Presentation (salience of a peer's open question)

- Open-questions footer (`src/core/render.ts` `renderOpenQuestions`): renders
  `Open questions: #id (sender)` — **IDs and sender names only; no body excerpt, no
  addressee hint**, capped at 5 lines. A peer sees that a question exists, not what it
  is or who should answer; evaluating it costs a `chat_read`.
- Join briefing: last-N messages within 2,000 chars (`src/core/digest.ts`
  `buildJoinBriefing`) + the footer.
- **This was never actually exercised in the dataset.** There was no moment when a live
  open question appeared in any peer's digest: the single question was open (101 s)
  only during the answerer's tool-call gap, and the asker's own join briefing
  (15:05:03, 29 prior messages) would have shown "Open questions: none". The salience
  gap is a code-reading, not observed behavior — untested by the data.
- Minor: `#30` posted `to:` ALL although the protocol says "Name the peer who can
  answer in `to`" (L36); the asker knew the plausible answerer (its parent). A targeted
  `to:` would not have changed the outcome (lifecycle gap) but would have narrowed the
  candidate set.

### Ruled out

- `RunGuard` limits (`src/core/protocol.ts`: 25 posts/run default, duplicate-body
  guard) are not binding: max observed is 9 posts in one session.

## 5. Evidence gaps (what was missing)

1. **No plugin debug log.** `~/.local/share/opencode/chats/debug.log` does not exist;
   `options.debug` defaults to `false` (`src/core/options.ts`), so per-delivery lines
   ("delivery <session> cursor=<id>") were never recorded. Which digests were pushed on
   which model requests is inferred from cursor writes, not logged.
2. **No persisted digest/briefing text.** The context hook pushes text only into the
   model request; opencode.db stores `session_message` rows (user/assistant/synthetic/
   idle) and hashed system-prompt sections (`instruction_state`/`instruction_blob`),
   none of which contain agent-chat content. "Did the model see the digest" is inferred
   from cursor updates + observed behavior.
3. **No server log for 09-21.** `~/.local/share/opencode/log/opencode.log` is a single
   rolling file starting 2026-09-20T14:35:45Z (28 MB, last line 09-22T09:40:37Z); its
   11,049 "agent-chat" mentions are mostly file-tracking noise from work in this repo,
   and horadric session IDs appear only 3–5× (spawn lines). Lifecycle evidence for the
   horadric wave therefore rests on opencode.db `session_message` timestamps
   (`time.created`, tool `state.time`) — authoritative, but single-source.
4. **Sample shape.** All sessions are one operator's development of this repo, two
   calendar days, ~7 substantive sessions; every task was authored by the same human.
   Findings generalize to how *this* operator writes subagent tasks.

## 6. Root-cause assessment (ranked)

1. **Session shape / task design — primary (structural).** Tasks are written
   self-contained (full ticket text in the user message; live-verifiable facts;
   scripted phases), so peer input is rarely genuinely needed: 0/40 posts in wave 1 is
   rational behavior, not a protocol failure. The one real ambiguity (`#30`) was
   pre-armed with a declared default by task author and asker. Consequence: no prompt,
   presentation, or delivery fix will elicit questions from tasks that don't need peers.
   **The evaluation design must include tasks that require peer input**, or the red
   baseline stays at ~0 by construction.
2. **Lifecycle / timing — secondary, decisive for the one question that did exist.** A
   question can only be answered if a capable peer has a model request during the open
   window. In `#30`'s 101 s window, both authority-holding peers were inside long tool
   calls (YOLO-3: `sleep 240` 15:05:16 → 15:09:19; main: subagent-wait since 13:42,
   zero rows 14:50 → 15:30), and the asker's execution ended with the task (idle
   15:08:24) — the question died with its sender. Main *does* consume digests mid-run
   when unblocked (cursor `last_read_id=53` @05:36:10 in the 0.3.0 wave), so the
   bottleneck is the blocked parent plus the asker-side execution boundary — a digest
   riding "next model request" cannot bridge a 240 s tool call. Candidate fixes:
   shorter answerer-side blind spots, or questions that survive the asker's execution
   (they already do in the DB — the gap is on the answerer side).
3. **Prompt wording — tertiary.** "Silence is the default" (L31 + tool description +
   empty-digest line) with questions scoped to "cannot reach alone" (L26) and
   self-closing sanctioned (L37) sets a high ask bar with a legitimate non-blocking
   exit. Evidence: 0/40 posts under protocol text vs 10/10 under an imperative message;
   under the imperative, only 3/10 did the scripted peer reply. Wording sets the floor
   (silence); only user-level imperatives move behavior, and only to the scripted
   minimum.
4. **Presentation — weakest, never exercised.** The footer shows only `#id (sender)`
   (no body, no addressee — `src/core/render.ts`), and no peer in the dataset ever
   received a digest containing a live open question, so the salience gap is inferred
   from code, not observed. Needs an evaluation with a live question and a capable,
   unblocked peer to test (and to make the footer useful: body excerpt + addressee
   hint).

For the downstream tickets: the draft 0.5.0 agent-facing text should lower the ask bar
and make "ask while waiting" the explicit pattern for *decisions* (not just fog), and
the digest/briefing rendering decision should carry the addressee hint; but neither
will show an effect in evaluation until session shapes include peer-dependent tasks
(rank 1) and an answerer that is reachable mid-question (rank 2).
