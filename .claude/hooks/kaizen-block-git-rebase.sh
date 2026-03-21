#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# block-git-rebase.sh — Level 2 rebase safety (kaizen #296)
# PreToolUse hook: blocks `git rebase` commands to prevent history rewriting.
#
# Rebase on PR branches:
#   - Destroys commit history (rewrites SHAs)
#   - Requires force-push (risky in multi-agent environments)
#   - Loses merge points (no record of conflict resolution)
#   - Can silently drop changes
#
# Safe alternative: `git merge origin/main` — preserves history, no force-push.
#
# Allowed recovery commands:
#   - git rebase --abort (undo accidental rebase)
#   - git rebase --continue (finish in-progress rebase)
#   - git rebase --skip (skip conflicting commit)

source "$(dirname "$0")/lib/parse-command.sh"

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if [ -z "$COMMAND" ]; then
  exit 0
fi

CMD_LINE=$(strip_heredoc_body "$COMMAND")

# Check each command segment for `git rebase` invocations.
# Uses segment splitting to catch piped/chained commands.
is_rebase_command() {
  local cmd="$1"
  # Split by pipe/chain operators and check each segment
  while IFS= read -r segment; do
    # Trim leading whitespace
    segment=$(echo "$segment" | sed 's/^[[:space:]]*//')
    # Skip empty segments, comments, and echo/printf commands
    [ -z "$segment" ] && continue
    echo "$segment" | grep -qE '^(#|echo |printf )' && continue
    # Match: git rebase, git -C <path> rebase
    if echo "$segment" | grep -qE '^git[[:space:]]+(-C[[:space:]]+[^[:space:]]+[[:space:]]+)?rebase'; then
      # Allow recovery commands: --abort, --continue, --skip
      if echo "$segment" | grep -qE 'rebase[[:space:]]+--(abort|continue|skip)'; then
        continue
      fi
      return 0
    fi
  done < <(echo "$cmd" | sed 's/[|;&]\{1,\}/\n/g')
  return 1
}

if ! is_rebase_command "$CMD_LINE"; then
  exit 0
fi

# Block the rebase command
jq -n \
  --arg reason "BLOCKED: git rebase is not allowed on PR branches (kaizen #296).

Rebase rewrites commit history and requires force-push, which is dangerous
in multi-agent environments. It can silently drop changes and loses the
merge point record.

Use merge instead:
  git fetch origin main && git merge origin/main

This preserves history, creates an explicit merge commit, and allows
normal push (no force-push needed).

Recovery commands are allowed:
  git rebase --abort     (undo accidental rebase)
  git rebase --continue  (finish in-progress rebase)
  git rebase --skip      (skip conflicting commit)" \
  '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'

exit 0
