// The 0.6.0 eval's gate logic, kept pure so it is unit-testable without model runs
// (map #87, ticket #94; the locks are tickets #88/#90).
//
// Honest-counts rules (the #90 lock):
// - every run is classified from the harness's exit code — 0 = completed, 124 =
//   killed_at_cap (the CHAT_TIMEOUT_S cap), anything else = crashed;
// - behavior is asserted over the COMPLETED subset only: a run killed or crashed
//   mid-work is not evidence that the child "did not ask";
// - a floor of >= EVAL_COMPLETION_FLOOR completed runs per arm per scenario, else
//   the scenario is RED as a distinct data-quality failure (an infra/flakiness
//   signal, not a text verdict).

export type EvalOutcome = "completed" | "killed_at_cap" | "crashed";

export const EVAL_COMPLETION_FLOOR = 3;

export type EvalKey = "ask" | "answer" | "noise" | "delegate";
export type EvalArm = "baseline" | "new";

// The scenario set — one place, so the gate loop, the tests, and the harness
// scenario table cannot drift from the union.
export const EVAL_KEYS = ["ask", "answer", "noise", "delegate"] as const;

// The per-scenario metric that is displayed and asserted: ask and delegate
// both measure asking, answer measures answering, noise measures posting.
export const METRIC_BY_KEY: Record<EvalKey, "asked" | "answered" | "noised"> = {
  ask: "asked",
  answer: "answered",
  noise: "noised",
  delegate: "asked",
};

export interface EvalCounts {
  questions: number;
  answers: number;
}

export const zeroCounts = (): EvalCounts => ({ questions: 0, answers: 0 });

export interface EvalRate {
  runs: number;
  completed: number;
  killedAtCap: number;
  crashed: number;
  asked: number;
  answered: number;
  noised: number;
}

export const zeroRate = (): EvalRate => ({
  runs: 0,
  completed: 0,
  killedAtCap: 0,
  crashed: 0,
  asked: 0,
  answered: 0,
  noised: 0,
});

export interface EvalRates {
  baseline: Record<EvalKey, EvalRate>;
  new: Record<EvalKey, EvalRate>;
}

export const zeroRates = (): EvalRates => {
  const blank = (): Record<EvalKey, EvalRate> => {
    const out = {} as Record<EvalKey, EvalRate>;
    for (const key of EVAL_KEYS) out[key] = zeroRate();
    return out;
  };
  return { baseline: blank(), new: blank() };
};

export function classifyRunOutcome(exitCode: number): EvalOutcome {
  if (exitCode === 0) return "completed";
  if (exitCode === 124) return "killed_at_cap";
  return "crashed";
}

// Accumulate one run into a scenario's rate. The outcome class is always kept
// (the per-scenario breakdown); behavior counts apply to completed runs only.
export function recordRun(rate: EvalRate, outcome: EvalOutcome, counts: EvalCounts): void {
  rate.runs += 1;
  if (outcome === "killed_at_cap") rate.killedAtCap += 1;
  else if (outcome === "crashed") rate.crashed += 1;
  if (outcome !== "completed") return;
  rate.completed += 1;
  if (counts.questions >= 1) rate.asked += 1;
  if (counts.answers >= 1) rate.answered += 1;
  if (counts.questions + counts.answers >= 1) rate.noised += 1;
}

// The pass bars, as failure messages: an empty list is green. Data-quality (floor)
// failures come first; behavior bars are asserted over the completed subset.
export function gateFailures(rates: EvalRates, floor: number = EVAL_COMPLETION_FLOOR): string[] {
  const failures: string[] = [];
  for (const arm of ["baseline", "new"] as EvalArm[]) {
    for (const key of EVAL_KEYS) {
      const r = rates[arm][key];
      if (r.completed < floor) {
        failures.push(
          `data-quality RED (${arm} ${key}): only ${r.completed}/${r.runs} runs completed (floor ${floor}); ` +
            `re-run the eval — this is an infra/flakiness failure, not a text verdict`,
        );
      }
    }
  }
  const b = rates.baseline;
  const n = rates.new;
  const bar = (key: EvalKey, metric: "asked" | "answered", label: string): void => {
    if (n[key][metric] < 1 || n[key][metric] < b[key][metric]) {
      failures.push(
        `${label} not lifted: the new arm's child fired in ${n[key][metric]}/${n[key].completed} completed runs ` +
          `(baseline ${b[key][metric]}/${b[key].completed}); expected >= 1 and >= baseline over the completed subset`,
      );
    }
  };
  bar("ask", "asked", "ask");
  bar("answer", "answered", "answer");
  bar("delegate", "asked", "delegate");
  if (n.noise.noised > b.noise.noised) {
    failures.push(
      `noise guard broken: the new arm's child posted in ${n.noise.noised}/${n.noise.completed} completed runs ` +
        `vs ${b.noise.noised}/${b.noise.completed} baseline; the new text over-asks`,
    );
  }
  return failures;
}
