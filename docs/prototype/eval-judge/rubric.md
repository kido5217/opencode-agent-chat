# 0.6.0 eval judge — rubric + prompt (prototype #89)

Throwaway prototype (map #87, ticket #89). The judge is **advisory**: deterministic
DB counts stay the hard gate of the eval; this instrument reports *quality* and,
critically, *why* a run that shows zero posts actually shows zero posts (killed /
crashed / genuinely silent). Nothing here feeds the gate.

## Judge model

`Qwen3.8-27B` at `https://ai.kido.ws/v1` (OpenAI-compatible, no auth, self-hosted).
It is a **reasoning model**: `reasoning_content` is separate from `content`, so the
script budgets ~4 k output tokens and reads `content` only. It is a different model
family than `deepseek-flash` (the model under test) — no self-scoring bias.

## Rubric — four axes (locked in the #89 grilling)

### Axis 1 — run-outcome class (always emitted; the load-bearing axis)

| class | evidence |
|---|---|
| `completed` | child left (completed), or a session recorded a success outcome, or the run clearly reached its end state |
| `killed_at_cap` | still working when the harness wall-clock cap killed it: session span near the 600 s cap, active tool/reasoning activity, no completion rows |
| `crashed` | died abnormally: a subagent launch that never completed, empty trailing reasoning, child never started while main's turn is incomplete |
| `artifacts_missing` | the run left no usable artifacts |
| `indeterminate` | evidence cannot settle which of the above |

Plus `child_joined` (did the child appear in the chat log / exist as a child session).

**The rule this exists for:** if the outcome class is not `completed`, the run is
**not gradable**. A run killed mid-work is *not* evidence that the agent "did not
ask". (This is the direct fix for the #88 defects: crashed runs silently read as
zero posts, and the ask gate conflating the 600 s timeout with non-asking.)

### Axis 2 — question quality (ask runs only)

- `0` — no question post, or the post is not a genuine question.
- `1` — a question the child could answer itself, or manufactured trivia not needed to proceed (the noise territory).
- `2` — a **genuine peer-dependent question**: the child needs main's input to proceed and cannot obtain it alone.

### Axis 3 — answer quality (answer runs only)

- `0` — the referenced question is not settled (no reply, or the reply does not answer it).
- `1` — settled partially or with material omission (e.g. a bare value where the question asked for identification).
- `2` — a direct, complete settlement of the referenced question.

Content only — database artifacts (e.g. a `null` `to_name`) are **not** quality defects.

### Axis 4 — noise (noise runs only)

Binary. The child was given a fully self-contained task; correct behavior is zero
chat posts. `post_count` = agent (non-system) posts. `pass` = 0 posts; `fail` = any
post, with the reason the agent posted it (a legitimate reason is a *scenario*
signal, reported as advisory).

## Judge prompt

System message (verbatim, sent with every call):

```
You are an evaluation judge for a multi-agent chat system under test. A harness runs scripted scenarios; in each, a "main" agent launches a "child" agent (probe-child) and the measured behavior is the child's chat posts (question/answer) or its silence. You receive ONE run's artifacts: the scenario, its setup, the expected child behavior, the full chat log, session metadata (with per-session wall-clock spans), and transcript tails.

CLASSIFY THE RUN OUTCOME FIRST. Outcome classes:
- completed: the run reached its normal end state (child left completed, a session recorded a success outcome, or the activity clearly finished).
- killed_at_cap: the harness wall-clock cap (~600 s) killed the run while it was still working. Require wall-clock evidence: a session span at or near the cap. Do not infer the cap from the absence of completion rows alone.
- crashed: the run died abnormally. Require POSITIVE evidence of abnormal termination, e.g.: the child never started (no child session, no child join in the chat log) while main's turn is incomplete, or a trailing EMPTY reasoning row with no content. An in-progress tool call or an unfinished trailing reasoning at the end of the artifacts is NORMAL for a run the snapshot caught mid-execution — it is NOT by itself evidence of a crash.
- artifacts_missing: the run left no usable artifacts.
- indeterminate: the evidence cannot settle which of the above — including runs whose artifacts simply end mid-execution without positive crash evidence (a snapshot may have caught the run while it was still running, and wall-clock run duration is not visible in these artifacts). When in doubt between killed_at_cap / crashed / indeterminate, choose indeterminate: the harness (not this judge) will confirm the cap from its own timing and exit codes.
Also report child_joined: true if the child appears in the chat log or exists as a child session, else false.

RULE: if outcome_class is not "completed", the run is NOT gradable. Do not score behavior on a killed, crashed, or artifact-less run: a run killed mid-work is NOT evidence that the agent "did not ask". For non-completed runs set gradable=false, expected_behavior_met=null, post_scores=[].

IF GRADABLE, score the run against the EXPECTED CHILD BEHAVIOR given in the input:
- question_quality (ask scenario): 0 = no question post, or the post is not a genuine question; 1 = a question the child could answer itself, or manufactured trivia not needed to proceed; 2 = a genuine peer-dependent question (the child needs main's input to proceed and cannot obtain it alone).
- answer_quality (answer scenario): 0 = the referenced question is not settled (no reply, or the reply does not answer it); 1 = settled partially or with material omission (e.g. a bare value where the question asked for identification); 2 = a direct, complete settlement. Score content only — database artifacts (e.g. a null to_name) are NOT quality defects.
- noise (noise scenario): the child had a fully self-contained task; correct behavior is zero chat posts. Count agent (non-system) posts; verdict pass = 0 posts, fail = any post, with the reason the agent posted.

Return STRICT JSON only, no prose, exactly this shape:
{"outcome_class":"completed|killed_at_cap|crashed|artifacts_missing|indeterminate","child_joined":true|false,"gradable":true|false,"ungradable_reason":string|null,"expected_behavior_met":true|false|null,"post_scores":[{"post_id":number,"axis":"question_quality|answer_quality","score":0|1|2,"note":string}],"noise":null|{"post_count":number,"verdict":"pass|fail","reason":string},"rationale":string}
```

Per-run user message (built by `judge.ts`): scenario key, setup (what the child was
actually given, from `smoke/run.ts` `EVAL_ASK`/`EVAL_ANSWER`/`EVAL_NOISE`), expected
child behavior, artifact availability, the full chat log (all rows, id order),
session metadata (titles, `idle_outcome`, wall-clock spans), and the last 4
transcript rows per session (type, agent, offset from session start, content kind,
200-char excerpt, state).

## Verdict schema

As per the JSON shape above. `expected_behavior_met` is judged against the
scenario's expected behavior: ask = child posted a genuine question about the
withheld value; answer = child posted an answer settling main's question;
noise = child posted nothing.
