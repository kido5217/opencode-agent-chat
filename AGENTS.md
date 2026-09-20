## Development environment

All development happens inside the Nix flake dev shell — never against the host toolchain.

- Enter it with `nix develop`, or run a one-off command with `nix develop -c <cmd>` (e.g. `nix develop -c bun test`).
- The shell pins the toolchain through `flake.nix` / `flake.lock`; add tooling there rather than to a host profile.
- The smoke scenarios also expect the `opencode2` binary on `PATH`; it is not provided by the shell.

## Git workflow

Correct workflow: branch → commit → PR → merge → pull (rebase).

- `main` is fully protected: direct pushes are blocked; every change lands through a PR.
- The LLM agent is allowed to create PRs and merge them.
- After the PR is merged, update local `main` with `git pull --rebase`.

## Agent skills

### Issue tracker

Issues live as GitHub issues in kido5217/opencode-agent-chat, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five-role default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: one `CONTEXT.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.
