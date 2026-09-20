import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sanitize } from "../src/core/render.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const HOST_DATA = join(homedir(), ".local", "share", "opencode");
const HOST_DB = join(HOST_DATA, "opencode.db");
const HOST_AUTH = join(HOST_DATA, "auth.json");
const MODEL = "deepseek/deepseek-flash";
const SMOKE_TAIL = "SMOKE-TAIL-7f3a";
const BOOTSTRAP_TIMEOUT_S = 120;
const CHAT_TIMEOUT_S = 600;
const CONFIG_TIMEOUT_S = 180;
const EXPORT_TIMEOUT_S = 120;
const PLUGIN_ID = "opencode-agent-chat";

const MAIN_AGENT = `---
description: Probe main agent that launches the probe-child subagent
mode: primary
model: ${MODEL}
---

You are probe-main, a minimal test agent. Follow the user's instructions exactly.
`;

const CHILD_AGENT = `---
description: Probe child agent for smoke scenarios
mode: subagent
model: ${MODEL}
---

You are probe-child, a minimal test agent. Follow the user's instructions exactly.
`;

const CHAT_PROMPT = `This is an automated smoke test. Follow these steps exactly, in order.

Step 1: Call the subagent tool exactly once with agent "probe-child", description "post chat finding and question", and prompt: "Call the chat_post tool exactly twice, in order: first with kind \\"finding\\" and body \\"SMOKE-FINDING: the harness reaches the child session\\"; second with kind \\"question\\" and a body that starts with exactly \\"SMOKE-QUESTION: does the parent answer this? \\", continues with the letter \\"a\\" repeated 250 times, and ends with exactly \\"${SMOKE_TAIL}\\". Do not call any other tool. Then reply with exactly CHILD-DONE." Wait until the subagent finishes before doing anything else.

Step 2: A digest of the agent chat is injected into your context as text. It lists messages as "[<id>] <name> - <kind>: <text>" and has a line "Open questions: #<id> (<name>)". Find the open question posted by probe-child and note its numeric id N.

Step 3: Call the chat_read tool exactly once with arguments {"ids":[N]}, where N is the numeric id you found. This returns the full text of that message.

Step 4: Call the chat_roster tool exactly once with arguments {}.

Step 5: Call the chat_post tool exactly once with arguments {"kind":"answer","body":"SMOKE-ANSWER: answering question N","in_reply_to":N}, where N is the numeric id you found.

Step 6: Reply with exactly one line and nothing else: QUESTION_ID=<N>
`;

const CONFIG_PROMPT = "reply with the single word ok";

class SmokeError extends Error {}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SmokeError(message);
}

interface CredentialRow {
  id: string;
  integration_id: string | null;
  label: string;
  value: string;
  connector_id: string | null;
  method_id: string | null;
  active: number | null;
  time_created: number;
  time_updated: number;
}

interface CatalogRow {
  key: string;
  value: string;
  time_created: number;
  time_updated: number;
}

interface MessageRow {
  id: number;
  sender_type: string;
  sender_name: string;
  kind: string;
  to_name: string | null;
  in_reply_to: number | null;
  body: string;
}

interface Delivery {
  kind: string;
  sessionID: string;
  cursor: number;
}

interface ExportToolCall {
  tool?: string;
  status?: string;
  input?: unknown;
}

interface ExportToolState {
  status?: string;
  input?: unknown;
  content?: ExportPart[];
  metadata?: { toolCalls?: ExportToolCall[] };
}

interface ExportPart {
  type: string;
  text?: string;
  name?: string;
  state?: ExportToolState;
}

interface ExportMessage {
  type: string;
  content?: ExportPart[];
}

interface ExportData {
  messages: ExportMessage[];
}

interface CommandOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutS: number;
  logPath: string;
}

interface CommandResult {
  exitCode: number;
  logPath: string;
}

function xdgEnv(root: string): Record<string, string> {
  return {
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
  };
}

function isolatedDbPath(root: string): string {
  return join(root, "data", "opencode", "opencode.db");
}

async function runCommand(args: string[], options: CommandOptions): Promise<CommandResult> {
  const proc = Bun.spawn(["timeout", "-k", "5s", `${options.timeoutS}s`, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env, PWD: options.cwd },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  writeFileSync(options.logPath, stdout);
  writeFileSync(`${options.logPath}.stderr`, stderr);
  return { exitCode, logPath: options.logPath };
}

async function withRoot(prefix: string, work: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    await work(root);
    rmSync(root, { recursive: true, force: true });
  } catch (err) {
    console.error(`agent-chat smoke: artifacts kept at ${root}`);
    throw err;
  }
}

function opencodeRunArgs(prompt: string): string[] {
  return [
    "opencode2",
    "run",
    "--standalone",
    "--format",
    "json",
    "--print-logs",
    "--auto",
    "--agent",
    "probe-main",
    "-m",
    MODEL,
    prompt,
  ];
}

function mountEntry(root: string, chatsDir: string): unknown {
  return { package: join(root, "mount"), options: { chatDir: chatsDir, debug: true } };
}

function mountPlugin(root: string): string {
  const mount = join(root, "mount");
  mkdirSync(mount, { recursive: true });
  writeFileSync(
    join(mount, "package.json"),
    `${JSON.stringify(
      { name: PLUGIN_ID, version: "0.0.0", type: "module", exports: { "./server": "./server.ts" } },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(mount, "server.ts"),
    `export { default } from ${JSON.stringify(pathToFileURL(join(REPO_ROOT, "src", "plugin.ts")).href)};\n`,
  );
  return mount;
}

function scaffold(root: string, projectPlugins: unknown[], globalPlugins?: unknown[]): string {
  const project = join(root, "project");
  mkdirSync(join(project, ".opencode", "agents"), { recursive: true });
  writeFileSync(
    join(project, ".opencode", "opencode.jsonc"),
    `${JSON.stringify({ plugins: projectPlugins }, null, 2)}\n`,
  );
  writeFileSync(join(project, ".opencode", "agents", "probe-main.md"), MAIN_AGENT);
  writeFileSync(join(project, ".opencode", "agents", "probe-child.md"), CHILD_AGENT);
  if (globalPlugins !== undefined) {
    mkdirSync(join(root, "config", "opencode"), { recursive: true });
    writeFileSync(
      join(root, "config", "opencode", "opencode.jsonc"),
      `${JSON.stringify({ plugins: globalPlugins }, null, 2)}\n`,
    );
  }
  return project;
}

async function seedIsolatedState(root: string, project: string): Promise<void> {
  assert(existsSync(HOST_DB), `host opencode.db not found at ${HOST_DB}; cannot seed the isolated data dir`);
  mkdirSync(join(root, "data", "opencode"), { recursive: true });
  const bootstrap = await runCommand(["opencode2", "session", "list", "--standalone", "--format", "json"], {
    cwd: project,
    env: xdgEnv(root),
    timeoutS: BOOTSTRAP_TIMEOUT_S,
    logPath: join(root, "bootstrap.log"),
  });
  assert(
    bootstrap.exitCode === 0,
    `bootstrap "opencode2 session list" exited ${bootstrap.exitCode} (log: ${bootstrap.logPath})`,
  );
  const host = new Database(HOST_DB, { readonly: true });
  const credentials = host
    .query(
      "select id, integration_id, label, value, connector_id, method_id, active, time_created, time_updated from credential",
    )
    .all() as CredentialRow[];
  const catalog = host
    .query("select key, value, time_created, time_updated from kv where key = 'models-dev:catalog'")
    .get() as CatalogRow | null;
  host.close();
  assert(credentials.length > 0, `host opencode.db at ${HOST_DB} has no credential rows; the model would be unavailable`);
  assert(catalog !== null, `host opencode.db at ${HOST_DB} has no models-dev:catalog kv row; model routing fails without it (run opencode2 against a provider on this host once to create it)`);

  const isolated = new Database(isolatedDbPath(root));
  const insertCredential = isolated.query(
    "insert or replace into credential (id, integration_id, label, value, connector_id, method_id, active, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const row of credentials) {
    insertCredential.run(
      row.id,
      row.integration_id,
      row.label,
      row.value,
      row.connector_id,
      row.method_id,
      row.active,
      row.time_created,
      row.time_updated,
    );
  }
  isolated
    .query("insert or replace into kv (key, value, time_created, time_updated) values (?, ?, ?, ?)")
    .run(catalog.key, catalog.value, catalog.time_created, catalog.time_updated);
  isolated.close();
  if (existsSync(HOST_AUTH)) copyFileSync(HOST_AUTH, join(root, "data", "opencode", "auth.json"));
}

function sessionRows(root: string): number {
  const path = isolatedDbPath(root);
  if (!existsSync(path)) return 0;
  const db = new Database(path, { readonly: true });
  try {
    const row = db.query("select count(*) as n from session_v2").get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

function debugLines(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^\[[^\]]*\] /, ""));
}

function deliveries(lines: string[]): Delivery[] {
  const result: Delivery[] = [];
  for (const line of lines) {
    const match = /^(briefing|digest) ([A-Za-z0-9_-]+) cursor=(\d+)$/.exec(line);
    if (match === null) continue;
    const [, kind, sessionID, cursor] = match;
    if (kind === undefined || sessionID === undefined || cursor === undefined) continue;
    result.push({ kind, sessionID, cursor: Number(cursor) });
  }
  return result;
}

function assistantText(data: ExportData): string {
  const parts: string[] = [];
  for (const message of data.messages) {
    if (message.type !== "assistant") continue;
    for (const part of message.content ?? []) {
      if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
    }
  }
  return parts.join("\n");
}

function toolInvocations(data: ExportData, name: string): { input: unknown; outputs: string[] }[] {
  const target = name.replace(/\./g, "_");
  const invocations: { input: unknown; outputs: string[] }[] = [];
  for (const message of data.messages) {
    if (message.type !== "assistant") continue;
    for (const part of message.content ?? []) {
      if (part.type !== "tool" || part.state?.status !== "completed") continue;
      const outputs: string[] = [];
      for (const item of part.state.content ?? []) {
        if (item.type === "text" && typeof item.text === "string") outputs.push(item.text);
      }
      if (part.name?.replace(/\./g, "_") === target) invocations.push({ input: part.state.input, outputs });
      for (const call of part.state.metadata?.toolCalls ?? []) {
        if (call.status !== "completed" || call.tool?.replace(/\./g, "_") !== target) continue;
        invocations.push({ input: call.input, outputs });
      }
    }
  }
  return invocations;
}

function toolOutputs(invocations: { input: unknown; outputs: string[] }[]): string[] {
  return invocations.flatMap((invocation) => invocation.outputs);
}

async function chatScenario(): Promise<void> {
  await withRoot("agent-chat-smoke-chat-", chatScenarioBody);
}

async function chatScenarioBody(root: string): Promise<void> {
  const chatsDir = join(root, "chats");
  const project = scaffold(root, [mountEntry(root, chatsDir)]);
  mountPlugin(root);
  await seedIsolatedState(root, project);
  const run = await runCommand(opencodeRunArgs(CHAT_PROMPT), {
    cwd: project,
    env: xdgEnv(root),
    timeoutS: CHAT_TIMEOUT_S,
    logPath: join(root, "chat-run.log"),
  });
  const debugPath = join(chatsDir, "debug.log");
  const lines = existsSync(debugPath) ? debugLines(debugPath) : [];
  if (run.exitCode === 124) {
    assert(lines.includes("plugin loaded"), `chat run timed out (exit 124) before the plugin loaded; debug log: ${debugPath}`);
  }
  assert(existsSync(chatsDir), `chat directory ${chatsDir} was never created (run log: ${run.logPath})`);

  const dbs = readdirSync(chatsDir).filter((name) => name.endsWith(".db"));
  assert(dbs.length === 1, `expected exactly one chat DB under ${chatsDir}, found ${dbs.length}: ${dbs.join(", ") || "none"}`);
  const dbFile = dbs[0];
  assert(dbFile !== undefined, `expected exactly one chat DB under ${chatsDir}, found none`);
  const dbPath = join(chatsDir, dbFile);
  const rootID = dbFile.slice(0, -".db".length);

  const db = new Database(dbPath, { readonly: true });
  const messages = db
    .query("select id, sender_type, sender_name, kind, to_name, in_reply_to, body from messages order by id")
    .all() as MessageRow[];
  db.close();

  const systemRow = (body: string) =>
    messages.some(
      (m) => m.sender_type === "system" && m.sender_name === "system" && m.kind === "system" && m.body === body,
    );
  assert(systemRow("probe-child joined"), `${dbPath} lacks the system join row "probe-child joined"`);
  assert(systemRow("probe-child left (completed)"), `${dbPath} lacks the system leave row "probe-child left (completed)"`);
  const finding = messages.find(
    (m) => m.sender_type === "agent" && m.sender_name === "probe-child" && m.kind === "finding",
  );
  assert(finding !== undefined, `${dbPath} lacks a finding posted by probe-child`);
  const question = messages.find(
    (m) => m.sender_type === "agent" && m.sender_name === "probe-child" && m.kind === "question",
  );
  assert(question !== undefined, `${dbPath} lacks a question posted by probe-child`);
  const answer = messages.find(
    (m) => m.sender_type === "agent" && m.sender_name === "main" && m.kind === "answer" && m.in_reply_to === question.id,
  );
  assert(answer !== undefined, `${dbPath} lacks a main answer with in_reply_to=${question.id} (answer chain)`);

  assert(existsSync(debugPath), `${debugPath} was not written; the plugin did not log (run log: ${run.logPath})`);
  const loads = lines.filter((line) => line === "plugin loaded").length;
  assert(loads === 1, `expected exactly one "plugin loaded" line in ${debugPath}, found ${loads} (double-load guard)`);
  assert(
    lines.includes("chat tool ids: chat_post, chat_read, chat_roster"),
    `${debugPath} lacks "chat tool ids: chat_post, chat_read, chat_roster"`,
  );
  const injections = deliveries(lines);
  assert(
    injections.some((d) => d.kind === "briefing"),
    `${debugPath} has no briefing injection line`,
  );
  assert(
    injections.some((d) => d.kind === "digest"),
    `${debugPath} has no digest injection line`,
  );
  assert(
    injections.some((d) => d.sessionID === rootID),
    `${debugPath} has no briefing/digest line for the root session ${rootID}`,
  );
  for (const injection of injections) {
    assert(
      injection.cursor >= 1,
      `${debugPath} has a ${injection.kind} line with cursor=${injection.cursor}; expected a real message id`,
    );
    assert(
      messages.some((m) => m.id === injection.cursor),
      `${debugPath} has a ${injection.kind} line for ${injection.sessionID} with cursor=${injection.cursor}, which is not a message id in ${dbPath}`,
    );
  }

  const exportPath = join(root, "session-export.json");
  const exported = await runCommand(["opencode2", "session", "export", "--standalone", rootID], {
    cwd: project,
    env: xdgEnv(root),
    timeoutS: EXPORT_TIMEOUT_S,
    logPath: exportPath,
  });
  assert(
    exported.exitCode === 0,
    `"opencode2 session export" for ${rootID} exited ${exported.exitCode} (log: ${exportPath})`,
  );
  const transcript = JSON.parse(readFileSync(exportPath, "utf8")) as ExportData;
  const quoted = /QUESTION_ID=(\d+)/.exec(assistantText(transcript));
  assert(quoted !== null, `session export ${exportPath} has no QUESTION_ID=<id> in assistant text; the digest id was not quoted`);
  const quotedID = Number(quoted[1]);
  assert(
    quotedID === question.id,
    `session export ${exportPath} quotes QUESTION_ID=${quotedID} but the open question row is #${question.id}`,
  );

  const rangedRead = toolInvocations(transcript, "chat_read").some((invocation) => {
    const input = invocation.input as { ids?: unknown } | undefined;
    return Array.isArray(input?.ids) && input.ids.includes(question.id);
  });
  assert(
    rangedRead,
    `session export ${exportPath} has no completed chat_read call with ids containing the question id #${question.id}`,
  );
  const readOutputs = toolOutputs(toolInvocations(transcript, "chat_read"));
  assert(
    readOutputs.length > 0,
    `session export ${exportPath} has no completed chat_read output`,
  );
  assert(
    question.body.length > 200,
    `probe-child's question body is ${question.body.length} characters; the smoke needs more than 200 to prove full-body reads`,
  );
  assert(
    question.body.endsWith(SMOKE_TAIL),
    `probe-child's question body does not end with ${SMOKE_TAIL}; the read tail cannot be checked`,
  );
  const fullBody = sanitize(question.body);
  assert(
    readOutputs.some((output) => output.includes(fullBody)),
    `chat_read returned no output containing the full ${fullBody.length}-character question body; the read was excerpted or read the wrong id`,
  );

  const rosterOutputs = toolOutputs(toolInvocations(transcript, "chat_roster"));
  assert(
    rosterOutputs.length > 0,
    `session export ${exportPath} has no completed chat_roster output`,
  );
  assert(
    rosterOutputs.some((output) => /main · [^·\n]+ · (busy|idle) · joined \d{4}-\d{2}-\d{2}T/.test(output)),
    `chat_roster output does not name main with type and joined time: ${JSON.stringify(rosterOutputs)}`,
  );
}

async function runConfigArm(
  root: string,
  chats: string,
  projectPlugins: unknown[],
  globalPlugins?: unknown[],
): Promise<CommandResult> {
  const project = scaffold(root, projectPlugins, globalPlugins);
  mountPlugin(root);
  await seedIsolatedState(root, project);
  return runCommand(opencodeRunArgs(CONFIG_PROMPT), {
    cwd: project,
    env: xdgEnv(root),
    timeoutS: CONFIG_TIMEOUT_S,
    logPath: join(root, "config-run.log"),
  });
}

async function configScenario(): Promise<void> {
  await withRoot("agent-chat-smoke-config-removal-", async (root) => {
    const chats = join(root, "chats-global");
    const run = await runConfigArm(root, chats, [`-${PLUGIN_ID}`], [mountEntry(root, chats)]);
    const debug = join(chats, "debug.log");
    assert(run.exitCode === 0 || run.exitCode === 124, `removal run exited ${run.exitCode} (log: ${run.logPath})`);
    assert(
      !existsSync(debug),
      `global add + project "-${PLUGIN_ID}" loaded the plugin: ${debug} exists (run log: ${run.logPath})`,
    );
    assert(
      sessionRows(root) > 0,
      `${isolatedDbPath(root)} has no session_v2 row; the removal run never created a session, so the no-load result is inconclusive`,
    );
  });

  await withRoot("agent-chat-smoke-config-add-", async (root) => {
    const chats = join(root, "chats-project");
    const run = await runConfigArm(root, chats, [mountEntry(root, chats)]);
    const debug = join(chats, "debug.log");
    assert(
      run.exitCode === 0 || (run.exitCode === 124 && existsSync(debug)),
      `add run exited ${run.exitCode} before the plugin loaded (log: ${run.logPath})`,
    );
    assert(existsSync(debug), `project add did not load the plugin: ${debug} missing (run log: ${run.logPath})`);
    const loads = debugLines(debug).filter((line) => line === "plugin loaded").length;
    assert(loads === 1, `expected exactly one "plugin loaded" line in ${debug}, found ${loads}`);
  });
}

type Scenario = "chat" | "config";

const SCENARIOS: Scenario[] = ["chat", "config"];

function selectedScenarios(argv: string[]): Scenario[] {
  let requested = "all";
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--scenario") {
      requested = argv[index + 1] ?? "";
      index++;
    }
  }
  if (requested === "all") return SCENARIOS;
  if (requested === "chat" || requested === "config") return [requested];
  console.error(`usage: bun run smoke [--scenario chat|config|all]`);
  process.exit(2);
}

const scenarios = selectedScenarios(Bun.argv.slice(2));
let failed = false;
for (const scenario of scenarios) {
  try {
    if (Bun.which("opencode2") === null) {
      throw new SmokeError('opencode2 is not on PATH; run the smoke inside "nix develop"');
    }
    if (scenario === "chat") await chatScenario();
    else await configScenario();
    console.log(`PASS ${scenario}`);
  } catch (err) {
    failed = true;
    console.log(`FAIL ${scenario}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
process.exit(failed ? 1 : 0);
