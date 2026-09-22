// Shared harness helpers (smoke/run.ts and smoke/judge.ts).

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Wall-clock cap for a single agent run: `timeout -k 5s ${CHAT_TIMEOUT_S}s`.
export const CHAT_TIMEOUT_S = 600;

// Retained eval artifacts: $XDG_DATA_HOME/opencode/eval/<UTC-timestamp>/<run-root>/
// (the #90 retention lock — per-run evidence must survive the run).
export function evalArtifactsRoot(): string {
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode", "eval");
}

// The retained eval dirs under the artifacts root: dirs holding at least one
// agent-chat-eval-* run root (names are UTC stamps, so name order is time order).
export function listEvalDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).filter(
    (d) => existsSync(join(root, d)) && readdirSync(join(root, d)).some((x) => x.startsWith("agent-chat-eval-")),
  );
}
