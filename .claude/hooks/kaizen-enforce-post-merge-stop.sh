#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# enforce-post-merge-stop.sh — Level 2 kaizen enforcement (Issue #96, #279)
# Stop hook: prevents Claude from finishing when post-merge steps are pending.
#
# After a PR is merged, the agent MUST complete:
#   1. Kaizen reflection (run /kaizen skill)
#   2. Case closure (mark case done if applicable)
#   3. Main sync (git fetch + merge origin/main)
#
# Flow:
#   gh pr merge → pr-review-loop.sh writes STATUS=needs_post_merge
#   → Agent tries to stop → THIS HOOK blocks
#   → Agent runs /kaizen → post-merge-clear.sh clears ALL states
#   → Agent can stop
#
# Stacked PRs (kaizen #279): When multiple PRs merge in one session,
# this hook shows ALL pending PRs, not just the first. Running /kaizen
# once clears all of them.
#
# Exit 0 with no output = allow stop
# Exit 0 with JSON {"decision":"block","reason":"..."} = block stop

source "$(dirname "$0")/lib/state-utils.sh"
source "$(dirname "$0")/lib/resolve-main-checkout.sh"

INPUT=$(cat)

# Check for ALL pending post-merge workflows (kaizen #279)
ALL_STATES=$(find_all_states_with_status "needs_post_merge")
if [ $? -ne 0 ] || [ -z "$ALL_STATES" ]; then
  # No pending post-merge steps — allow stop
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

# Block stop: agent must complete post-merge workflow first.
REASON="STOP BLOCKED: Post-merge workflow is incomplete.

${PR_HEADER}
You MUST complete these steps before finishing:

1. Run \`/kaizen\` — reflect on impediments, what you'd do differently, process friction
   (One /kaizen invocation clears ALL pending post-merge gates)
2. Mark the case as done (if a case exists for this work)
3. Sync main: \`git -C $MAIN_CHECKOUT fetch origin main && git -C $MAIN_CHECKOUT merge origin/main --no-edit\`
4. Update linked kaizen issue if applicable

The /kaizen skill will clear this gate when complete."

jq -n --arg reason "$REASON" '{ decision: "block", reason: $reason }'

exit 0
