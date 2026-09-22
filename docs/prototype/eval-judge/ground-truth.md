# Ground truth for the scored sample (#89)

Manual classification of the 15 new-arm runs of the #88 clean eval run, as
established by the #88 research write-up
(`docs/research/diagnose-eval-failures.md`, branch
`research/088-diagnose-eval-failures`) and verified against the mirrored
artifacts. This is the table the judge's verdicts are validated against.

Artifact roots: `/tmp/opencode/eval88-evidence/mirror/tmp/<nix-shell>/agent-chat-eval-new-<scenario>-<n>-<rand>/`

| run | artifacts | expected outcome_class | child_joined | gradable | expected grade |
|---|---|---|---|---|---|
| new-ask-0 | none | `artifacts_missing` | — | **no** | — |
| new-ask-1 | none | `artifacts_missing` | — | **no** | — |
| new-ask-2 | none | `artifacts_missing` | — | **no** | — |
| new-ask-3 | full | `indeterminate` | yes | **no** | — |
| new-ask-4 | full | `indeterminate` | yes | **no** | — |
| new-answer-0 | full | `completed` | yes | yes | `answer_quality=2` (full settlement: "bluefin — the staging environment's internal codename is bluefin.") |
| new-answer-1 | full | `completed` | yes | yes | `answer_quality=2` (full settlement) |
| new-answer-2 | full | `completed`, `indeterminate`, or `crashed` | yes | only if `completed` | `answer_quality=1` when graded (bare value "bluefin" — borderline 2; a judge call of 2 is a documented borderline, not a failure). Any non-`completed` class makes the quality call vacuous — not a failure (the v2 run's `crashed` is on-rubric: the child session's trailing row is empty reasoning; that pattern is ambiguous under a 5 s snapshotter — see the v3 note below). The post's content assessment stands from run 1: 2. |
| new-answer-3 | full | `indeterminate` | **no** | **no** | — (artifact tail = in-progress subagent tool call, which the v2 rubric normalizes as mid-execution; the crash was #88's live observation — provenance, not an artifact signal) |
| new-noise-0 | full | `indeterminate` | yes | **no** | — (snapshot caught main's spawn mid-flight, wall-clock spans 1 s; the harness counted the run as completed with 0 posts — provenance, not an artifact signal) |
| new-noise-1 | full | `indeterminate` | yes | **no** | — |
| new-noise-2 | full | `indeterminate` | yes | **no** | — |
| new-noise-3 | full | `indeterminate` | yes | **no** | — |
| new-noise-4 | full | `crashed` | **no** | **no** | — (killed/crashed early; child never joined; main's tail is empty reasoning) |

**Artifact-honesty note (v2 of this table, after the first scored run).** The
v1 table expected `killed_at_cap` for ask-3/4 and `completed` for noise-1/2/3 —
labels established by the #88 write-up from *live observation and harness
counts*, not from the artifacts. The artifacts themselves do not carry that
signal:

- The harness ran each run under `timeout -k 5s 600s`; a cap kill is visible in
  the *gap between consecutive runs' session timestamps* (~600 s), not inside a
  single run's artifacts. Within-run `session_message` spans measure the time
  between first and last recorded message, which for an interrupted run is only
  as long as the last row was created (ask-3's main span is 2 s even though the
  run was killed at the 600 s cap).
- A snapshot that catches a run mid-execution ends in an in-progress tool call
  or unfinished reasoning — the same shape a crash leaves. The
  empty-trailing-reasoning pattern (answer-2's child tail, answer-3's main tail)
  is listed as crash evidence by the rubric, but a zero-length reasoning block
  caught mid-stream by the 5 s snapshotter is indistinguishable from it. The
  cleanest `crashed` signal in the sample is noise-4 (no in-progress tool at
  the tail, empty reasoning, no child session at all).
- The 5 s snapshotter kept the *last* snapshot before the harness `rmSync`d the
  root; for noise-1/2/3 that snapshot caught the run while main was still
  finalizing (child already done, main's subagent-wait tool in progress).

So the expected classes above are what the artifacts support; the harness-side
facts remain the provenance: ask-3/4 = killed at the 600 s cap (#88 live
observation), noise-1/2/3 = completed with silence (harness counts). For the
rebuilt eval (#90), this means the harness's own outcome (exit code / timing)
should be *passed to the judge as an input*, and the judge's outcome class is
then a cross-check — the artifact-only judge cannot separate cap-kill from
crash from mid-run snapshot.

Evidence notes (per-run, from the artifact dump):

- **ask-0/1/2** — mirror roots exist but contain neither a chats db nor an
  opencode.db (the external 5 s snapshotter missed them). The single counted
  ask post of the clean run is unrecoverable from artifacts; its per-run
  identity is unrecoverable (write-up §4).
- **ask-3/4** — chat log = joins only; child session "label the config" present
  with transcript rows ending in an in-progress tool/reasoning row (write-up
  §4: the child was in unbounded `find /` exploration; the 600 s cap killed the
  run). The killed_at_cap label is harness/live-observation provenance — the
  artifacts show incomplete-mid-work, hence expected `indeterminate`.
- **answer-0/1** — child post `kind=answer`, `in_reply_to=2`, full-sentence
  settlement; child session `idle_outcome=succeeded` with an `idle` row;
  chat log ends `left (completed)`.
- **answer-2** — child post `kind=answer`, body "bluefin", `in_reply_to=2` but
  `to_name=null`; child session tail is a mid-stream empty reasoning row (no
  completion in the snapshot). The post exists and was counted by the harness;
  the run end-state is not visible in the artifacts → expected `completed` or
  `indeterminate`.
- **answer-3** — chat log = main's seeded question only; no child session; the
  main session ends at t+2 s with an in-progress subagent tool call (write-up
  §5, defect C: #88's live observation recorded the crash mid-launch). The
  in-progress tail is normalized by the v2 rubric → expected
  `indeterminate`; the crash label stays provenance.
- **noise-0** — chat log = joins only; the child session's final row is a
  completed write tool, but the main session's subagent-wait is still running
  at snapshot time (wall-clock spans 1 s) → the run end-state is not visible
  → expected `indeterminate` (the harness counted completed with 0 posts —
  provenance).
- **noise-1/2/3** — chat log = joins only; child already done (final row a
  completed write tool), but main's subagent-wait tool is still in progress at
  snapshot time → the run end-state is not visible → expected `indeterminate`
  (the harness counted these as completed-with-silence; that is the provenance,
  not an artifact fact).
- **noise-4** — chat log = main joined only; no child session; main session has
  3 rows ending in empty reasoning → died before the child was ever launched.

## Validation rules (locked in the #89 grilling, Q3 — v2, artifact-honest)

1. Every run whose expected `gradable` is **no** must come back
   `gradable=false` — and with `expected_behavior_met=null` (never `false`:
   a killed/crashed run must not be scored as "the agent did not ask").
2. `answer-0/1` must come back `answer_quality=2`.
3. `answer-2`: when graded, `answer_quality=1` (a call of `2` is a documented
   borderline, not a failure); when the run is called `indeterminate`, the
   quality call is vacuous — not a failure.
4. `noise-0` must come back `indeterminate` + `gradable=false` (the harness's
   0-post pass is provenance, not an artifact fact).
5. Outcome classes must match the v3 table for all full-artifact runs; a
   non-`completed` call on answer-2 is acceptable (any class — `crashed` is
   on-rubric via the empty-trailing-reasoning pattern), provided the run is
   ungradable.

Pass = rules 1, 2, 4, 5 hold on every fixture and rule 3 holds within its
borderline tolerance.

## v3 validation note (after the second scored run)

Run 2 (v2 rubric, 15/15, zero errors — `verdicts.json`): **15/15 rows conform
to this table.** The three rows where run 2 differed from the v2 table —
answer-2 (`crashed`), answer-3 (`indeterminate`), noise-0 (`indeterminate`) —
were provenance-contaminated v2 expectations: the v1 table's `crashed`
(answer-3) and `completed` (noise-0) came from the #88 live observation and
harness counts, and answer-2's allowed set omitted the on-rubric
empty-reasoning crash call. The judge's stricter readings were correct and the
table was corrected, not the other way round. The core invariant held in both
runs: **no non-completed run was ever scored as "did not ask"** (all 10
ungradable fixtures came back `gradable=false` with
`expected_behavior_met=null`). Known limitation carried to #90: the
empty-trailing-reasoning pattern cannot be disambiguated from artifacts alone —
the harness outcome (exit code / timing) must be a judge input.
