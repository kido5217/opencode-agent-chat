#!/usr/bin/env bash
# Local test loop for opencode-agent-chat 0.2.0.
#
# 0.2.0 is the main-branch content: the 0.1.x core plus the in-TUI
# /agent-chat command (#53). This script tests the current checkout.
#
# Usage:
#   scripts/local-test-0.2.0.sh                    # unit + typecheck + smoke (all scenarios)
#   scripts/local-test-0.2.0.sh --scenario chat    # unit + typecheck + one smoke scenario
#   scripts/local-test-0.2.0.sh --no-smoke         # unit + typecheck only
#
# Phases (each runs inside the flake dev shell, per AGENTS.md):
#   1. bun test            unit tests, incl. the 0.2.0 transcript/context-filter tests
#   2. bun run typecheck   tsc --noEmit
#   3. bun run smoke       end-to-end against the local `opencode` v2 binary
#
# Smoke prerequisites:
#   - the `opencode` v2 binary on PATH (not provided by the dev shell)
#   - at least one completed provider request on this host, so the smoke can
#     copy credential and models-dev:catalog rows into its isolated XDG home
set -euo pipefail

usage() {
  cat <<'EOF'
usage: local-test-0.2.0.sh [--scenario chat|config|all] [--no-smoke]
  --scenario <s>  run only the named smoke scenario (default: all)
  --no-smoke      skip the end-to-end smoke (unit + typecheck only)
EOF
}

scenario="all"
smoke=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --scenario) scenario="${2:?--scenario needs chat|config|all}"; shift 2 ;;
    --no-smoke) smoke=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

root="$(git rev-parse --show-toplevel)"
cd "$root"

version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -n1)"
echo "opencode-agent-chat local test"
echo "  checkout: $(git describe --tags --always) (package version $version)"
echo "  opencode: $(command -v opencode >/dev/null 2>&1 && opencode --version || echo "not on PATH")"

# --- sanity checks ------------------------------------------------------------
command -v nix >/dev/null || { echo "FAIL: nix not on PATH" >&2; exit 1; }
if [[ "$smoke" -eq 1 ]]; then
  command -v opencode >/dev/null || {
    echo "FAIL: opencode not on PATH; the smoke needs the v2 binary (use --no-smoke for unit+typecheck only)" >&2
    exit 1
  }
  opencode_version="$(opencode --version)"
  [[ "$opencode_version" == "opencode v2."* ]] || {
    echo "FAIL: $opencode_version is not opencode v2; the smoke needs the v2 binary" >&2
    exit 1
  }
fi

# --- phases ---------------------------------------------------------------------
fail=0
phase() {
  local label="$1"
  shift
  echo
  echo "=== $label ==="
  if nix develop -c "$@"; then
    echo "PASS: $label"
  else
    echo "FAIL: $label"
    fail=1
  fi
}

phase "unit tests (bun test)" bun test
phase "typecheck (tsc --noEmit)" bun run typecheck
if [[ "$smoke" -eq 1 ]]; then
  phase "smoke --scenario $scenario (end-to-end against opencode)" bun run smoke -- --scenario "$scenario"
fi

echo
if [[ "$fail" -eq 0 ]]; then
  echo "ALL PASS"
else
  echo "FAILURES: see the phases above"
  exit 1
fi
