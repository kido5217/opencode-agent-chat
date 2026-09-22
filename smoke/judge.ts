// 0.6.0 eval judge (advisory). Ported from the #89 prototype (branch
// prototype/089-eval-judge) with the #90 lock applied: the harness passes its own
// outcome class as the authoritative judge input, so non-completed runs are
// short-circuited locally — never scored, never sent to the model. Deterministic
// DB counts remain the eval's hard gate; this instrument reports quality only.
//
// Standalone usage: bun smoke/judge.ts [evalDir] [outPath]
//   evalDir default: the newest dir under $XDG_DATA_HOME/opencode/eval
//   outPath default: <evalDir>/judge-report.json

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { CHAT_TIMEOUT_S, evalArtifactsRoot, listEvalDirs } from "./harness.ts";
import type { EvalKey } from "./eval-gate.ts";

export const JUDGE_ENDPOINT = process.env.JUDGE_ENDPOINT ?? "https://ai.kido.ws/v1/chat/completions";
export const JUDGE_MODEL = process.env.JUDGE_MODEL ?? "Qwen3.8-27B";
const MAX_TOKENS = 4096;
const CALL_TIMEOUT_MS = 120_000;

// System prompt: the #89 rubric's quality axes, with run-outcome classification
// replaced by the harness's authoritative outcome (the #90 lock).
const SYSTEM = `You are an evaluation judge for a multi-agent chat system under test. A harness runs scripted scenarios; in each, a "main" agent launches a "child" agent (probe-child) and the measured behavior is the child's chat posts (question/answer) or its silence. You receive ONE completed run's artifacts: the scenario, its setup, the expected child behavior, the harness's outcome class (authoritative: the run COMPLETED), the full chat log, session metadata (with per-session wall-clock spans), and transcript tails.

The run completed per the harness. Verify this against the artifacts only to catch a harness misreport: if the artifacts clearly contradict completion (the child never started while main's turn is unfinished, or the transcript ends in an obvious abnormal state), say so in rationale and score expected_behavior_met accordingly. Otherwise score the run against the EXPECTED CHILD BEHAVIOR given in the input:
- question_quality (ask and delegate scenarios): 0 = no question post, or the post is not a genuine question; 1 = a question the child could answer itself, or manufactured trivia not needed to proceed; 2 = a genuine peer-dependent question (the child needs main's input to proceed and cannot obtain it alone).
- answer_quality (answer scenario): 0 = the referenced question is not settled (no reply, or the reply does not answer it); 1 = settled partially or with material omission (e.g. a bare value where the question asked for identification); 2 = a direct, complete settlement. Score content only — database artifacts (e.g. a null to_name) are NOT quality defects.
- noise (noise scenario): the child had a fully self-contained task; correct behavior is zero chat posts. Count agent (non-system) posts; verdict pass = 0 posts, fail = any post, with the reason the agent posted.

Also report child_joined: true if the child appears in the chat log or exists as a child session, else false.

Return STRICT JSON only, no prose, exactly this shape:
{"outcome_class":"completed","child_joined":true|false,"gradable":true,"ungradable_reason":null,"expected_behavior_met":true|false,"post_scores":[{"post_id":number,"axis":"question_quality|answer_quality","score":0|1|2,"note":string}],"noise":null|{"post_count":number,"verdict":"pass|fail","reason":string},"rationale":string}`;

// Scenario setup/expected text — verbatim semantics from smoke/run.ts EVAL_ASK /
// EVAL_ANSWER / EVAL_NOISE / EVAL_DELEGATE.
const SCENARIOS: Record<EvalKey, { axis: string; setup: string; expected: string }> = {
  ask: {
    axis: "question_quality",
    setup:
      'Main (probe-main) was told: the internal codename of the staging environment is "bluefin", and it must not put that value into any instruction given to the child. Main launched probe-child with description "label the config" and the task: "config.json in this project needs a \'stagingCodename\' field set to the internal codename of the staging environment. docs/staging.md says where staging configuration values come from; check it. When you are done, reply with exactly the value you set it to." The file docs/staging.md states that staging configuration values (including the codename) are internal and not recorded in the repository.',
    expected:
      "The codename exists ONLY in main's context — the child checked docs/staging.md and the repository, and cannot obtain it from its own prompt or the filesystem. Correct behavior: the child posts kind=question to main asking for the codename (a genuine peer-dependent question).",
  },
  answer: {
    axis: "answer_quality",
    setup:
      'Main first posted kind=question to probe-child with body "What is the internal codename of the staging environment?" (visible in the chat log). Main then launched probe-child with description "acknowledge" and the prompt: "For context, the internal codename of the staging environment is bluefin. Acknowledge that you have this context by replying with exactly: ACK"',
    expected:
      "The child holds the answer (bluefin) in its own prompt and main's open question is in the chat. Correct behavior: the child posts kind=answer settling the question (in_reply_to the question's post id).",
  },
  noise: {
    axis: "noise",
    setup:
      'Main launched probe-child with description "write a file" and the prompt: "Create hello.txt containing exactly the text: hi. When the file is written, reply with exactly: DONE"',
    expected:
      "The task is fully self-contained; nothing requires a peer. Correct behavior: zero chat posts.",
  },
  delegate: {
    axis: "question_quality",
    setup:
      'Main (probe-main) was told the staging environment\'s internal codename is "bluefin" and asked to delegate the config.json "stagingCodename" change to probe-child, composing the child\'s briefing itself (this scenario measures the task-design guidance: a well-briefed main withholds the main-owned codename; a briefing that inlines it lets the child complete silently). The child\'s actual prompt is visible in the child session\'s transcript (its first user row). docs/staging.md states that staging configuration values are internal and not recorded in the repository.',
    expected:
      "The codename exists ONLY in main's context. Correct behavior: the child's briefing withholds it, the child is blocked on the codename, and the child posts kind=question to main (a genuine peer-dependent question). If the briefing inlined the codename, the child completing silently is the expected (unlifted) outcome and expected_behavior_met=false.",
  },
};

export interface Verdict {
  outcome_class: string;
  child_joined: boolean;
  gradable: boolean;
  ungradable_reason: string | null;
  expected_behavior_met: boolean | null;
  post_scores: { post_id: number; axis: string; score: number; note: string }[];
  noise: { post_count: number; verdict: string; reason: string } | null;
  rationale: string;
}

// The ungradable verdict shape, shared by every non-gradable path: the core
// invariant (a non-gradable run is never scored) is structural, not per-call.
export function ungradableVerdict(
  outcomeClass: string,
  childJoined: boolean,
  reason: string,
  rationale: string,
): Verdict {
  return {
    outcome_class: outcomeClass,
    child_joined: childJoined,
    gradable: false,
    ungradable_reason: reason,
    expected_behavior_met: null,
    post_scores: [],
    noise: null,
    rationale,
  };
}

// The load-bearing rule, enforced deterministically: a run the harness did not
// complete is not gradable. A run killed mid-work is NOT evidence that the agent
// "did not ask". (The #88 defects C/D fix; the #89 core invariant, now structural.)
export function localVerdict(harnessOutcome: "killed_at_cap" | "crashed", childJoined: boolean): Verdict {
  return ungradableVerdict(
    harnessOutcome,
    childJoined,
    `harness outcome ${harnessOutcome} — a non-completed run is not gradable`,
    harnessOutcome === "killed_at_cap"
      ? "the harness wall-clock cap killed the run while it was still working; behavior on a killed run is not evidence of silence."
      : "the harness reports an abnormal termination; behavior on a crashed run is not evidence of silence.",
  );
}

export interface JudgeRunInput {
  run: string;
  scenario: EvalKey;
  dir: string;
  harnessOutcome: "completed" | "killed_at_cap" | "crashed";
}

export interface JudgeRunResult {
  run: string;
  scenario: EvalKey;
  dir: string;
  source: "judge" | "local";
  verdict: Verdict;
  raw?: string;
  error?: string;
}

export interface JudgeReport {
  generated_at: string;
  judge_model: string;
  endpoint: string;
  cap_s: number;
  note: string;
  runs: JudgeRunResult[];
}

function readMessages(chatsDir: string): Record<string, unknown>[] | null {
  if (!existsSync(chatsDir)) return null;
  for (const f of readdirSync(chatsDir)
    .filter((f) => f.endsWith(".db") && !f.includes("-wal") && !f.includes("-shm"))
    .sort()) {
    let db: Database;
    try {
      db = new Database(join(chatsDir, f), { readonly: true });
    } catch {
      continue;
    }
    const tables = (db.query("select name from sqlite_master where type='table'").all() as { name: string }[]).map(
      (t) => t.name,
    );
    if (!tables.includes("messages")) {
      db.close();
      continue;
    }
    const rows = db
      .query("select id, sender_type, sender_name, kind, to_name, in_reply_to, body from messages order by id")
      .all() as Record<string, unknown>[];
    db.close();
    return rows;
  }
  return null;
}

function readSessions(odbPath: string): {
  sessions: { sid: string; parent: string; title: string; idle_outcome: string | null; span_s: number | null; rows: string[] }[];
} | null {
  if (!existsSync(odbPath)) return null;
  let db: Database;
  try {
    db = new Database(odbPath, { readonly: true });
  } catch {
    return null;
  }
  const tables = (db.query("select name from sqlite_master where type='table'").all() as { name: string }[]).map(
    (t) => t.name,
  );
  const sessions = (
    db
      .query(
        "select substr(id,1,24) as sid, substr(coalesce(parent_id,''),1,24) as parent, substr(coalesce(title,''),1,60) as title, idle_outcome from session_v2 order by time_created",
      )
      .all() as Record<string, unknown>[]
  ).map((s) => ({
    sid: String(s.sid),
    parent: String(s.parent),
    title: String(s.title),
    idle_outcome: (s.idle_outcome as string) ?? null,
    span_s: null as number | null,
    rows: [] as string[],
  }));
  if (tables.includes("session_message")) {
    for (const s of sessions) {
      const sm = db
        .query("select seq, type, data, time_created from session_message where substr(session_id,1,24) = ? order by seq")
        .all(s.sid) as { seq: number; type: string; data: string; time_created: number }[];
      const firstRow = sm[0];
      if (firstRow !== undefined) {
        const first = firstRow.time_created;
        let last = first;
        for (const r of sm) {
          try {
            const d = JSON.parse(r.data) as { time?: { created?: number; streamed?: number; completed?: number } };
            const t = d.time?.completed ?? d.time?.streamed ?? d.time?.created;
            if (typeof t === "number" && t > last) last = t;
          } catch {
            /* keep going */
          }
        }
        s.span_s = Math.round((last - first) / 1000);
      }
      // tail: last 4 rows, structured; t offsets measured from the session's first row
      const tail = sm.slice(-4);
      const sessionStart = firstRow?.time_created ?? 0;
      for (const r of tail) {
        s.rows.push(formatSmRow(r.seq, r.type, r.data, sessionStart));
      }
    }
  }
  db.close();
  return { sessions };
}

function formatSmRow(seq: number, type: string, data: string, sessionStartMs: number): string {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(data);
  } catch {
    return `seq=${seq} ${type}: <unparseable data>`;
  }
  const time = d.time as { created?: number; streamed?: number; completed?: number } | undefined;
  const t = time?.completed ?? time?.streamed ?? time?.created ?? null;
  const tLabel = typeof t === "number" ? `t+${Math.round((t - sessionStartMs) / 1000)}s` : "";
  if (type === "user") return `seq=${seq} user ${tLabel}: ${String(d.text ?? "").slice(0, 200)}`;
  if (type === "idle") return `seq=${seq} idle ${tLabel}: outcome=${String(d.outcome ?? "?")}`;
  if (type === "agent-switched") {
    return `seq=${seq} agent-switched ${tLabel}: agent=${String(d.agent ?? "?")} prev=${String(d.previous ?? "?")}`;
  }
  // assistant
  const agent = String(d.agent ?? "?");
  const content = (d.content as Record<string, unknown>[] | undefined) ?? [];
  const parts = content.slice(0, 3).map((c) => {
    const kind = String(c.type ?? "?");
    const text = typeof c.text === "string" ? c.text : JSON.stringify(c).slice(0, 120);
    const state = c.state as { status?: string; outcome?: string } | undefined;
    const st = state?.status ?? state?.outcome ?? null;
    return `${kind}${st ? ` state=${st}` : ""} "${text.slice(0, 200)}"`;
  });
  return `seq=${seq} assistant/${agent} ${tLabel}: ${parts.join(" | ")}`;
}

export function buildUserPrompt(
  input: JudgeRunInput,
  artifacts: { chats: boolean; opencode: boolean },
  messages: Record<string, unknown>[] | null,
  sessions: { sid: string; parent: string; title: string; idle_outcome: string | null; span_s: number | null; rows: string[] }[] | null,
): string {
  const sc = SCENARIOS[input.scenario];
  const lines: string[] = [];
  lines.push(`RUN: ${input.run}`);
  lines.push(`SCENARIO: ${input.scenario}`);
  lines.push(`SETUP (what the child was actually given): ${sc.setup}`);
  lines.push(`EXPECTED CHILD BEHAVIOR: ${sc.expected}`);
  lines.push(`HARNESS OUTCOME (authoritative): completed (wall-clock cap ${CHAT_TIMEOUT_S}s)`);
  lines.push(`ARTIFACTS: chats_db=${artifacts.chats ? "present" : "MISSING"}, opencode_db=${artifacts.opencode ? "present" : "MISSING"}`);
  lines.push("");
  lines.push("CHAT LOG (all rows, id order):");
  if (!messages) lines.push("  (missing)");
  else
    for (const m of messages)
      lines.push(
        `  [${String(m.id)}] ${String(m.sender_type)}/${String(m.sender_name)} kind=${String(m.kind)} to=${String(m.to_name ?? "null")} reply_to=${String(m.in_reply_to ?? "null")}: ${String(m.body)}`,
      );
  lines.push("");
  lines.push("SESSIONS (wall-clock span = last message timestamp minus first, seconds):");
  if (!sessions) lines.push("  (missing)");
  else
    for (const s of sessions) {
      lines.push(
        `  ${s.sid}${s.parent ? ` (parent=${s.parent})` : " (main)"}: title="${s.title}" idle_outcome=${s.idle_outcome ?? "null"} span=${s.span_s ?? "?"}s`,
      );
      for (const r of s.rows) lines.push(`    ${r}`);
    }
  return lines.join("\n");
}

async function callJudge(userPrompt: string): Promise<{ verdict: Verdict; raw: string }> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
    try {
      const res = await fetch(JUDGE_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: JUDGE_MODEL,
          temperature: 0,
          max_tokens: MAX_TOKENS,
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: userPrompt },
          ],
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = j.choices?.[0]?.message?.content ?? "";
      const m = content.match(/\{[\s\S]*\}/);
      if (m === null) throw new Error(`no JSON in judge content: ${content.slice(0, 200)}`);
      const verdict = JSON.parse(m[0]) as Verdict;
      return { verdict, raw: content };
    } catch (e) {
      lastErr = e;
      if (attempt === 2) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new Error("unreachable");
}

// Score one run. Non-completed runs short-circuit locally (no model call);
// completed runs go to the judge. A per-run failure is recorded, never thrown:
// the judge is advisory and must not fail the eval.
export async function scoreRun(input: JudgeRunInput): Promise<JudgeRunResult> {
  const messages = readMessages(join(input.dir, "chats"));
  const sess = readSessions(join(input.dir, "data", "opencode", "opencode.db"));
  const childJoined =
    (messages !== null &&
      messages.some(
        (m) => m.sender_type === "system" && String(m.body).includes("joined") && String(m.body).includes("probe-child"),
      )) ||
    (sess !== null && sess.sessions.some((s) => s.sid.startsWith("ses_") && s.parent !== ""));
  if (input.harnessOutcome !== "completed") {
    return {
      run: input.run,
      scenario: input.scenario,
      dir: input.dir,
      source: "local",
      verdict: localVerdict(input.harnessOutcome, childJoined),
    };
  }
  const artifacts = { chats: messages !== null, opencode: sess !== null };
  if (!artifacts.chats && !artifacts.opencode) {
    // Deterministic short-circuit: a completed run with no artifacts is a harness
    // misreport — ungradable, and it shows up in the report as such.
    return {
      run: input.run,
      scenario: input.scenario,
      dir: input.dir,
      source: "local",
      verdict: ungradableVerdict(
        "completed",
        false,
        "harness reports completion but the run left no usable artifacts",
        "no artifacts to score.",
      ),
    };
  }
  const prompt = buildUserPrompt(input, artifacts, messages, sess?.sessions ?? null);
  try {
    const { verdict, raw } = await callJudge(prompt);
    return { run: input.run, scenario: input.scenario, dir: input.dir, source: "judge", verdict, raw };
  } catch (e) {
    return {
      run: input.run,
      scenario: input.scenario,
      dir: input.dir,
      source: "judge",
      verdict: ungradableVerdict("completed", childJoined, "judge call failed", String(e).slice(0, 300)),
      error: String(e).slice(0, 300),
    };
  }
}

// Score every run sequentially; never throws (the gate is deterministic counts).
export async function runJudge(runs: JudgeRunInput[]): Promise<JudgeReport> {
  const results: JudgeRunResult[] = [];
  for (const input of runs) {
    const result = await scoreRun(input);
    results.push(result);
    const v = result.verdict;
    const grade =
      result.error !== undefined
        ? `ERROR ${result.error.slice(0, 60)}`
        : v.noise !== null
          ? `noise=${v.noise.verdict}(${v.noise.post_count})`
          : v.post_scores.map((p) => `${p.axis}=${p.score}`).join(",");
    console.log(
      `[judge:${result.source}] ${input.run.padEnd(14)} ${v.outcome_class.padEnd(16)} gradable=${String(v.gradable).padEnd(5)} ${grade}`,
    );
  }
  return {
    generated_at: new Date().toISOString(),
    judge_model: JUDGE_MODEL,
    endpoint: JUDGE_ENDPOINT,
    cap_s: CHAT_TIMEOUT_S,
    note: "advisory only — deterministic DB counts remain the eval's hard gate (map #87, tickets #89/#90)",
    runs: results,
  };
}

// Aggregate one line for the eval's console output.
export function judgeAggregateLine(report: JudgeReport): string {
  const gradable = report.runs.filter((r) => r.verdict.gradable);
  const qScores = gradable.flatMap((r) => r.verdict.post_scores.filter((p) => p.axis === "question_quality"));
  const aScores = gradable.flatMap((r) => r.verdict.post_scores.filter((p) => p.axis === "answer_quality"));
  const noise = gradable.map((r) => r.verdict.noise).filter((n) => n !== null);
  const avg = (xs: number[]): string =>
    xs.length === 0 ? "n/a" : (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2);
  const failed = report.runs.filter((r) => r.error !== undefined).length;
  return (
    `judge (${report.judge_model}, advisory; ${gradable.length}/${report.runs.length} gradable` +
    `) — question avg ${avg(qScores.map((p) => p.score))}/${qScores.length} scored, ` +
    `answer avg ${avg(aScores.map((p) => p.score))}/${aScores.length} scored, ` +
    `noise pass ${noise.filter((n) => n !== null && n.verdict === "pass").length}/${noise.length} scored` +
    (failed > 0 ? `, ${failed} judge call(s) failed` : "")
  );
}

// Standalone mode: score a retained eval dir (e.g. after re-reading its artifacts).
async function main(): Promise<void> {
  const root = evalArtifactsRoot();
  let evalDir = process.argv[2];
  if (evalDir === undefined) {
    const dirs = listEvalDirs(root);
    if (dirs.length === 0) throw new Error(`no eval dirs under ${root}`);
    evalDir = join(root, dirs.sort().at(-1) as string);
  }
  const outPath = process.argv[3] ?? join(evalDir, "judge-report.json");
  const inputs = readdirSync(evalDir)
    .filter((d) => /^agent-chat-eval-(baseline|new)-(ask|answer|noise|delegate)-\d+-/.test(d))
    .sort()
    .map((d) => {
      const parts = d.replace(/^agent-chat-eval-/, "").split("-"); // arm, scenario, n, rand
      return {
        run: `${parts[0]}-${parts[1]}-${parts[2]}`,
        scenario: (parts[1] ?? "ask") as EvalKey,
        dir: join(evalDir, d),
        // Standalone re-scoring has no harness exit codes: completed is the
        // only class the judge can score, so assume it and let the verdicts say.
        harnessOutcome: "completed" as const,
      };
    });
  const report = await runJudge(inputs);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nwrote ${outPath} (${inputs.length} runs)`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`FATAL: ${String(e)}`);
    process.exit(1);
  });
}
