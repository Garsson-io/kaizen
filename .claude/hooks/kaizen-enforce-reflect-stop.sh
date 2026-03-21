#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# enforce-kaizen-stop.sh — Level 2 kaizen enforcement (Issue #312)
# Stop hook: prevents Claude from finishing when a kaizen reflection
# gate (needs_pr_kaizen) is pending.
#
# This closes the gap where an agent can create a PR and stop without
# reflecting. The PreToolUse gate (enforce-pr-kaizen.sh) blocks commands,
# but the agent can still stop and end the session.
#
# Flow:
#   gh pr create/merge → kaizen-reflect.sh writes needs_pr_kaizen
#   → Agent tries to stop → THIS HOOK blocks
#   → Agent must submit KAIZEN_IMPEDIMENTS → pr-kaizen-clear.sh clears
#   → Agent can stop
#
# Uses branch-scoped lookup to prevent cross-worktree contamination.
#
# Exit 0 with no output = allow stop
# Exit 0 with JSON {"decision":"block","reason":"..."} = block stop

source "$(dirname "$0")/lib/state-utils.sh"

INPUT=$(cat)

# Find all pending kaizen reflection gates for the current branch
ALL_STATES=$(find_all_states_with_status "needs_pr_kaizen")
if [ $? -ne 0 ] || [ -z "$ALL_STATES" ]; then
  # No pending kaizen reflection — allow stop
  exit 0
fi

# Build PR list for the block message
PR_COUNT=$(echo "$ALL_STATES" | wc -l | tr -d ' ')
PR_LIST=""
while IFS='|' read -r url status; do
  PR_LIST="${PR_LIST}  - ${url}\n"
done <<< "$ALL_STATES"

if [ "$PR_COUNT" -eq 1 ]; then
  PR_HEADER="PR: $(echo "$ALL_STATES" | head -1 | cut -d'|' -f1)"
else
  PR_HEADER="${PR_COUNT} PRs pending reflection:\n${PR_LIST}"
fi

# Block stop: agent must complete kaizen reflection first.
REASON="STOP BLOCKED: Kaizen reflection is incomplete.

${PR_HEADER}

You MUST submit a KAIZEN_IMPEDIMENTS declaration before finishing:

  echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
  [{\"impediment\": \"description\", \"disposition\": \"filed\", \"ref\": \"#NNN\"}]
  IMPEDIMENTS

Or for no impediments: echo 'KAIZEN_IMPEDIMENTS: [] brief reason'

This is mandatory — every PR must have a structured reflection."

jq -n --arg reason "$REASON" '{ decision: "block", reason: $reason }'

exit 0
