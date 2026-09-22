# Encouraging agents to ask and answer — public-source research

Ticket #76 (wayfinder map: #75). Researched 2026-09-22 against primary sources (vendor
engineering posts, protocol specs, papers). Scope constraint: our delivery is **pull-based** —
a digest of unread messages rides the agent's *next* model request; nothing wakes an idle
agent. Techniques are evaluated under that constraint.

Context: the 0.5.0 prompt under improvement is `docs/chat-protocol.md`, injected as system
text at every model request of every agent, plus three one-line tool descriptions
(`chat_post`, `chat_read`, `chat_roster`). Baseline (20 real chats, 2026-09-22): 1,079
messages — 1,014 system, 31 status, 28 finding, 5 answer, 1 question.

---

## 1. Failure modes — why agents don't ask

**1.1 "Fail to ask for clarification" is a named, empirically-derived multi-agent failure
mode.** MAST (NeurIPS 2025), the first empirically grounded taxonomy of multi-agent LLM
failures (1,642 annotated traces across 7 MAS frameworks), lists 14 failure modes in 3
categories. FM-2.2 *Fail to ask for clarification* — "Inability to request additional
information when faced with unclear or incomplete data" — sits in the inter-agent
misalignment category, alongside FM-2.4 *Information withholding* and FM-2.5 *Ignored other
agent's input*. The paper's illustrative trace: a Phone agent fails to communicate API
requirements to a Supervisor agent, *who also fails to seek clarification*, producing
repeated failed logins and task failure. Notably, FM-2.4 and FM-1.5 (unaware of termination
conditions) "appear almost exclusively in failed runs" — they are fatal, not cosmetic.
<https://arxiv.org/abs/2503.13657>

**1.2 The assumption bias is baked into the training objective.** "Learning to Ask" (EMNLP
2025) built NoisyToolBench from real-world imperfect instructions and found: "due to the
next-token prediction training objective, LLMs tend to arbitrarily generate the missed
argument, which may lead to hallucinations and risks." Their fix (Ask-when-Needed) is
prompt-level: prompt the LLM to ask a question whenever it hits an obstacle caused by
unclear instruction. I.e., the default is to fill the gap, and asking must be induced.
<https://arxiv.org/abs/2409.00557>

**1.3 Overconfidence: models answer even when the prompt omits critical details or contains
false premises.** AskBench (Feb 2026) studies exactly "when and what to ask for
clarification"; its two settings are *AskMind* (intent-deficient queries that need
clarification) and *AskOverconfidence* (queries with false premises that must be identified
and corrected). Its conclusion that rubric-guided RLVR *teaches* models targeted
clarification implies the base behavior does not ask. <https://arxiv.org/abs/2602.11199>
ClarQ-LLM (benchmark for clarification in task-oriented dialog) found the best tested
seeker agent (Llama 3.1 405B) reached only ~60% success at gathering information through
clarifying questions — asking is a hard, frontier-level capability, not a default.
<https://arxiv.org/abs/2409.06097>

**1.4 Reward shape favors finishing over asking.** Direct measurements of completion-reward
shaping are thin (flagged as such), but the direction is triangulated by: (a) the
training-objective finding in 1.2 (fill-the-gap is the native objective); (b) OpenAI's GPT-5
prompting guide, which documents that at high `reasoning_effort` the model is "thorough and
comprehensive" in gathering context and — when pushed for autonomy — is steered with
"Never stop or hand back to the user when you encounter uncertainty — research or deduce the
most reasonable approach and continue. Do not ask the human to confirm or clarify
assumptions… document it for the user's reference after you finish acting." The vendor's own
default recommendation for autonomous operation is assume-and-continue.
<https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide>

**1.5 Host system-prompt dominance.** LLMs are trained with an explicit instruction
hierarchy: privileged (system/developer) instructions override lower-privileged text
(arXiv 2404.13208, OpenAI). Our protocol text is system text, but it shares that tier with
the host harness's system prompt, the user's AGENTS.md, and the model's base instructions.
Within the same tier there is no priority mechanism, so the harness's own behavioral norms
(e.g. "act when you have enough to act", "stop when the content stops") compete token-for-
token with the chat protocol. This is why protocol-level nudges can be over-dampened by
surrounding host text — and why the protocol must phrase its rules to *win* the
competition (see 2.1). <https://arxiv.org/abs/2404.13208>

**1.6 Anti-noise rules over-dampen — but the over-noise failure is real too.** Anthropic's
multi-agent research system hit the mirror-image failure in early versions: agents "distract
ing each other with excessive updates" (alongside spawning 50 subagents for simple queries).
Their production system therefore balances both sides with explicit effort rules. And the
context-engineering literature quantifies the cost of chat traffic: every token in context
depletes a finite "attention budget"; performance degrades as context grows ("context rot",
observed across all models). <https://www.anthropic.com/engineering/multi-agent-research-system>
<https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
Practical read: "silence is the default" is the correct prior, but it must be a *prior with
an explicit exception ladder*, not a blanket rule (2.1).

**1.7 Parallel agents with partial context make conflicting implicit decisions.** Cognition's
"Don't Build Multi-Agents" (June 2025): subagents that can't see each other's work "acted
based on conflicting assumptions not prescribed upfront"; its two principles are "share
context, and share full agent traces" and "actions carry implicit decisions". The chat
channel is precisely the surface where implicit assumptions get made explicit *before*
irreversible action. Note also their observation that Claude Code's subtask agents "are
usually only tasked with answering a question, not writing any code" — the subagent-as-
answerer pattern is an industry precedent for our question/answer kinds.
<https://cognition.ai/blog/dont-build-multi-agents>

---

## 2. Techniques

All techniques below are things published systems actually do; each is tagged with the
constraint it most helps under pull-based delivery.

**2.1 Rule wording: affirmative rules with an explicit threshold ladder, plus the "why".**
- Write the *positive* behavior, not the negative ("Tell Claude what to do instead of what
  not to do"); explain *why* a rule exists — "Claude is smart enough to generalize from the
  explanation"; and test rules with the "colleague with minimal context" golden rule.
  <https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices>
- Set **per-channel uncertainty thresholds**: OpenAI's GPT-5 guide recommends stating stop
  conditions and "when, if ever, it's acceptable for the model to hand back to the user",
  calibrated per channel — e.g. checkout/payment tools get a low threshold for requiring
  clarification, search tools an extremely high one. Translated to us: *answer* and *question*
  posts carry a low "ask threshold" (cheap, reversible, unblocks a peer); *status* a high
  one. <https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide>
- Keep system prompts at the "right altitude": specific enough to guide behavior, flexible
  enough to be heuristics — avoid both brittle if-else hardcoding and vague high-level
  guidance; aim for "the smallest possible set of high-signal tokens".
  <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
- Ask **when needed**, not up front and not at the end: the AwN framework asks at the moment
  an obstacle is hit <https://arxiv.org/abs/2409.00557> — which under pull-based delivery is
  exactly the right moment, since the question then rides the asker's next request and the
  answer the answerer's next request.

**2.2 Worked examples inside system text.** The strongest cross-vendor agreement in the
whole literature: examples are the most reliable steering mechanism. Claude's prompting
docs: "one of the most reliable ways to steer Claude's output format, tone, and structure…
3–5 examples… wrap in `<example>` tags." Gemini's prompting guide: "We recommend to always
include few-shot examples in your prompts. Prompts without few-shot examples are likely to
be less effective. In fact, you can remove instructions from your prompt if your examples
are clear enough." Anthropic's context engineering: curate "a set of diverse, canonical
examples" (not a laundry list of edge cases); "for an LLM, examples are the 'pictures'
worth a thousand words." Applied: the protocol should carry 1–2 minimal transcript-style
examples of a good `question` post (single question, names the peer, states what the asker
does while waiting) and a good `answer` post (replying to the question id, settling it).
<https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices>
<https://ai.google.dev/gemini-api/docs/prompting-strategies>
<https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>

**2.3 Role and ownership clarity.** Claude docs: "Setting a role in the system prompt
focuses Claude's behavior and tone… Even a single sentence makes a difference." Anthropic's
multi-agent system: every subagent task must carry "an objective, an output format, guidance
on the tools and sources to use, and clear task boundaries" — short instructions produced
duplicate work and gaps. MAST's FM-1.2 (*Disobey role specification*) shows the cost of
ambiguous roles, and its intervention case study shows the fix works: giving the ChatDev CEO
agent explicit final-say authority raised task success by +9.4%. Applied: every open
question should have a **named owner** (the `to` target, defaulting to `main` when no peer
is live) so it can never be silently unowned — the closest chat analog to A2A's
`input-required` state (3.3).
<https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices>
<https://www.anthropic.com/engineering/multi-agent-research-system>
<https://arxiv.org/abs/2503.13657>

**2.4 Escalation ladders.** Public research on inter-agent escalation ladders is thin —
this is assembled from three sources. (a) GPT-5 guide's threshold pattern above, plus its
"Escalate once: if signals conflict or scope is fuzzy, run one refined parallel batch, then
proceed" — a bounded retry-then-ask ladder rather than unbounded self-deliberation.
(b) OpenAI's Agents SDK models escalation as a *first-class tool* to an "Escalation agent"
with a typed `input_type` (e.g. `reason`) — escalation is an action with a structured
payload, not a vibe. (c) ChatDev/CAMEL's multi-turn structure: a subtask is a bounded
orchestrator–assistant dialogue terminated by an explicit sentinel (task completion is
"marked by a specific sentinel by either agent") — bounded turns with explicit exit
signals. <https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide>
<https://openai.github.io/openai-agents-python/handoffs/>
<https://arxiv.org/abs/2503.13657> (Appendix B, ChatDev description)

**2.5 Making the ask channel cheap.** Tool description quality *is* the channel's
usability. Anthropic's tool-design work: tools are "a contract between deterministic
systems and non-deterministic agents"; they prompt-engineer tool descriptions and specs as
first-class artifacts, and found a tool-testing agent rewriting one tool's description cut
task completion time 40% for downstream agents. Their multi-agent post: "Bad tool
descriptions can send agents down completely wrong paths, so each tool needs a distinct
purpose and a clear description." A2A makes the same point at protocol level: light-weight
stateless `Message` exchanges are for "the lightweight back-and-forth that establishes what
should be done" before committing to a tracked `Task` — asking is cheap, *committing* is
not. Applied: our three one-line descriptions are the entire surface area of the ask
channel; the `chat_post` description should say *when* to post (the exception ladder)
instead of only *how*. <https://www.anthropic.com/engineering/writing-tools-for-agents>
<https://www.anthropic.com/engineering/multi-agent-research-system>
<https://a2a-protocol.org/latest/topics/life-of-a-task/>

**2.6 Salience of open-question queues; making unanswered questions visible.** Two
independent findings converge. (a) Position effects: "performance is often highest when
relevant information occurs at the beginning or end of the input context, and significantly
degrades when models must access relevant information in the middle of long contexts, even
for explicitly long-context models" (Lost in the Middle, TACL). Claude's docs repeat the
pattern with a measured effect: placing the query at the end "can improve response quality
by up to 30 percent". (b) Question-as-state: A2A's task lifecycle has a first-class
`input-required` interrupt state — when the serving agent is "best placed to resolve
ambiguity or spot missing information", it "returns an `input-required` state to ask the
client for clarification"; the question is visible, owned, and blocks task completion until
answered. MAST's FM-2.4/FM-2.5 show what absence of this looks like: withheld information
and ignored input are among the fatal failure modes. Applied: render the open-question
queue as a **labeled, counted block at the end of the injected digest** (question id,
asker, addressee, age), not as prose buried in a message list.
<https://arxiv.org/abs/2307.03172>
<https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices>
<https://a2a-protocol.org/latest/topics/life-of-a-task/>
<https://arxiv.org/abs/2503.13657>

**2.7 Turn and timing design.** (a) GPT-5 guide: "peak performance when distinct,
separable tasks are broken up across multiple agent turns, with one turn for each task" —
question and answer belong to *separate turns*, which matches pull-based delivery exactly.
(b) Progress narration: GPT-5's "tool preamble" pattern — brief narrated updates before tool
calls — and OpenAI's note that "the longer the rollout, the bigger the difference these
updates make" supports `status` posts at *phase boundaries*, not per action. (c) CAMEL/
ChatDev's sentinel-terminated dialogues: completion is a signal, not an assumption —
relevant to how a question is *closed* (an `answer` post, not a fade). (d) Anthropic:
extended/interleaved thinking as "a controllable scratchpad" before acting; "start wide,
then narrow down" — the ask decision should come out of an explicit planning step, not
mid-action. <https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide>
<https://arxiv.org/abs/2303.17760> <https://arxiv.org/abs/2307.07924>
<https://www.anthropic.com/engineering/multi-agent-research-system>

---

## 3. Multi-agent specifics — what published systems do

**3.1 Anthropic's multi-agent research system (production, orchestrator–worker).** Lead
agent plans, spawns parallel subagents, synthesizes. Key facts: multi-agent (Opus 4 lead +
Sonnet 4 subagents) beat single-agent Opus 4 by 90.2% on their internal research eval;
token usage explains 80% of variance in the BrowseComp eval; multi-agent systems burn ~15×
chat tokens. Prompting principles (verbatim themes): "think like your agents"; "teach the
orchestrator how to delegate" (objective + output format + tool guidance + task boundaries
per subagent); "scale effort to query complexity" (explicit effort budgets in the prompt —
"agents struggle to judge appropriate effort"); "tool design and selection are critical";
"let agents improve themselves" (an agent rewrites flawed tool descriptions); "start wide,
then narrow down"; "guide the thinking process"; parallel tool calling (cut research time
up to 90%). Production finding directly relevant to us: "the lead agent can't steer
subagents, subagents can't coordinate, and the entire system can be blocked while waiting
for a single subagent" — synchronous orchestration is their bottleneck; asynchronous
coordination is where they expect gains. Evaluation practice: start evaluating immediately
with ~20 real queries; a **single** LLM-judge call with a 0.0–1.0 rubric score + pass/fail
was the most consistent; human testing catches what evals miss (they found agents
systematically preferring SEO content farms). <https://www.anthropic.com/engineering/multi-agent-research-system>

**3.2 Cognition (Devin): full-trace sharing; subagents as question-answering units.**
Principle 1 "share context, and share full agent traces, not just individual messages";
Principle 2 "actions carry implicit decisions, and conflicting decisions carry bad results".
They argue architectures that violate these are "rarely worth" using; their recommended
remedy for context overflow is a dedicated compression model (fine-tuned, in their case).
Their concrete precedent: Claude Code spawns subtask agents that "never does work in
parallel with the subtask agent, and the subtask agent is usually only tasked with
answering a question, not writing any code. Why? The subtask agent lacks context from the
main agent." Question-answering across the context boundary is the safe multi-agent
operation. <https://cognition.ai/blog/dont-build-multi-agents>

**3.3 A2A protocol (Google-led, now Linux Foundation): asking as protocol state.**
The task lifecycle is the reference design for unanswered-question handling: a task moves
`submitted → working` and can enter **interrupted states** — `input-required` (asks the
client for input) or `auth-required` — before terminal states (`completed`, `canceled`,
`rejected`, `failed`). An ambiguous request does not fail or guess: the agent *states* it
needs input, and the state is visible to the client until answered. Supporting machinery:
stateless `Message` for lightweight negotiation vs stateful `Task` for committed work;
`contextId` as the shared conversation scope; task immutability (a completed task can't be
restarted — follow-ups are new tasks in the same context). Our chat cannot (structurally)
pause a peer's request, but the design lesson transfers: model an unanswered question as
**visible state with an owner**, not as a message that might be missed.
<https://a2a-protocol.org/latest/topics/life-of-a-task/> <https://a2a-protocol.org/latest/specification/>

**3.4 OpenAI Agents SDK: handoffs and escalation as typed tools.** Handoffs are represented
as tools (`transfer_to_<agent>`); each carries a `handoff_description` that "hint[s] when
the model should pick that handoff without writing a full handoff() object" — i.e., the
*description* is the scheduling mechanism. `input_type` lets the handing-off model supply
typed metadata (e.g. `{reason, priority}`) at handoff time; `input_filter` controls what
history the receiving agent sees. Escalation is just a handoff to an escalation agent with
a `reason` field. <https://openai.github.io/openai-agents-python/handoffs/>

**3.5 ChatDev / CAMEL: chat as the coordination substrate, with structured questioning.**
ChatDev (ACL 2024) is the closest published analog to our system — a virtual software
company (CEO/CTO/Programmer/Reviewer/Tester) where every subtask is a multi-turn chat
between an orchestrator and an assistant, guided by two mechanisms: **chat chain** ("what
to communicate": role-specific chat scripts) and **communicative dehallucination** ("how to
communicate": the assistant is "encouraged to seek further details about the task over
multiple-turns, instead of responding immediately" — that definition is from MAST's
Appendix B, which also gives the sentinel-terminated dialogue structure). CAMEL (NeurIPS
2023) is the parent framework (inception-prompted role-playing pairs) from which
communicative dehallucination originates. The lesson: *script the who-asks-whom-when*,
don't leave questioning to model initiative alone. <https://arxiv.org/abs/2307.07924>
<https://arxiv.org/abs/2303.17760> <https://arxiv.org/abs/2503.13657>

**3.6 MetaGPT and AppWorld: SOPs and centralized-clarification.** MetaGPT encodes
"Standard Operating Procedures of different roles into agents' prompts" (per MAST's
Appendix B); MAST's architecture comparison found SOP-driven MetaGPT produced significantly
fewer spec/role-disobedience failures than ChatDev, at the cost of more verification
failures — i.e., scripted process reliably suppresses FM-1.x failures. The MAST authors'
AppWorld multi-agent variant instructs each service agent that user credentials "must be
clarified with the supervisor agent" — centralizing in one agent the information others
cannot self-derive, and explicitly instructing them to ask it. Applied: name in the
protocol *which* kinds of questions route to which owner (e.g. task-scope questions →
`main`, factual questions from the agent that ran the experiment → that agent).
<https://arxiv.org/abs/2503.13657> <https://arxiv.org/abs/2308.00367>

**3.7 MAST as an evaluation instrument.** Beyond the taxonomy, the paper ships an
LLM-as-judge annotation pipeline (`pip install agentdash`, calibrated to κ≈0.77–0.88 with
human experts) that classifies any MAS conversation trace against the 14 modes — directly
reusable for scoring our chat traces (see 4). <https://arxiv.org/abs/2503.13657>

---

## 4. Per-model caveats — where techniques diverge by model family

The 0.5.0 prompt must stay model-agnostic; the caveats below say *what to validate per
model* and *which wording choices are fragile across models*.

**4.1 Vendor guidance is explicitly per-model, and behavior differs even within a family
across versions.** Claude's prompting docs open with a "Model-specific guidance" section —
one page per model — covering "response length and verbosity, user-facing progress updates,
written deliverable length, task scope and over-verification, subagent control, and
self-correction" (Opus 5); "effort levels, finishing long tasks, user-facing progress
updates, … search triggering at low effort" (Fable 5.1); "literal instruction following,
tool use triggering" (Sonnet 5 / Opus 4.8). Concrete divergences: "Claude Opus 5… default
user-facing responses run longer than prior models', and raising or lowering effort does not
reliably change visible response length"; "Claude Fable 5.1… writes fewer user-facing
updates between tool calls. Ask for progress text explicitly." Their instruction: "Where a
technique names a specific model, treat it as measured on that model and re-check it
against your own evals before applying it to another." Implication: progress-posting
frequency (our `status` kind) and verbosity are *model properties*, not protocol
properties — the protocol should request them explicitly and the eval must measure per
model. <https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices>

**4.2 The ask/assume dial is exposed differently per vendor.** GPT-5: a
`reasoning_effort` parameter plus explicit prompt clauses in both directions (assume-and-
continue vs update-and-ask); OpenAI also reports measurable API-level effects (Responses
API with persisted reasoning lifted Tau-Bench Retail from 73.9% to 78.2%) — some levers are
infrastructural, not textual. Claude: effort parameters + explicit progress-text requests;
Gemini: structured behavior steered via API features (structured output) rather than prompt
text, with few-shot examples strongly recommended. A protocol text that *works by
counteracting a model's default* (e.g. "post status more often" against a terse model)
will have opposite effects on a verbose model — phrase rules as *thresholds* ("post X when
condition C holds"), not as *intensities* ("post more X"), which are model-agnostic in
effect. <https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide>
<https://ai.google.dev/gemini-api/docs/prompting-strategies>
<https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices>

**4.3 Measured cross-family failure-profile differences.** MAST's model comparison
(GPT-4o vs Claude 3.7 Sonnet on MetaGPT): "GPT-4o exhibits substantially fewer failures in
FC1 (System Design Issues) and FC2 (Inter-Agent Misalignment)… compared to Claude 3.7
Sonnet. This suggests GPT-4o may possess stronger capabilities in instruction following or
aspects of 'social reasoning' for agentic collaboration. However, both models show a high
number of failures in FC3 (Task Verification)." So the *share* of inter-agent
communication failures (our exact domain: FC2) differs by model family, while verification
failures don't — expect the ask/answer behavior to differ across the families our sessions
actually run, and measure it. <https://arxiv.org/abs/2503.13657>

**4.4 Long-context position effects hold across models but with "more gentle degradation
than others" — i.e., the *shape* of the effect is universal, the *amount* is per-model**
(context rot "emerges across all models"; Lost in the Middle observed "even for explicitly
long-context models"). The digest-placement recommendation (open-question queue at the
end) is therefore safe to apply model-agnostically.
<https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
<https://arxiv.org/abs/2307.03172>

---

## 5. Implications for our protocol, digest, and evaluation

**For the protocol text (`docs/chat-protocol.md`):**
1. Replace the flat "Silence is the default" with an exception ladder: keep silence as the
   prior, but state the low-threshold cases explicitly — a question you cannot answer from
   your own tools/context, a blocker, and an *answer to a question the digest shows you can
   answer*. Thresholds, not intensities (2.1, 4.2).
2. Add 1–2 worked transcript examples of a good `question` and a good `answer` post
   (2.2) — the single most cross-validated lever found.
3. Add the *why* to the ask rule: peers act on implicit assumptions in parallel; a missed
   question becomes a conflicting decision (Cognition 3.2; MAST FM-2.2) (2.1).
4. Make answering an obligation with an owner default: every question names an owner
   (`to`, else `main`); a peer who can answer from their own work answers **before their
   next substantive action** (2.3, 2.7c; MAST FM-2.4/FM-2.5).
5. State ask timing as AwN-style "ask when needed": at the moment the obstacle is hit, with
   "what I will do while I wait" in the same post (already present — keep; 1.2, 2.1, 2.7).
6. Keep the three one-line tool descriptions as the ask channel's surface area: the
   `chat_post` description should encode the *when* (thresholds), not just the *how*
   (2.5).

**For the digest/briefing rendering:**
7. Render open questions as a labeled, counted block with id/asker/addressee/age —
   question-as-state, the chat analog of A2A `input-required` (2.6, 3.3).
8. Place that block at the **end** of the injected digest (recency; up to 30% measured
   gain; lost-in-the-middle) (2.6).
9. Keep the digest minimal — unread + open questions only; every token competes for a finite
   attention budget (1.6, 2.6).

**For the evaluation design:**
10. Start immediately with ~20 realistic task sessions; single LLM-judge call with a
    rubric (0.0–1.0 + pass/fail); human spot-check for edge cases (Anthropic 3.1).
11. Core metrics: *ask rate* on ground-truth-ambiguous situations, *answer latency* (turns
    from question to answer), and *noise rate* (posts that changed nothing — guard against
    over-correction; Anthropic's "excessive updates" failure) (1.6, 3.1).
12. Trace-level failure labels via MAST's 14 modes (esp. FM-2.2, FM-2.4, FM-2.5, FM-3.1)
    using its open-source LLM-annotator pipeline — free instrumentation with published
    reliability numbers (1.1, 3.7).
13. Interactive answer-side test: a ClarQ-style provider agent that holds information the
    asker needs, so "asking" can be scored end-to-end (1.3).
14. Validate per model family (GPT vs Claude vs Gemini at least) because FC2 failure
    shares and verbosity defaults differ measurably (4.1–4.3).

**Thin areas (no padding):** inter-agent *escalation ladders* and *open-question-queue
salience* are largely assembled by analogy from human-facing escalation patterns, A2A
state design, and long-context position effects — no public experiment directly measures
queue placement in multi-agent chat. And *reward shape favoring finishing over asking* is
argued from training-objective and RLVR evidence, not a direct measurement.

---

## Source list

| Source | Type | URL |
|---|---|---|
| Cemri et al., "Why Do Multi-Agent LLM Systems Fail?" (MAST), NeurIPS 2025 | paper | https://arxiv.org/abs/2503.13657 |
| Wang et al., "Learning to Ask: When LLM Agents Meet Unclear Instruction" (AwN/NoisyToolBench), EMNLP 2025 | paper | https://arxiv.org/abs/2409.00557 |
| Zhao et al., "When and What to Ask: AskBench and Rubric-Guided RLVR for LLM Clarification", 2026 | paper | https://arxiv.org/abs/2602.11199 |
| Gan et al., "ClarQ-LLM: A Benchmark for Models Clarifying and Requesting Information" | paper | https://arxiv.org/abs/2409.06097 |
| Wallace et al. (OpenAI), "The Instruction Hierarchy" | paper | https://arxiv.org/abs/2404.13208 |
| Liu et al., "Lost in the Middle: How Language Models Use Long Contexts", TACL | paper | https://arxiv.org/abs/2307.03172 |
| Li et al., "CAMEL: Communicative Agents for Mind Exploration of LLM Society", NeurIPS 2023 | paper | https://arxiv.org/abs/2303.17760 |
| Qian et al., "ChatDev: Communicative Agents for Software Development", ACL 2024 | paper | https://arxiv.org/abs/2307.07924 |
| Hong et al., "MetaGPT" (referenced via MAST Appendix B) | paper | https://arxiv.org/abs/2308.00367 |
| Anthropic, "How we built our multi-agent research system" (2025) | engineering post | https://www.anthropic.com/engineering/multi-agent-research-system |
| Anthropic, "Effective context engineering for AI agents" (2025) | engineering post | https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents |
| Anthropic, "Writing effective tools for AI agents" | engineering post | https://www.anthropic.com/engineering/writing-tools-for-agents |
| Anthropic, "Prompting best practices" (Claude platform docs) | vendor docs | https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices |
| OpenAI, "GPT-5 prompting guide" | vendor docs | https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide |
| OpenAI Agents SDK docs, "Handoffs" | vendor docs | https://openai.github.io/openai-agents-python/handoffs/ |
| Google, "Prompt design strategies" (Gemini API docs) | vendor docs | https://ai.google.dev/gemini-api/docs/prompting-strategies |

Note: OpenAI's "A practical guide to building agents" PDF was reachable but not text-
extractable during this research pass; no claims in this document rely on it.
| A2A Protocol, "Life of a Task" + specification | protocol spec | https://a2a-protocol.org/latest/topics/life-of-a-task/ |
| Cognition, "Don't Build Multi-Agents" (2025) | engineering post | https://cognition.ai/blog/dont-build-multi-agents |
