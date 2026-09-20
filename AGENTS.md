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
