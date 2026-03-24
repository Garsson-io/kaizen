## Host Configuration

Before running commands, read the host configuration from `kaizen.config.json`:
```bash
KAIZEN_REPO=$(jq -r '.kaizen.repo' kaizen.config.json)
HOST_REPO=$(jq -r '.host.repo' kaizen.config.json)
ISSUES_REPO=$(jq -r '.issues.repo // .host.repo' kaizen.config.json)
ISSUES_LABEL=$(jq -r '.issues.label // ""' kaizen.config.json)
KAIZEN_CLI=$(jq -r '.host.caseCli // ""' kaizen.config.json)
ISSUE_BACKEND=$(jq -r '.issues.backend // "github"' kaizen.config.json)
```

**Issue routing:** `$ISSUES_REPO` and `$ISSUES_LABEL` are read directly from `kaizen.config.json` — no derivation needed.
- In self-dogfood mode: `issues.repo` equals `kaizen.repo`, `issues.label` is empty.
- In host project mode: `issues.repo` equals `host.repo`, `issues.label` is `"kaizen"`.
- The `kaizen-setup` command sets these automatically.

Use `$ISSUES_REPO` for all kaizen issue operations. When `$ISSUES_LABEL` is non-empty, add `--label "$ISSUES_LABEL"` to `gh issue list` commands.
Use `$HOST_REPO` for PR operations (PRs always target the host).
Use `$KAIZEN_REPO` only when explicitly filing meta-kaizen issues (issues about kaizen itself).

If `$KAIZEN_CLI` is empty, the host has no case system — use plain `git worktree add` for workspace isolation.

**Issue backend:** When `$ISSUE_BACKEND` is `"github"` (default), use `gh issue` commands directly. When it is `"custom"`, use `npx tsx src/issue-backend.ts` instead of `gh issue` — it routes to the configured backend CLI.
