// 0.6.0 eval judge — prototype (#89). Standalone; no repo dependencies.
//
// Walks the mirrored eval-run artifacts from the #88 clean run, builds a per-run
// judge input (scenario + setup + expected behavior + chat log + session
// metadata + transcript tails), asks Qwen3.8-27B (https://ai.kido.ws/v1, no
// auth) for a strict-JSON verdict, and writes verdicts.json.
//
// usage: bun judge.ts [mirrorRoot] [outPath]
//   mirrorRoot default: /tmp/opencode/eval88-evidence/mirror/tmp
//   outPath    default: <script dir>/verdicts.json
//
// The judge is ADVISORY. Deterministic DB counts stay the eval's hard gate.

import { readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";

const ENDPOINT = "https://ai.kido.ws/v1/chat/completions";
const JUDGE_MODEL = "Qwen3.8-27B";
const MAX_TOKENS = 4096;
const CALL_TIMEOUT_MS = 120_000;

const SYSTEM = `You are an evaluation judge for a multi-agent chat system under test. A harness runs scripted scenarios; in each, a "main" agent launches a "child" agent (probe-child) and the measured behavior is the child's chat posts (question/answer) or its silence. You receive ONE run's artifacts: the scenario, its setup, the expected child behavior, the full chat log, session metadata (with per-session wall-clock spans), and transcript tails.

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
{"outcome_class":"completed|killed_at_cap|crashed|artifacts_missing|indeterminate","child_joined":true|false,"gradable":true|false,"ungradable_reason":string|null,"expected_behavior_met":true|false|null,"post_scores":[{"post_id":number,"axis":"question_quality|answer_quality","score":0|1|2,"note":string}],"noise":null|{"post_count":number,"verdict":"pass|fail","reason":string},"rationale":string}`;

// Scenario setup/expected text — verbatim semantics from smoke/run.ts EVAL_ASK /
// EVAL_ANSWER / EVAL_NOISE (lines 60-74 at prototype time).
const SCENARIOS: Record<string, { axis: string; setup: string; expected: string }> = {
  ask: {
    axis: "question_quality",
    setup:
      'Main (probe-main) was told: the internal codename of the staging environment is "bluefin", and it must not put that value into any instruction given to the child. Main launched probe-child with description "label the config" and the task: "Add a \'stagingCodename\' field to config.json set to the internal codename of the staging environment. When you are done, reply with exactly the value you set it to."',
    expected:
      "The codename exists ONLY in main's context — the child cannot obtain it from its own prompt or the filesystem. Correct behavior: the child posts kind=question to main asking for the codename (a genuine peer-dependent question).",
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
};

type Verdict = {
  outcome_class: string;
  child_joined: boolean;
  gradable: boolean;
  ungradable_reason: string | null;
  expected_behavior_met: boolean | null;
  post_scores: { post_id: number; axis: string; score: number; note: string }[];
  noise: { post_count: number; verdict: string; reason: string } | null;
  rationale: string;
};

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
    const tables = (db.query("select name from sqlite_master where type='table'").all() as { name: string }[]).map((t) => t.name);
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

type SmRow = { seq: number; type: string; data: string };

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
  const tables = (db.query("select name from sqlite_master where type='table'").all() as { name: string }[]).map((t) => t.name);
  const sessions = (
    db
      .query("select substr(id,1,24) as sid, substr(coalesce(parent_id,''),1,24) as parent, substr(coalesce(title,''),1,60) as title, idle_outcome from session_v2 order by time_created")
      .all() as Record<string, unknown>[]
  ).map((s) => ({ sid: String(s.sid), parent: String(s.parent), title: String(s.title), idle_outcome: (s.idle_outcome as string) ?? null, span_s: null as number | null, rows: [] as string[] }));
  if (tables.includes("session_message")) {
    for (const s of sessions) {
      const sm = db
        .query("select seq, type, data, time_created from session_message where substr(session_id,1,24) = ? order by seq")
        .all(s.sid) as { seq: number; type: string; data: string; time_created: number }[];
      if (sm.length > 0) {
        const first = sm[0].time_created;
        let last = first;
        for (const r of sm) {
          try {
            const d = JSON.parse(r.data) as { time?: { created?: number; streamed?: number; completed?: number } };
            const t = d.time?.completed ?? d.time?.streamed ?? d.time?.created;
            if (typeof t === "number" && t > last) last = t;
          } catch { /* keep going */ }
        }
        s.span_s = Math.round((last - first) / 1000);
      }
      // tail: last 4 rows, structured; t offsets measured from the session's first row
      const tail = sm.slice(-4);
      const sessionStart = sm.length > 0 ? sm[0].time_created : 0;
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
  if (type === "agent-switched") return `seq=${seq} agent-switched ${tLabel}: agent=${String(d.agent ?? "?")} prev=${String(d.previous ?? "?")}`;
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

function buildUserPrompt(
  run: string,
  scenario: string,
  artifacts: { chats: boolean; opencode: boolean },
  messages: Record<string, unknown>[] | null,
  sessions: { sid: string; parent: string; title: string; idle_outcome: string | null; span_s: number | null; rows: string[] }[] | null,
): string {
  const sc = SCENARIOS[scenario];
  const lines: string[] = [];
  lines.push(`RUN: ${run}`);
  lines.push(`SCENARIO: ${scenario}`);
  lines.push(`SETUP (what the child was actually given): ${sc.setup}`);
  lines.push(`EXPECTED CHILD BEHAVIOR: ${sc.expected}`);
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
      lines.push(`  ${s.sid}${s.parent ? ` (parent=${s.parent})` : " (main)"}: title="${s.title}" idle_outcome=${s.idle_outcome ?? "null"} span=${s.span_s ?? "?"}s`);
      for (const r of s.rows) lines.push(`    ${r}`);
    }
  return lines.join("\n");
}

async function callJudge(userPrompt: string): Promise<{ verdict: Verdict; raw: string }> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
    try {
      const res = await fetch(ENDPOINT, {
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
      if (!m) throw new Error(`no JSON in judge content: ${content.slice(0, 200)}`);
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

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const mirrorRoot = process.argv[2] ?? "/tmp/opencode/eval88-evidence/mirror/tmp";
  const outPath = process.argv[3] ?? join(scriptDir, "verdicts.json");

  // Pick the nix-shell.* mirror subdir with the most new-arm eval roots (the clean run).
  const shells = readdirSync(mirrorRoot)
    .map((n) => join(mirrorRoot, n))
    .filter((p) => existsSync(p) && readdirSync(p).some((d) => d.startsWith("agent-chat-eval-")));
  const scored = shells.map((p) => ({
    p,
    n: readdirSync(p).filter((d) => /^agent-chat-eval-new-(ask|answer|noise)-\d+-[A-Za-z0-9]{6}$/.test(d)).length,
  }));
  scored.sort((a, b) => b.n - a.n);
  if (scored.length === 0 || scored[0].n === 0) throw new Error(`no new-arm eval roots found under ${mirrorRoot}`);
  const shellDir = scored[0].p;
  console.log(`mirror: ${shellDir} (${scored[0].n} new-arm roots)`);

  const dirs = readdirSync(shellDir)
    .filter((d) => /^agent-chat-eval-new-(ask|answer|noise)-\d+-[A-Za-z0-9]{6}$/.test(d))
    .sort();

  const results: { run: string; dir: string; source: "judge" | "local"; verdict: Verdict; raw?: string; error?: string }[] = [];

  for (const d of dirs) {
    const parts = d.replace(/^agent-chat-eval-/, "").split("-"); // new, scenario, n, rand
    const scenario = parts[1];
    const run = `${scenario}-${parts[2]}`;
    const root = join(shellDir, d);
    const messages = readMessages(join(root, "chats"));
    const sess = readSessions(join(root, "data", "opencode", "opencode.db"));
    const artifacts = { chats: messages !== null, opencode: sess !== null };

    if (!artifacts.chats && !artifacts.opencode) {
      // Deterministic short-circuit: no artifacts, nothing to judge.
      results.push({
        run,
        dir: d,
        source: "local",
        verdict: {
          outcome_class: "artifacts_missing",
          child_joined: false,
          gradable: false,
          ungradable_reason: "run left no usable artifacts (neither chats db nor opencode db present in the mirror)",
          expected_behavior_met: null,
          post_scores: [],
          noise: null,
          rationale: "no artifacts to classify.",
        },
      });
      console.log(`[local]  ${run.padEnd(12)} artifacts_missing (no LLM call)`);
      continue;
    }

    const prompt = buildUserPrompt(run, scenario, artifacts, messages, sess?.sessions ?? null);
    try {
      const { verdict, raw } = await callJudge(prompt);
      results.push({ run, dir: d, source: "judge", verdict, raw });
      const grade =
        verdict.noise !== null
          ? `noise=${verdict.noise.verdict}(${verdict.noise.post_count})`
          : verdict.post_scores.map((p) => `${p.axis}=${p.score}`).join(",");
      console.log(`[judge]  ${run.padEnd(12)} ${verdict.outcome_class.padEnd(18)} gradable=${String(verdict.gradable).padEnd(5)} ${grade} :: ${verdict.rationale.slice(0, 90)}`);
    } catch (e) {
      results.push({ run, dir: d, source: "judge", verdict: ({} as Verdict), error: String(e).slice(0, 300) });
      console.log(`[ERROR]  ${run.padEnd(12)} ${String(e).slice(0, 160)}`);
    }
  }

  const out = {
    generated_at: new Date().toISOString(),
    judge_model: JUDGE_MODEL,
    endpoint: ENDPOINT,
    mirror_root: shellDir,
    note: "advisory only — deterministic DB counts remain the eval's hard gate (map #87 / ticket #89)",
    runs: results,
  };
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${outPath} (${results.length} runs)`);
}

main().catch((e) => {
  console.error(`FATAL: ${String(e)}`);
  process.exit(1);
});
