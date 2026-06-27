#!/bin/bash
# Part of kAIzen Agent Control Flow — see .agents/kaizen/README.md
# capture-worktree-context.sh — Record run/PR context onto a worktree.
#
# PostToolUse hook on Bash. Two responsibilities at the worktree choke points:
#   - `git worktree add case/*`: stamp `kaizen.runtag` on the new worktree so the
#     auto-dent rescue finalizer can attribute stranded work to its run (#1270).
#   - `gh pr create`: extract the PR URL/number/title and merge them into
#     .worktree-context.json so the /agents skill can show each agent's PR.
#
# Always exits 0 — advisory, not blocking.

source "$(dirname "$0")/lib/parse-command.sh" 2>/dev/null || { exit 0; }

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
STDOUT=$(echo "$INPUT" | jq -r '.tool_response.stdout // empty')
STDERR=$(echo "$INPUT" | jq -r '.tool_response.stderr // empty')
EXIT_CODE=$(echo "$INPUT" | jq -r '.tool_response.exit_code // "0"')

# Only trigger on successful commands
if [ "$EXIT_CODE" != "0" ]; then
  exit 0
fi

source "$(dirname "$0")/lib/scope-guard.sh"
source "$(dirname "$0")/lib/hook-telemetry.sh" 2>/dev/null || true

CMD_LINE=$(strip_heredoc_body "$COMMAND")

# #1270: stamp run attribution on a freshly-created case worktree.
#
# When an auto-dent run creates a `case/*` worktree (`git worktree add`), record
# THIS run's tag on the new worktree via `git config --worktree kaizen.runtag`.
# That durable, run-scoped signal lets the rescue finalizer recover work stranded
# *before* the IMPLEMENT stream marker is emitted (crash/SIGKILL) — the
# crash-before-marker gap that forces manual `[rescue]` PRs. Writing --worktree
# scope is concurrency-safe (it cannot clobber a sibling worktree's binding).
#
# Only acts when KAIZEN_RUN_TAG is present (set by the auto-dent runner) and the
# created worktree is on a `case/*` branch. A non-case worktree, or a session
# with no run tag, is left untouched.
if [ -n "$KAIZEN_RUN_TAG" ] && is_git_command "$CMD_LINE" "worktree"; then
  # The kaizen case-worktree path always lives under `.claude/worktrees/`; pull
  # that token out of the command rather than flag-parsing positional args.
  WT_PATH=$(printf '%s\n' "$CMD_LINE" | tr ' \t' '\n\n' | grep -m1 '\.claude/worktrees/' || true)
  if [ -n "$WT_PATH" ] && [ -d "$WT_PATH" ]; then
    WT_BRANCH=$(git -C "$WT_PATH" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
    case "$WT_BRANCH" in
      case/*)
        git -C "$WT_PATH" config extensions.worktreeConfig true 2>/dev/null || true
        if git -C "$WT_PATH" config --worktree kaizen.runtag "$KAIZEN_RUN_TAG" 2>/dev/null; then
          echo "kaizen-capture-worktree-context: 🏷️  Stamped kaizen.runtag=$KAIZEN_RUN_TAG on $WT_BRANCH (rescue attribution)." >&2
        fi
        ;;
    esac
  fi
  exit 0
fi

# Only trigger on gh pr create
if ! is_gh_pr_command "$CMD_LINE" "create"; then
  exit 0
fi

# Extract PR URL using the shared fallback chain
PR_URL=$(reconstruct_pr_url "$CMD_LINE" "$STDOUT" "$STDERR" "create")
if [ -z "$PR_URL" ]; then
  exit 0
fi

# Extract PR number and title from URL and stdout
PR_NUM=$(echo "$PR_URL" | grep -oE '[0-9]+$')

# Try to get PR title from gh pr view (fast, cached)
PR_TITLE=""
PR_REPO=$(echo "$PR_URL" | sed -n 's|https://github.com/\([^/]*/[^/]*\)/pull/.*|\1|p')
if [ -n "$PR_NUM" ] && [ -n "$PR_REPO" ]; then
  PR_TITLE=$(gh pr view "$PR_NUM" --repo "$PR_REPO" --json title --jq '.title' 2>/dev/null || true)
fi

# Find .worktree-context.json in the current directory (worktree root)
CONTEXT_FILE=".worktree-context.json"

# Build new PR fields as JSON
PR_JSON=$(jq -n --arg pr_num "$PR_NUM" \
                --arg pr_url "$PR_URL" \
                --arg pr_title "$PR_TITLE" \
                '{pr_number: ($pr_num | tonumber), pr_url: $pr_url} + (if $pr_title != "" then {pr_title: $pr_title} else {} end)')

# Read existing context (if valid JSON), merge, and write back
EXISTING="{}"
if [ -f "$CONTEXT_FILE" ] && [ -s "$CONTEXT_FILE" ]; then
  EXISTING=$(jq '.' "$CONTEXT_FILE" 2>/dev/null || echo "{}")
fi

echo "$EXISTING" | jq --argjson pr "$PR_JSON" '. + $pr' > "${CONTEXT_FILE}.tmp" 2>/dev/null && \
  mv "${CONTEXT_FILE}.tmp" "$CONTEXT_FILE"

exit 0
