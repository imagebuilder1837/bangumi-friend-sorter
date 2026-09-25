## Agent skills

### Issue tracker

Issues and specs for this repo live as GitHub issues, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default canonical triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repo with root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.

### Source navigation and delivery

For behavior changes, consult `docs/module-guide.md` and read the relevant maintained source. Do not load the whole generated `src/index.user.js` by default; inspect targeted parts only for build debugging, review, or artifact acceptance. Before every commit, run `npm run check` on the final change state; fix failures and rerun before committing.

### Script metadata

Userscript metadata (the `==UserScript==` header block) is manually managed. Agents must get explicit per-item approval before touching it. See `docs/agents/metadata.md`.

### Commit messages

Commits must use the Conventional Commits format.

### Site styles

Before adding CSS, inspect the current Bangumi site code for reusable styles. Reuse a suitable site style when one exists; write new CSS only after confirming that none fits.
