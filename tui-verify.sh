#!/usr/bin/env bash
# tui-verify.sh — live-TUI verification of the windowed /agent-chat transcript (map #66, ticket #69, PR #71).
#
# Drives a real opencode TUI under tmux inside an isolated XDG sandbox (the same isolation the
# smoke scenario uses): credentials/catalog are copied from the host opencode.db so the TUI
# boots without touching your real opencode state.
#
# Mechanisms (learned from driving the v2.0.12 TUI by hand; the script mirrors them):
#   * The plugin is loaded through a mount shim (a wrapper package re-exporting the repo's
#     src/plugin.ts and src/tui.ts) — a repo-root `package` path fails in the host loader.
#   * Sessions are created with `opencode run --standalone ...` (the TUI alone creates no
#     session), then the TUI continues them with `opencode --standalone --session <id>`.
#   * A bare `/agent-chat` slash does not submit (the TUI keeps slash text in the composer),
#     so the notice check runs the command from the palette; `/agent-chat full` (with the
#     argument) submits from the slash prompt.
#   * The pane renders the synthetic notice's `description` only: the windowed body (header +
#     last 10 messages). The label with the "· showing last 10 of N · /agent-chat full"
#     indicator rides in the synthetic `text` (visible in the session transcript/export), not
#     the pane — its absence below the threshold is asserted by the unit tests.
#   * The host v2.0.12 gives the plugin session.panel no close affordance; the plugin binds
#     Escape itself (no-op when its panel is closed), so Esc closes the panel.
#
# Checks:
#   1. `/agent-chat` on a chat with >10 messages posts the windowed notice: the `chat …`
#      header + exactly the last 10 messages, with the window-excluded messages absent.
#   2. `/agent-chat` on a chat with <=10 messages posts the full notice (all messages).
#   3. `/agent-chat full` opens the fullscreen session.panel with the "· N messages" header,
#      the "esc to close" hint, and the full transcript (including the excluded messages).
#   4. Esc closes the panel; re-invoking `/agent-chat full` reopens it with fresh content.
#
# Usage:   ./tui-verify.sh [PLUGIN_PATH]
#          PLUGIN_PATH defaults to the directory containing this script (the repo checkout).
# Env:     OPENCODE   opencode binary        (default: PATH, else /etc/profiles/per-user/kido/bin/opencode)
#          MODEL      model id for the TUI   (default: deepseek/deepseek-flash)
#          PANE_W     tmux pane width        (default: 200)
#          PANE_H     tmux pane height       (default: 50)
#
# Two tiny model calls happen (one `opencode run` per project, prompt "ok").
# On any failure the script dumps the pane tail and keeps the sandbox (path printed) for inspection.

set -u

PLUGIN="${1:-$(cd "$(dirname "$0")" && pwd)}"
OPENCODE="${OPENCODE:-$(command -v opencode || echo /etc/profiles/per-user/kido/bin/opencode)}"
MODEL="${MODEL:-deepseek/deepseek-flash}"
PANE_W="${PANE_W:-200}"
PANE_H="${PANE_H:-50}"
HOST_DATA="${HOME}/.local/share/opencode"
HOST_DB="${HOST_DATA}/opencode.db"

ROOT=""
FAILURES=0
SESSIONS=()

log()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
pass() { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAILURES=$((FAILURES + 1)); }

pane() { tmux capture-pane -pt "$1" 2>/dev/null; }

pane_dump() { # $1=session $2=note
  printf '  --- %s (pane tail) ---\n' "$2"
  pane "$1" | tail -30 | sed 's/^/  | /'
}

# wait_for SESSION FIXED_STRING TIMEOUT_S DESCRIPTION
wait_for() {
  local s=$1 str=$2 t=$3 desc=$4 i
  local max=$((t * 2))
  for ((i = 0; i < max; i++)); do
    if pane "$s" | grep -qF -- "$str"; then return 0; fi
    sleep 0.5
  done
  fail "$desc — \"$str\" not seen within ${t}s"
  pane_dump "$s" "$desc"
  return 1
}

# wait_gone SESSION FIXED_STRING TIMEOUT_S DESCRIPTION
wait_gone() {
  local s=$1 str=$2 t=$3 desc=$4 i
  local max=$((t * 2))
  for ((i = 0; i < max; i++)); do
    if ! pane "$s" | grep -qF -- "$str"; then return 0; fi
    sleep 0.5
  done
  fail "$desc — \"$str\" still present after ${t}s"
  pane_dump "$s" "$desc"
  return 1
}

# wait_stable SESSION TIMEOUT_S — true once the pane stops changing for ~2s (TUI booted)
wait_stable() {
  local s=$1 t=$2 prev="" cur="" same=0 i
  local max=$((t * 2))
  for ((i = 0; i < max; i++)); do
    cur="$(pane "$s" | md5sum | cut -d' ' -f1)"
    if [ "$cur" = "$prev" ]; then same=$((same + 1)); else same=0; fi
    [ "$same" -ge 4 ] && return 0
    prev=$cur
    sleep 0.5
  done
  return 1
}

# send_cmd SESSION TEXT — type the slash command literally (WITH its argument), then Enter
send_cmd() {
  tmux send-keys -t "$1" -l -- "$2"
  sleep 0.8
  tmux send-keys -t "$1" Enter
  sleep 1.2
}

# palette_cmd SESSION SEARCH — run a command via the palette (Ctrl+P), which submits reliably
palette_cmd() {
  tmux send-keys -t "$1" C-p
  sleep 0.8
  tmux send-keys -t "$1" -l -- "$2"
  sleep 0.6
  tmux send-keys -t "$1" Enter
  sleep 1.2
}

# count_msgs DB — message count via bun:sqlite
count_msgs() {
  DB="$1" bun -e '
    import { Database } from "bun:sqlite";
    const db = new Database(process.env.DB, { readonly: true });
    const row = db.query("select count(*) as n from messages").get() as { n: number };
    db.close();
    process.stdout.write(String(row.n));
  '
}

# seed DB COUNT — insert COUNT status messages (SEED-01 …) as agent "probe-seeder"
seed() {
  DB="$1" N="$2" bun -e '
    import { Database } from "bun:sqlite";
    const n = Number(process.env.N);
    const db = new Database(process.env.DB);
    db.exec("PRAGMA busy_timeout = 5000");
    const now = Date.now();
    const ins = db.query(
      "insert into messages (sender_type, sender_name, sender_session, kind, to_name, in_reply_to, body, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (let i = 1; i <= n; i++) {
      ins.run("agent", "probe-seeder", "ses_seed", "status", null, null,
        "SEED-" + String(i).padStart(2, "0") + " filler line " + i, now + i);
    }
    db.close();
  '
}

# wait_chat CHATSDIR TIMEOUT_S — path of the chat .db the plugin created, once it has >=1 message
wait_chat() {
  local dir=$1 t=$2 f i
  local max=$((t * 2))
  for ((i = 0; i < max; i++)); do
    f="$(find "$dir" -maxdepth 1 -name '*.db' 2>/dev/null | head -1)"
    if [ -n "$f" ] && [ "$(count_msgs "$f" 2>/dev/null || echo 0)" -ge 1 ]; then
      printf '%s\n' "$f"
      return 0
    fi
    sleep 0.5
  done
  return 1
}

# run_session NAME PROJECT LOGFILE — create a session via `opencode run` (the TUI alone creates
# none) and print its id. The plugin posts the join/leave lines to the project's chatDir.
run_session() {
  local name=$1 proj=$2 logf=$3 id
  (
    cd "$proj" || exit 1
    id="$(env XDG_CONFIG_HOME="$ROOT/config" XDG_DATA_HOME="$ROOT/data" XDG_CACHE_HOME="$ROOT/cache" \
      timeout -k 5s 120s "$OPENCODE" run --standalone --format json --print-logs --auto -m "$MODEL" ok \
      2>"$logf" | grep -oE 'ses_[A-Za-z0-9]+' | head -1)"
    [ -n "$id" ] || exit 1
    printf '%s\n' "$id"
  )
}

# start_tui NAME PROJECT SESSION_ID — boot the opencode TUI continuing the session, isolated
start_tui() {
  local name=$1 proj=$2 sid=$3
  tmux new-session -d -s "$name" -x "$PANE_W" -y "$PANE_H" -c "$proj" \
    "env XDG_CONFIG_HOME=$ROOT/config XDG_DATA_HOME=$ROOT/data XDG_CACHE_HOME=$ROOT/cache $OPENCODE --standalone --session $sid"
  SESSIONS+=("$name")
}

cleanup() {
  local s
  for s in "${SESSIONS[@]:-}"; do [ -n "$s" ] && tmux kill-session -t "$s" 2>/dev/null; done
  if [ -n "$ROOT" ]; then
    if [ "$FAILURES" -eq 0 ]; then
      rm -rf "$ROOT"
    else
      printf '\n\033[31m%d check(s) failed.\033[0m Sandbox kept for inspection: %s\n' "$FAILURES" "$ROOT"
    fi
  fi
}
trap cleanup EXIT

# --- preflight ---------------------------------------------------------------
command -v tmux >/dev/null || { echo "error: tmux not found" >&2; exit 2; }
command -v bun >/dev/null || { echo "error: bun not found (needed for the chat seeding)" >&2; exit 2; }
[ -x "$OPENCODE" ] || { echo "error: opencode not found at $OPENCODE" >&2; exit 2; }
[ -d "$PLUGIN" ] || { echo "error: plugin path not found: $PLUGIN" >&2; exit 2; }
[ -f "$PLUGIN/src/plugin.ts" ] || { echo "error: $PLUGIN/src/plugin.ts not found" >&2; exit 2; }
[ -f "$PLUGIN/src/tui.ts" ] || { echo "error: $PLUGIN/src/tui.ts not found" >&2; exit 2; }
[ -f "$HOST_DB" ] || { echo "error: host opencode.db not found at $HOST_DB; model credentials unavailable" >&2; exit 2; }

ROOT="$(mktemp -d /tmp/opencode/tui-verify-XXXXXX)"
CHATS_L="$ROOT/chats-large"
CHATS_S="$ROOT/chats-small"
PROJ_L="$ROOT/project-large"
PROJ_S="$ROOT/project-small"
MOUNT="$ROOT/mount"
mkdir -p "$CHATS_L" "$CHATS_S" "$PROJ_L/.opencode" "$PROJ_S/.opencode" "$MOUNT" "$ROOT/config/opencode" "$ROOT/data/opencode"

# Isolated global config: pin the model so the TUI boots straight into a session.
printf '{\n  "model": %s\n}\n' "\"$MODEL\"" > "$ROOT/config/opencode/opencode.jsonc"

# Mount shim: a wrapper package re-exporting the checkout's entries. A repo-root `package`
# path fails to load in the host plugin loader (proven live); the shim form is the one the
# smoke scenario uses and the one the host loads.
printf '{\n  "name": "opencode-agent-chat",\n  "version": "0.0.0",\n  "type": "module",\n  "exports": {\n    "./server": "./server.ts",\n    "./tui": "./tui.ts"\n  }\n}\n' \
  > "$MOUNT/package.json"
printf 'export { default } from "file://%s";\n' "$PLUGIN/src/plugin.ts" > "$MOUNT/server.ts"
printf 'export { default } from "file://%s";\n' "$PLUGIN/src/tui.ts" > "$MOUNT/tui.ts"

# Project configs: the plugin (via the mount shim) with a private chatDir, model pinned too.
for pair in "$PROJ_L|$CHATS_L" "$PROJ_S|$CHATS_S"; do
  proj="${pair%%|*}"
  chats="${pair##*|}"
  printf '{\n  "model": %s,\n  "plugins": [\n    {\n      "package": %s,\n      "options": { "chatDir": %s, "debug": true }\n    }\n  ]\n}\n' \
    "\"$MODEL\"" "\"$MOUNT\"" "\"$chats\"" > "$proj/.opencode/opencode.jsonc"
done

# Bootstrap the isolated data dir (opencode creates the schema), then seed it from the
# host DB — the same recipe as smoke/run.ts.
log "bootstrapping the isolated opencode state (opencode session list)"
(
  cd "$PROJ_L" || exit 1
  env XDG_CONFIG_HOME="$ROOT/config" XDG_DATA_HOME="$ROOT/data" XDG_CACHE_HOME="$ROOT/cache" \
    timeout -k 5s 120s "$OPENCODE" session list --standalone --format json >/dev/null
) || {
  echo "error: opencode bootstrap (session list) failed; the isolated data dir was not created" >&2
  exit 2
}

log "seeding isolated opencode state from $HOST_DB"
HOST_DB="$HOST_DB" ISOLATED_DB="$ROOT/data/opencode/opencode.db" AUTH_SRC="$HOST_DATA/auth.json" \
AUTH_DST="$ROOT/data/opencode/auth.json" bun -e '
  import { Database } from "bun:sqlite";
  import { copyFileSync, existsSync } from "node:fs";
  const host = new Database(process.env.HOST_DB, { readonly: true });
  const creds = host
    .query("select id, integration_id, label, value, connector_id, method_id, active, time_created, time_updated from credential")
    .all() as { id: string; integration_id: string | null; label: string; value: string; connector_id: string | null; method_id: string | null; active: number | null; time_created: number; time_updated: number }[];
  const catalog = host
    .query("select key, value, time_created, time_updated from kv where key = ?").get("models-dev:catalog") as { key: string; value: string; time_created: number; time_updated: number } | null;
  host.close();
  if (creds.length === 0) { console.error("host opencode.db has no credential rows; the model would be unavailable"); process.exit(3); }
  if (catalog === null) { console.error("host opencode.db has no models-dev:catalog row; run opencode against a provider once to create it"); process.exit(3); }
  const iso = new Database(process.env.ISOLATED_DB);
  const insCred = iso.query(
    "insert or replace into credential (id, integration_id, label, value, connector_id, method_id, active, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const c of creds) insCred.run(c.id, c.integration_id, c.label, c.value, c.connector_id, c.method_id, c.active, c.time_created, c.time_updated);
  iso.query("insert or replace into kv (key, value, time_created, time_updated) values (?, ?, ?, ?)")
    .run(catalog.key, catalog.value, catalog.time_created, catalog.time_updated);
  iso.close();
  if (existsSync(process.env.AUTH_SRC)) copyFileSync(process.env.AUTH_SRC, process.env.AUTH_DST);
  console.log(`  seeded ${creds.length} credential row(s) + model catalog`);
' || exit 1

# --- large chat: checks 1, 3, 4 ----------------------------------------------
log "large chat: creating a session (opencode run, one model call)"
LARGE_ID="$(run_session large "$PROJ_L" "$ROOT/run-large.log")" || {
  echo "error: opencode run (large) failed; log: $ROOT/run-large.log" >&2
  tail -20 "$ROOT/run-large.log" >&2
  exit 2
}
echo "  session: $LARGE_ID"

log "large chat: booting the TUI on $LARGE_ID ($MODEL)"
start_tui acv_large "$PROJ_L" "$LARGE_ID"
if ! wait_stable acv_large 90; then
  fail "TUI did not reach a stable screen within 90s (onboarding/model picker?)"
  pane_dump acv_large "boot"
fi

LARGE_DB="$(wait_chat "$CHATS_L" 30)" || {
  fail "the plugin never created a chat in $CHATS_L"
  [ -f "$CHATS_L/debug.log" ] && sed 's/^/  | /' "$CHATS_L/debug.log" | tail -20
}

if [ "$FAILURES" -eq 0 ] && [ -n "${LARGE_DB:-}" ]; then
  log "seeding 10 messages (total $(count_msgs "$LARGE_DB"): 2 system lines + 10 seeded)"
  seed "$LARGE_DB" 10 || fail "seed failed"
  N="$(count_msgs "$LARGE_DB")"

  log "check 1: /agent-chat posts the windowed notice (via the palette)"
  palette_cmd acv_large "view the agent chat"
  # The pane shows the notice description: the chat header + exactly the last 10 messages
  # (the 2 system lines and nothing else are excluded at N=12). The indicator label lives in
  # the synthetic text (session transcript/export), not the pane.
  if wait_for acv_large "chat $LARGE_ID" 30 "windowed notice header not posted" \
    && wait_for acv_large "SEED-01" 10 "oldest windowed message missing" \
    && wait_for acv_large "SEED-10" 5 "newest windowed message missing"; then
    if pane acv_large | grep -qF "main joined"; then
      fail "1: windowed notice includes the excluded join line"
      pane_dump acv_large "check 1"
    else
      pass "1: windowed notice (header + exactly the last 10 of $N, excluded lines absent)"
    fi
  fi

  log "check 3: /agent-chat full opens the fullscreen panel (via the slash prompt)"
  send_cmd acv_large "/agent-chat full"
  wait_for acv_large "agent-chat transcript for $LARGE_ID" 30 "panel header not shown" \
    && wait_for acv_large "$N messages" 5 "panel header lacks \"· $N messages\"" \
    && wait_for acv_large "esc to close" 5 "panel lacks the close hint" \
    && wait_for acv_large "main joined" 10 "full transcript lacks the message the window excludes" \
    && pass "3: fullscreen panel with \"· $N messages\" header + hint + full transcript"

  log "check 4: Esc closes, re-invocation reopens"
  tmux send-keys -t acv_large Escape
  sleep 1
  wait_gone acv_large "esc to close" 20 "panel still open after Esc" \
    && {
      send_cmd acv_large "/agent-chat full"
      wait_for acv_large "agent-chat transcript for $LARGE_ID" 30 "panel did not reopen" \
        && pass "4: Esc closes the panel; /agent-chat full reopens it"
    }
fi

# --- small chat: check 2 -------------------------------------------------------
if [ "$FAILURES" -eq 0 ]; then
  log "small chat: creating a second session (opencode run, one model call)"
  SMALL_ID="$(run_session small "$PROJ_S" "$ROOT/run-small.log")" || {
    echo "error: opencode run (small) failed; log: $ROOT/run-small.log" >&2
    exit 2
  }
  echo "  session: $SMALL_ID"

  log "small chat: booting a second TUI on $SMALL_ID (<=10 messages, no seeding)"
  start_tui acv_small "$PROJ_S" "$SMALL_ID"
  wait_stable acv_small 90 || {
    fail "small-chat TUI did not reach a stable screen within 90s"
    pane_dump acv_small "boot"
  }
  SMALL_DB="$(wait_chat "$CHATS_S" 30)" || fail "the plugin never created a chat in $CHATS_S"

  if [ "$FAILURES" -eq 0 ] && [ -n "${SMALL_DB:-}" ]; then
    log "check 2: /agent-chat on a <=10-message chat posts the full notice (via the palette)"
    palette_cmd acv_small "view the agent chat"
    # Full body = every message, including the join/leave lines the window would exclude.
    # The absence of the "showing last 10 of" label is asserted by the unit tests (it rides
    # in the synthetic text, which the pane does not render).
    if wait_for acv_small "chat $SMALL_ID" 30 "full notice header not posted" \
      && wait_for acv_small "main joined" 10 "full body missing the join line" \
      && wait_for acv_small "main left" 5 "full body missing the leave line"; then
      pass "2: <=10 messages -> full notice (all messages, no windowing)"
    fi
  fi
else
  log "skipping the small-chat check (earlier failures)"
fi

# --- summary --------------------------------------------------------------------
log "summary"
if [ "$FAILURES" -eq 0 ]; then
  printf '\033[32mALL CHECKS PASSED\033[0m — record this result in issue #69 and merge PR #71.\n'
  exit 0
fi
exit 1
