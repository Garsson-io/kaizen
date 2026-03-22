---
name: kaizen-wip
description: Search for in-progress work — worktrees, open PRs, dirty branches, active cases. Triggers on "wip", "in progress", "what's open", "existing work".
---

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

# /wip — Find In-Progress Work

Search all sources of in-progress work and present a summary to the user.

## Procedure

Run ALL of the following checks in parallel:

### 1. Git Worktrees
```bash
git worktree list
```
For each worktree (excluding the main checkout), check:
```bash
git -C <worktree_path> log --oneline -3
git -C <worktree_path> status --short
git -C <worktree_path> log --oneline @{upstream}..HEAD 2>/dev/null  # unpushed commits
```

### 2. Open Pull Requests
```bash
gh pr list --repo "$HOST_REPO" --state open --json number,title,headBranch,state,updatedAt,url
```

### 3. Local Branches with Unpushed Work
```bash
git branch --no-merged main
```

### 4. Stale Local Branches (merged but not deleted)
```bash
git branch --merged main | grep -v '^\*\|main$'
```

### 5. Active Cases with Kaizen Issue Links
Query active/backlog cases linked to GitHub issues via the domain model CLI:
```bash
$KAIZEN_CLI case-list --status suggested,backlog,active,blocked
```

## Output Format

Present a concise summary table:

```
## In-Progress Work

### Worktrees (N)
| Worktree | Branch | Status | Unpushed |
|----------|--------|--------|----------|
| ...      | ...    | clean/dirty (N files) | N commits |

### Open PRs (N)
| # | Title | Branch | Updated |
|---|-------|--------|---------|
| ...

### Unmerged Branches (N)
- branch-name (N ahead of main)

### Cleanup Candidates
- branch-name (already merged, can delete)

### Kaizen Issues with Active Cases
| Kaizen # | Case | Status |
|----------|------|--------|
| #N       | YYMMDD-HHMM-case-name | active/backlog/blocked |
```

If any section has zero items, still show it with "None" to confirm it was checked.

## Recommendations

After presenting the summary, suggest actions:
- For dirty worktrees: "Consider committing or stashing changes in X"
- For stale branches: "These are merged and can be cleaned up with `git branch -d <name>`"
- For orphaned worktrees (no corresponding PR): flag them
- For open PRs: note if the local branch is behind remote
