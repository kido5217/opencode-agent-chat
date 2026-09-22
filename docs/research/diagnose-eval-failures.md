# Clean-run diagnosis of the 0.5.0 `eval` smoke scenario

Ticket #88 (map #87). Researched 2026-09-22 with one clean local run:
`nix develop -c bun run smoke --scenario eval` (unquoted), 30 model runs
(5 runs × 3 scenarios {ask, answer, noise} × 2 arms {baseline = 0.4.1 worktree at
`89df0a0`, new = main `c4195dd`}), model `deepseek/deepseek-flash`, per-run cap
600 s. Wall time ≈ 80 min (18:13 → 19:32 MSK); the 15–45 min expectation missed
because nine runs burned the full 600 s cap.

## 1. Outcome

**Classification: (4) green — the gate works; the prior "failures" were launch-level only.**
The clean run completed and the gate passed:

```
eval (5 runs/scenario) — ask: baseline=0/5 new=1/5 | answer: baseline=0/5 new=4/5 | noise: baseline=0/5 new=0/5
PASS eval
```

Exit 0. All three asserts in `smoke/run.ts` (lines 681–692) held:

- ask: `n.ask.asked >= 1 && n.ask.asked >= b.ask.asked` → `1 >= 1` and `1 >= 0`
- answer: `n.answer.answered >= 1 && n.answer.answered >= b.answer.answered` → `4 >= 1` and `4 >= 0`
- noise: `n.noise.noised <= b.noise.noised` → `0 <= 0`

The two prior attempts (exit 127 from a quoted multi-word command; SIGTERM session
teardown) died before the harness started work — no clean-run output ever existed.
This run is the first one that reached the final line.

### Counts table (per scenario × arm)

| scenario | baseline (0.4.1) | new (main) | gate | verdict |
|---|---|---|---|---|
| ask | 0/5 | 1/5 | `>= 1` and `>= baseline` | pass (thin margin) |
| answer | 0/5 | 4/5 | `>= 1` and `>= baseline` | pass |
| noise | 0/5 | 0/5 | `<= baseline` | pass (guard held) |

## 2. What the clean run verified working

- Scaffold/mount/credential/DB path: plugin loaded in every new-arm run
  (`[ts] plugin loaded`, `chat tool ids: chat_post, chat_read, chat_roster` in
  `chats/debug.log`); isolated XDG homes seeded from host credentials +
  `models-dev:catalog`; chat DB migrated (schema + system join rows); digests
  delivered (`digest <child-session> cursor=2`).
- Model responsiveness: `deepseek-flash` answered in 1–2 s per turn (reasoning +
  tool calls) — no provider-side hangs observed.
- New-arm answer behaviour: 4/5 runs posted `kind=answer` replying to the seeded
  question, e.g. from `new-answer-0`'s chat DB:

  ```
  {"id":2,"sender_name":"main","kind":"question","body":"What is the internal codename of the staging environment?"}
  {"id":4,"sender_name":"probe-child-ewz93g2r","kind":"answer","to_name":"main","in_reply_to":2,"body":"bluefin — the staging environment's internal codename is bluefin."}
  ```
- New-arm noise behaviour: 0/5 runs posted on the self-contained task (chat DBs
  hold only the two system join rows) — the new text does not over-ask.
- Worktree lifecycle: harness created the 0.4.1 baseline worktree and removed it
  on exit; no worktrees or `agent-chat-eval-*` dirs left behind.

## 3. Defect A — baseline arm: plugin fails to load (harness/scaffold bug)

The baseline arm's 0/5 is **not a measurement of 0.4.1 model behaviour**. The
baseline worktree is a bare `git worktree add --detach` checkout of `89df0a0`;
`node_modules` is gitignored, so the worktree has none. Both arms'
`src/plugin.ts` import the npm dependency `@opencode/plugin`, which bun cannot
resolve from the worktree. The plugin therefore never loads in the baseline arm:

```
level=WARN message="failed to load plugin" target=.../mount
cause="Cause([Die(ResolveMessage: Cannot find package '@opencode/plugin' imported from .../baseline-wt/src/plugin.ts)])"
```

(excerpt from the prior attempts' retained `data/opencode/log/opencode.log`; the
same worktree mechanism applies to this run — baseline runs here left zero chat
artifacts in `chats/`, consistent with the same failure.)

Consequences: baseline agents run with **no chat plugin at all** (no
`chat_post`/`chat_read`/`chat_roster` tools, no protocol text, no chat DB). The
two-arm comparison is comparing "0.5.0 text + working plugin" against
"no plugin", and the gate's `>= baseline` clauses are trivially true. The
baseline column in §1 is structurally 0/5 and must not be read as "0.4.1 agents
don't ask/answer". This is a scaffold bug — fix belongs to #90/#91 (install deps
in the worktree, or mount the baseline source against the repo's `node_modules`).

## 4. Defect B — ask arm: 600 s timeouts conflate "stuck exploring" with "did not ask"

In the new arm, 4 of 5 ask runs (ask-0, ask-1, ask-3, ask-4) burned the full
600 s cap and were killed by the harness `timeout -k 5s 600s`; ask-2 finished in
~18 s. The single counted ask post comes from one of {ask-0, ask-1, ask-2}
(ask-3/ask-4 final chat DBs hold only the two system join rows; per-run identity
of the post is unrecoverable — see Defect D).

The stall mechanism (full session trace captured for ask-4 from its
`data/opencode/opencode.db` `session_message` rows): the probe-child, blocked on
the peer-only codename, reasons correctly —

> "This is a scenario where the agent should ask rather than hallucinate."

— but then escalates local fact-finding into unbounded filesystem exploration
instead of posting `kind=question`:

```
shell: find / -name "config.json" -not -path "*/node_modules/*" 2>/dev/null | head -50   (ran ~121 s, opencode's internal shell cap)
reasoning: "The find over / timed out. Let me be more targeted. Look at .opencode first."
shell: cd <evalroot> && find config -type f -exec cat {}; find data -type f; ...; find cache -type f | head   (stuck "running" until the 600 s kill)
```

`find /` was observed live in uninterruptible sleep (`D` state) scanning the
whole host filesystem — the anti-pattern this host's AGENTS.md warns about — and
the child had no isolated-home guidance forbidding it. The harness then counts
the killed run as "child did not ask" (`zeroCounts()`), so **the ask gate's 1/5
is an undercount of willingness to ask**: four runs never reached the point of
choosing. The 5-run bar at a 600 s cap is the wrong instrument for this scenario.

## 5. Defect C — crashed runs are silently read as "no posts"

`runEvalArm` never checks the opencode exit code: a run killed at the cap
(exit 124) or one that errors out early is read from its chat DB and silently
counted as zero questions/answers. One concrete fast-failure observed this run:
in `new-answer-3`, main posted the seeded question (row id 2), then its second
turn died mid-way — the `subagent` tool call is recorded with
`"status":"streaming"` and no completion (model stream interrupted); the run
ended, the child session never joined (no "probe-child … joined" row), and the
run counted 0 answers. Crash and "chose not to post" are indistinguishable in
the counts.

## 6. Defect D — per-run evidence is destroyed after each successful run

`withRoot` in `smoke/run.ts` `rmSync`s every per-run root after the run's
`work()` succeeds, and the final `rmSync(baseRoot)` removes the rest. Per-run
artifacts (chat DB + WAL, `data/opencode/opencode.db`, `opencode.log`,
`eval-run.log`) exist only while the run is in flight; a final-assert failure
leaves nothing to diagnose. This diagnosis required an external 5 s snapshotter
mirroring `/tmp/nix-shell.*/agent-chat-eval-*/` (artifacts kept at
`/tmp/opencode/eval88-evidence/` — ephemeral). Retention of per-run DBs/logs is
a lock requirement for #90.

## 7. Implications

**For the rebuilt-eval lock (#90):**

- Fix the baseline arm before locking any two-arm gate (Defect A): a baseline
  that structurally posts 0 makes every "new ≥ baseline" clause vacuous.
  Until then, the gate is a one-arm gate (new must post ≥ 1 ask/answer and not
  over-noise) — which is all this run actually measured.
- Break the timeout/non-compliance conflation (Defect B): count runs killed at
  the cap separately from clean completions (e.g. record `timeout` as a fourth
  outcome per run), and/or constrain probe-child's environment (no `find /`;
  sandboxed cwd) so a stuck exploration can't burn the whole budget.
- Surface per-run exit codes and keep per-run artifacts (Defects C, D): the
  counts must be able to distinguish "crashed", "timed out", and "chose silence".
- The noise guard is sound as written (0/5 both arms this run) — keep it.

**For the judge prototype (#89):**

- The ask scenario is the judge's natural first test case: 1/5 of clean runs
  posted the expected `question`, 4/5 were stuck in exploration — a rubric judge
  reading per-run chat DB + `session_message` history (both available once
  artifacts are retained) must score "stuck exploring before asking" differently
  from "finished without asking". This run's ask-3/ask-4 traces are ready-made
  calibration fixtures.
- Answer/noise behaviour is consistent enough (4/5, 0/5) that the 5-run rate is
  an adequate instrument there; the judge is needed for the ask dimension and for
  the free-text quality of posts (all four answer posts were correct
  `in_reply_to` replies).

## 8. Run log

- Preflight (this session): host `credential` row + `models-dev:catalog` present
  (catalog contains `deepseek-flash`); `opencode` 2.0.12 on PATH in the dev
  shell; three stale baseline worktrees from the dead prior attempts removed
  (`git worktree remove --force`, all clean 0.4.1 checkouts).
- Prior attempts (from retained artifacts): attempts at 13:05Z and 14:22Z both
  reached new-ask-4 (run 16/30) before SIGTERM teardown; a 14:57Z attempt died
  during baseline-ask-0 (its `opencode.log` carries the Defect A WARN and a
  600 s timeout at 15:07:10Z). One attempt died at launch (exit 127, quoted
  command) with no artifacts.
- This run: started 18:13 MSK, finished 19:32:44 MSK with `PASS eval` (exit 0).
  New-arm ask runs 0/1/3/4 and ≥3 baseline runs each burned the 600 s cap.
