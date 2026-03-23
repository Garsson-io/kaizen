## Host Configuration

Before running commands, read the host configuration from `kaizen.config.json`:
```bash
KAIZEN_REPO=$(jq -r '.kaizen.repo' kaizen.config.json)
HOST_REPO=$(jq -r '.host.repo' kaizen.config.json)
KAIZEN_CLI=$(jq -r '.host.caseCli // ""' kaizen.config.json)
ISSUE_BACKEND=$(jq -r '.issues.backend // "github"' kaizen.config.json)
```

**Issue routing — `$ISSUES_REPO`:**

Kaizen issue operations (list, view, edit, comment) must target the correct repo:
- **Self-dogfood** (`KAIZEN_REPO == HOST_REPO`): issues live in `$KAIZEN_REPO`, no extra label filter needed.
- **Host project** (`KAIZEN_REPO != HOST_REPO`): issues live in `$HOST_REPO` with the `kaizen` label.

Compute the derived variables:
```bash
if [ "$KAIZEN_REPO" = "$HOST_REPO" ]; then
  ISSUES_REPO="$KAIZEN_REPO"
  ISSUES_LABEL=""
else
  ISSUES_REPO="$HOST_REPO"
  ISSUES_LABEL="--label kaizen"
fi
```

Use `$ISSUES_REPO` (with `$ISSUES_LABEL` where filtering) for all kaizen issue operations.
Use `$HOST_REPO` for PR operations (PRs always target the host).
Use `$KAIZEN_REPO` only when explicitly filing meta-kaizen issues (issues about kaizen itself).

If `$KAIZEN_CLI` is empty, the host has no case system — use plain `git worktree add` for workspace isolation.

**Issue backend:** When `$ISSUE_BACKEND` is `"github"` (default), use `gh issue` commands directly. When it is `"custom"`, use `npx tsx src/issue-backend.ts` instead of `gh issue` — it routes to the configured backend CLI.
