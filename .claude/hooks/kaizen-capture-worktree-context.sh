#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# capture-worktree-context.sh — Write .worktree-context.json on PR creation
#
# PostToolUse hook on Bash: detects successful `gh pr create`, extracts the
# PR URL/number/title, and merges them into .worktree-context.json in the
# current worktree. This enables the /agents skill to show which PR each
# running agent is working on.
#
# Always exits 0 — advisory, not blocking.

source "$(dirname "$0")/lib/parse-command.sh"

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
STDOUT=$(echo "$INPUT" | jq -r '.tool_response.stdout // empty')
STDERR=$(echo "$INPUT" | jq -r '.tool_response.stderr // empty')
EXIT_CODE=$(echo "$INPUT" | jq -r '.tool_response.exit_code // "0"')

# Only trigger on successful commands
if [ "$EXIT_CODE" != "0" ]; then
  exit 0
fi

CMD_LINE=$(strip_heredoc_body "$COMMAND")

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
