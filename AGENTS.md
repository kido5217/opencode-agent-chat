## Development environment

All development happens inside the Nix flake dev shell — never against the host toolchain.

- Enter it with `nix develop`, or run a one-off command with `nix develop -c <cmd>` (e.g. `nix develop -c bun test`).
- The shell pins the toolchain through `flake.nix` / `flake.lock`; add tooling there rather than to a host profile.
- The smoke scenarios also expect the `opencode` binary on `PATH`; it is not provided by the shell.

## Git workflow

Correct workflow: branch → commit → PR → merge → pull (rebase).

- `main` is fully protected: direct pushes are blocked; every change lands through a PR.
- The LLM agent is allowed to create PRs and merge them.
- After the PR is merged, update local `main` with `git pull --rebase`.

## Evaluation gate

The eval is a hard local gate on **protocol text** — the injected agent-facing text: `docs/chat-protocol.md`, the chat tool descriptions (in `src/plugin.ts`), and `docs/task-design.md` (the set grows as new injected docs ship).

- A change to protocol text **must attach a local eval run** (`nix develop -c bun run smoke --scenario eval`, ~30–60 min, background it and watch the log) before merge. Non-text plugin changes run it on demand.
- **Data-quality RED** (fewer than 3 completed runs per arm per scenario) is not a text verdict: re-run once, then investigate infrastructure (timeouts, crashes, missing artifacts under `$XDG_DATA_HOME/opencode/eval/`).
- **Behavior RED** (an assertion over completed runs) means the text change does not land: iterate until green, or shelve with a recorded justification.
- **Judge dip** (advisory quality scores) is never a gate; read it first when a behavior red is confusing.
- At release, update `EVAL_BASELINE_REF` in `smoke/run.ts` to the new release tag. Changes to the eval instrument (scenarios, model, run budget) are release-level: they ship with a fresh baseline re-establishment run. See the README "Evaluation" section for the human-facing detail.

## Agent skills

### Issue tracker

Issues live as GitHub issues in kido5217/opencode-agent-chat, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five-role default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: one `CONTEXT.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.
