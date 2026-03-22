## Host Configuration

Before running commands, read the host configuration from `kaizen.config.json`:
```bash
KAIZEN_REPO=$(jq -r '.kaizen.repo' kaizen.config.json)
HOST_REPO=$(jq -r '.host.repo' kaizen.config.json)
KAIZEN_CLI=$(jq -r '.host.caseCli // ""' kaizen.config.json)
ISSUE_BACKEND=$(jq -r '.issues.backend // "github"' kaizen.config.json)
```
Use `$KAIZEN_REPO` in kaizen issue operations, `$HOST_REPO` in host project operations.
If `$KAIZEN_CLI` is empty, the host has no case system — use plain `git worktree add` for workspace isolation.

**Issue backend:** When `$ISSUE_BACKEND` is `"github"` (default), use `gh issue` commands directly. When it is `"custom"`, use `npx tsx src/issue-backend.ts` instead of `gh issue` — it routes to the configured backend CLI.
