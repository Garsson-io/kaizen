#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# squash-merge-safety.sh — Level 2 squash merge safety (kaizen #289)
# PreToolUse hook: before `gh pr merge --squash`, compares branch diff-stat
# with squash preview to detect files silently dropped during squash.
#
# Problem: GitHub's squash merge combines all commits. If intermediate commits
# add files that are later modified, or if the squash resolution is wrong,
# files can be silently lost. There's no built-in check.
#
# This hook:
#   1. Detects `gh pr merge --squash` commands
#   2. Skips single-commit PRs (no squash risk)
#   3. Compares branch files (git diff) with squash preview (gh pr diff)
#   4. Blocks if files in the branch are missing from the squash
#
# Always allows non-squash merges, non-gh commands, and single-commit PRs.

source "$(dirname "$0")/lib/parse-command.sh"

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if [ -z "$COMMAND" ]; then
  exit 0
fi

CMD_LINE=$(strip_heredoc_body "$COMMAND")

# Only check squash merges
if ! is_gh_pr_command "$CMD_LINE" "merge"; then
  exit 0
fi

# Check for --squash flag
if ! echo "$CMD_LINE" | grep -q '\-\-squash'; then
  exit 0
fi

# Extract PR number and repo
PR_NUM=$(extract_pr_number "$CMD_LINE" "merge")
REPO_FLAG=$(extract_repo_flag "$CMD_LINE")
REPO_ARGS=""
if [ -n "$REPO_FLAG" ]; then
  REPO_ARGS="--repo $REPO_FLAG"
fi

# Check commit count — single-commit PRs have no squash risk
COMMIT_COUNT=""
if [ -n "$PR_NUM" ]; then
  COMMIT_COUNT=$(gh pr view "$PR_NUM" $REPO_ARGS --json commits --jq '.commits.totalCount' 2>/dev/null)
elif [ -n "$REPO_ARGS" ]; then
  COMMIT_COUNT=$(gh pr view $REPO_ARGS --json commits --jq '.commits.totalCount' 2>/dev/null)
fi

if [ -n "$COMMIT_COUNT" ] && [ "$COMMIT_COUNT" -le 1 ] 2>/dev/null; then
  exit 0
fi

# Get files from branch diff (local)
BRANCH_FILES=$(git diff --name-only main...HEAD 2>/dev/null | sort)

# Get files from squash preview (GitHub)
SQUASH_FILES=""
if [ -n "$PR_NUM" ]; then
  SQUASH_FILES=$(gh pr diff "$PR_NUM" $REPO_ARGS --name-only 2>/dev/null | sort)
else
  SQUASH_FILES=$(gh pr diff $REPO_ARGS --name-only 2>/dev/null | sort)
fi

# If either is empty, skip the check (can't compare)
if [ -z "$BRANCH_FILES" ] || [ -z "$SQUASH_FILES" ]; then
  exit 0
fi

# Find files in branch but NOT in squash (potentially dropped)
MISSING_FILES=$(comm -23 <(echo "$BRANCH_FILES") <(echo "$SQUASH_FILES"))

if [ -z "$MISSING_FILES" ]; then
  exit 0
fi

# Count missing files
MISSING_COUNT=$(echo "$MISSING_FILES" | wc -l)

# Block with warning
jq -n \
  --arg reason "$(cat <<REASON
WARNING: Squash merge may silently drop $MISSING_COUNT file(s) (kaizen #289).

Files present in branch diff but missing from squash preview:
$(echo "$MISSING_FILES" | sed 's/^/  - /')

This can happen when intermediate commits add files that are modified or
removed in later commits. The squash combines all changes, potentially
losing additions.

To proceed safely:
  1. Check if these files should be in the final squash
  2. If they should exist, ensure they're committed on the branch
  3. If they were intentionally removed, this warning is safe to ignore —
     re-run the merge command and the check will pass

To skip this check: remove --squash and use --merge instead
REASON
)" \
  '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'

exit 0
