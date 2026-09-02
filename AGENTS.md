## Agent skills

### Issue tracker

Issues and specs for this repo live as GitHub issues, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default canonical triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repo with root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.

### Script metadata

Userscript metadata (the `==UserScript==` header block) is manually managed. Agents must get explicit per-item approval before touching it. See `docs/agents/metadata.md`.

### Commit messages

Commits must use the Conventional Commits format.

### Site styles

Before adding CSS, inspect the current Bangumi site code for reusable styles. Reuse a suitable site style when one exists; write new CSS only after confirming that none fits.
