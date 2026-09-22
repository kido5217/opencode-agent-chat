import { describe, expect, test } from "bun:test";
import {
  classifyRunOutcome,
  EVAL_COMPLETION_FLOOR,
  EVAL_KEYS,
  gateFailures,
  recordRun,
  zeroCounts,
  zeroRate,
  zeroRates,
  type EvalRates,
  type EvalRate,
} from "../smoke/eval-gate.ts";

function makeRates(adjust: (r: EvalRates) => void): EvalRates {
  const rates = zeroRates();
  adjust(rates);
  return rates;
}

// Fill every arm/scenario deterministically: 5 runs, `completed` of them completed,
// `asked`/`answered` of the completed runs posting. noised stays 0 unless a test sets it.
function fillAll(rates: EvalRates, completed: number, asked: number, answered: number): void {
  for (const arm of ["baseline", "new"] as const) {
    for (const key of EVAL_KEYS) {
      const rate = rates[arm][key];
      rate.runs = 5;
      rate.completed = completed;
      rate.asked = Math.min(asked, completed);
      rate.answered = Math.min(answered, completed);
    }
  }
}

describe("classifyRunOutcome", () => {
  test("0 is completed", () => {
    expect(classifyRunOutcome(0)).toBe("completed");
  });
  test("124 is killed_at_cap (the timeout kill)", () => {
    expect(classifyRunOutcome(124)).toBe("killed_at_cap");
  });
  test("anything else is crashed", () => {
    expect(classifyRunOutcome(1)).toBe("crashed");
    expect(classifyRunOutcome(137)).toBe("crashed");
    expect(classifyRunOutcome(125)).toBe("crashed");
  });
});

describe("recordRun", () => {
  test("a completed run counts posts", () => {
    const rate = zeroRate();
    recordRun(rate, "completed", { questions: 1, answers: 0 });
    expect(rate).toEqual({ runs: 1, completed: 1, killedAtCap: 0, crashed: 0, asked: 1, answered: 0, noised: 1 });
  });
  test("a non-completed run counts nothing toward behavior, but keeps its outcome class", () => {
    const killed = zeroRate();
    recordRun(killed, "killed_at_cap", { questions: 1, answers: 1 });
    expect(killed).toEqual({ runs: 1, completed: 0, killedAtCap: 1, crashed: 0, asked: 0, answered: 0, noised: 0 });
    const crashed = zeroRate();
    recordRun(crashed, "crashed", { questions: 1, answers: 1 });
    expect(crashed).toEqual({ runs: 1, completed: 0, killedAtCap: 0, crashed: 1, asked: 0, answered: 0, noised: 0 });
  });
  test("a completed run with no posts is a silent run", () => {
    const rate = zeroRate();
    recordRun(rate, "completed", zeroCounts());
    expect(rate).toEqual({ runs: 1, completed: 1, killedAtCap: 0, crashed: 0, asked: 0, answered: 0, noised: 0 });
  });
});

describe("gateFailures", () => {
  test("a healthy run is green", () => {
    const rates = makeRates((r) => {
      fillAll(r, 5, 1, 1); // both arms ask+answer in 5/5 completed, no noise
    });
    expect(gateFailures(rates)).toEqual([]);
  });

  test("the floor is a distinct data-quality failure", () => {
    const rates = makeRates((r) => {
      fillAll(r, 5, 1, 1);
      r.new.ask.completed = 2; // only 2 of 5 completed
      r.new.ask.runs = 5;
    });
    const failures = gateFailures(rates);
    expect(failures.length).toBe(1);
    expect(failures[0]).toContain("data-quality RED (new ask)");
    expect(failures[0]).toContain("2/5");
    expect(failures[0]).toContain(String(EVAL_COMPLETION_FLOOR));
  });

  test("behavior bars assert over the completed subset", () => {
    // baseline lifted, new arm silent on completed runs -> ask + answer + delegate red
    const rates = makeRates((r) => {
      fillAll(r, 5, 0, 0);
      r.baseline.ask.asked = 3;
      r.baseline.answer.answered = 3;
      r.baseline.delegate.asked = 3;
    });
    const failures = gateFailures(rates);
    expect(failures.some((f) => f.startsWith("ask not lifted"))).toBe(true);
    expect(failures.some((f) => f.startsWith("answer not lifted"))).toBe(true);
    expect(failures.some((f) => f.startsWith("delegate not lifted"))).toBe(true);
    expect(failures.some((f) => f.startsWith("noise"))).toBe(false);
  });

  test("the new arm must lift to at least one and not below baseline", () => {
    const exactlyBaseline = makeRates((r) => {
      fillAll(r, 5, 2, 2);
      r.new.ask.asked = 2;
      r.baseline.ask.asked = 2;
      r.new.answer.answered = 2;
      r.baseline.answer.answered = 2;
      r.new.delegate.asked = 2;
      r.baseline.delegate.asked = 2;
    });
    expect(gateFailures(exactlyBaseline)).toEqual([]);
    const belowBaseline = makeRates((r) => {
      fillAll(r, 5, 3, 3);
      r.new.ask.asked = 1;
      r.baseline.ask.asked = 3;
    });
    expect(gateFailures(belowBaseline).some((f) => f.startsWith("ask not lifted"))).toBe(true);
  });

  test("zero completed runs on the new arm's ask scenario is red", () => {
    const rates = makeRates((r) => {
      fillAll(r, 5, 1, 1);
      Object.assign(r.new.ask, zeroRate()); // baseline dead-arm shape (defect A) on the NEW arm
    });
    const failures = gateFailures(rates);
    expect(failures.some((f) => f.startsWith("data-quality RED (new ask)"))).toBe(true);
    expect(failures.some((f) => f.startsWith("ask not lifted"))).toBe(true);
  });

  test("a noise post on the new arm above baseline is red", () => {
    const rates = makeRates((r) => {
      fillAll(r, 5, 1, 1);
      r.new.noise.noised = 2;
      r.baseline.noise.noised = 0;
    });
    expect(gateFailures(rates).some((f) => f.startsWith("noise guard broken"))).toBe(true);
  });

  test("the rate shape round-trips", () => {
    const rate: EvalRate = zeroRate();
    recordRun(rate, "completed", { questions: 1, answers: 1 });
    recordRun(rate, "killed_at_cap", { questions: 1, answers: 0 });
    recordRun(rate, "crashed", { questions: 0, answers: 1 });
    expect(rate).toEqual({ runs: 3, completed: 1, killedAtCap: 1, crashed: 1, asked: 1, answered: 1, noised: 1 });
  });
});
