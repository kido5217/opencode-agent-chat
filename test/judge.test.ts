import { describe, expect, test } from "bun:test";
import {
  buildUserPrompt,
  JUDGE_MODEL,
  judgeAggregateLine,
  localVerdict,
  type JudgeRunInput,
  type JudgeRunResult,
} from "../smoke/judge.ts";
import { CHAT_TIMEOUT_S } from "../smoke/harness.ts";

describe("localVerdict (the load-bearing rule)", () => {
  for (const outcome of ["killed_at_cap", "crashed"] as const) {
    test(`a ${outcome} run is not gradable and scores nothing`, () => {
      const v = localVerdict(outcome, true);
      expect(v.outcome_class).toBe(outcome);
      expect(v.gradable).toBe(false);
      expect(v.expected_behavior_met).toBeNull();
      expect(v.post_scores).toEqual([]);
      expect(v.noise).toBeNull();
      expect(v.ungradable_reason).toContain(outcome);
    });
  }
  test("child_joined is carried through", () => {
    expect(localVerdict("crashed", true).child_joined).toBe(true);
    expect(localVerdict("killed_at_cap", false).child_joined).toBe(false);
  });
  test("the rationale is the silence-is-not-evidence sentence", () => {
    expect(localVerdict("killed_at_cap", true).rationale).toContain("not evidence");
    expect(localVerdict("crashed", false).rationale).toContain("not evidence");
  });
});

describe("buildUserPrompt", () => {
  const input: JudgeRunInput = {
    run: "ask-3",
    scenario: "ask",
    dir: "/tmp/eval/agent-chat-eval-new-ask-3-AbCdEf",
    harnessOutcome: "completed",
  };
  test("states the harness outcome as authoritative, with the cap", () => {
    const p = buildUserPrompt(input, { chats: true, opencode: true }, [{ id: 1 }], []);
    expect(p).toContain(`HARNESS OUTCOME (authoritative): completed (wall-clock cap ${CHAT_TIMEOUT_S}s)`);
  });
  test("embeds the scenario setup and expected behavior", () => {
    const p = buildUserPrompt(input, { chats: true, opencode: true }, [], []);
    expect(p).toContain("SETUP (what the child was actually given):");
    expect(p).toContain("EXPECTED CHILD BEHAVIOR:");
    expect(p).toContain("docs/staging.md");
  });
  test("renders the chat log rows and missing artifacts", () => {
    const messages = [
      { id: 1, sender_type: "system", sender_name: "system", kind: "system", to_name: null, in_reply_to: null, body: "probe-child-abcdefgh joined" },
      { id: 2, sender_type: "agent", sender_name: "probe-child-abcdefgh", kind: "question", to_name: "main", in_reply_to: null, body: "What is the codename?" },
    ];
    const p = buildUserPrompt(input, { chats: true, opencode: false }, messages, null);
    expect(p).toContain("[1] system/system kind=system");
    expect(p).toContain("[2] agent/probe-child-abcdefgh kind=question to=main");
    expect(p).toContain("opencode_db=MISSING");
  });
  test("every scenario key has setup and expected text", () => {
    for (const scenario of ["ask", "answer", "noise", "delegate"] as const) {
      const p = buildUserPrompt({ ...input, scenario }, { chats: false, opencode: false }, null, null);
      expect(p).toContain(`SCENARIO: ${scenario}`);
      expect(p).toContain("SETUP");
      expect(p).toContain("EXPECTED CHILD BEHAVIOR");
    }
  });
});

describe("judgeAggregateLine", () => {
  const mk = (partial: Partial<JudgeRunResult> & { run: string }): JudgeRunResult => ({
    scenario: "ask",
    dir: "/tmp",
    source: "judge",
    verdict: {
      outcome_class: "completed",
      child_joined: true,
      gradable: true,
      ungradable_reason: null,
      expected_behavior_met: true,
      post_scores: [],
      noise: null,
      rationale: "",
    },
    ...partial,
  });
  test("summarizes quality axes and flags judge failures", () => {
    const line = judgeAggregateLine({
      generated_at: "",
      judge_model: JUDGE_MODEL,
      endpoint: "",
      cap_s: CHAT_TIMEOUT_S,
      note: "",
      runs: [
        mk({
          run: "ask-0",
          verdict: {
            outcome_class: "completed",
            child_joined: true,
            gradable: true,
            ungradable_reason: null,
            expected_behavior_met: true,
            post_scores: [{ post_id: 2, axis: "question_quality", score: 2, note: "genuine" }],
            noise: null,
            rationale: "",
          },
        }),
        mk({
          run: "answer-0",
          verdict: {
            outcome_class: "completed",
            child_joined: true,
            gradable: true,
            ungradable_reason: null,
            expected_behavior_met: true,
            post_scores: [{ post_id: 3, axis: "answer_quality", score: 1, note: "partial" }],
            noise: null,
            rationale: "",
          },
        }),
        mk({
          run: "noise-0",
          verdict: {
            outcome_class: "completed",
            child_joined: true,
            gradable: true,
            ungradable_reason: null,
            expected_behavior_met: true,
            post_scores: [],
            noise: { post_count: 0, verdict: "pass", reason: "silent" },
            rationale: "",
          },
        }),
        mk({
          run: "ask-1",
          source: "local",
          verdict: {
            outcome_class: "killed_at_cap",
            child_joined: true,
            gradable: false,
            ungradable_reason: "harness outcome killed_at_cap",
            expected_behavior_met: null,
            post_scores: [],
            noise: null,
            rationale: "not gradable",
          },
        }),
        mk({ run: "ask-2", error: "HTTP 500" }),
      ],
    });
    expect(line).toContain("4/5 gradable");
    expect(line).toContain("question avg 2.00/1");
    expect(line).toContain("answer avg 1.00/1");
    expect(line).toContain("noise pass 1/1");
    expect(line).toContain("1 judge call(s) failed");
  });
  test("an all-non-completed eval still renders", () => {
    const line = judgeAggregateLine({
      generated_at: "",
      judge_model: JUDGE_MODEL,
      endpoint: "",
      cap_s: CHAT_TIMEOUT_S,
      note: "",
      runs: [
        mk({
          run: "ask-0",
          source: "local",
          verdict: {
            outcome_class: "crashed",
            child_joined: false,
            gradable: false,
            ungradable_reason: "harness outcome crashed",
            expected_behavior_met: null,
            post_scores: [],
            noise: null,
            rationale: "not gradable",
          },
        }),
      ],
    });
    expect(line).toContain("0/1 gradable");
    expect(line).toContain("n/a");
  });
});
