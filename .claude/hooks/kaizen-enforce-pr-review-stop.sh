#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# enforce-pr-review-stop.sh — Level 3 kaizen enforcement (Issue #46)
# Stop hook: prevents Claude from finishing its response when a PR review is pending.
#
# This closes the critical gap in the review enforcement system:
#   1. PostToolUse (pr-review-loop.sh) writes STATUS=needs_review after gh pr create
#   2. PreToolUse (enforce-pr-review.sh) blocks non-review Bash commands
#   3. THIS HOOK blocks Claude from stopping — forcing it to start the review
#
# Without this hook, Claude can respond "PR created: <url>" and stop, never
# triggering any PreToolUse hooks. The review would only happen if the user
# explicitly asked for it.
#
# Flow after fix:
#   gh pr create → PostToolUse writes needs_review → Claude tries to stop
#   → THIS HOOK blocks stop → Claude must call a tool → PreToolUse funnels
#   to gh pr diff → PostToolUse sets passed → Claude can stop
#
# Exit 0 with no output = allow stop
# Exit 0 with JSON {"decision":"block","reason":"..."} = block stop

source "$(dirname "$0")/lib/state-utils.sh"
source "$(dirname "$0")/lib/input-utils.sh"
source "$(dirname "$0")/lib/hook-output.sh"

read_hook_input

# Uses shared find_needs_review_state from state-utils.sh
REVIEW_INFO=$(find_needs_review_state)
if [ $? -ne 0 ] || [ -z "$REVIEW_INFO" ]; then
  # No pending review — allow stop
  exit 0
fi

source "$(dirname "$0")/lib/scope-guard.sh"

PR_URL=$(echo "$REVIEW_INFO" | cut -d'|' -f1)
ROUND=$(echo "$REVIEW_INFO" | cut -d'|' -f2)

# Block stop: agent must review the PR first.
REASON=$(render_prompt "pr-review-block.md" \
  "PR_URL=$PR_URL" \
  "ROUND=$ROUND")

emit_stop_block "$REASON"
