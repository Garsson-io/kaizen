#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# post-merge-clear.sh — Level 2 kaizen enforcement (Issue #96)
# PostToolUse hook on Skill: clears the post-merge gate when /kaizen is invoked.
#
# The gate is set by pr-review-loop.sh on merge (STATUS=needs_post_merge).
# This hook fires when the agent invokes the /kaizen skill, which satisfies
# the reflection requirement.
#
# Also fires on Bash to detect `gh pr view` confirming a merge completed
# (handles the --auto timing issue from kaizen #93). When an agent uses
# `gh pr merge --auto`, the actual merge happens later. The checklist should
# fire when the agent confirms the merge, not on the --auto command.
#
# Always exits 0 — this is a state management hook, not a gate.

source "$(dirname "$0")/lib/state-utils.sh"
source "$(dirname "$0")/lib/parse-command.sh"
source "$(dirname "$0")/lib/resolve-main-checkout.sh"

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Trigger 1: Skill tool invoked with /kaizen
if [ "$TOOL_NAME" = "Skill" ]; then
  SKILL_NAME=$(echo "$INPUT" | jq -r '.tool_input.skill // empty')
  if [ "$SKILL_NAME" = "kaizen" ]; then
    # Clear ALL pending post-merge states at once (kaizen #279).
    # One /kaizen invocation covers all PRs merged in this session.
    if clear_all_states_with_status "needs_post_merge"; then
      cat <<EOF

Post-merge gate cleared (all pending PRs). The /kaizen reflection satisfies the post-merge workflow requirement.

Remember to also:
- Mark the case as done (if applicable)
- Sync main: \`git -C $MAIN_CHECKOUT fetch origin main && git -C $MAIN_CHECKOUT merge origin/main --no-edit\`
- Update linked kaizen issue
EOF
    fi
  fi
  exit 0
fi

# Trigger 2: Bash — detect gh pr view showing MERGED state (handles --auto timing, kaizen #93)
if [ "$TOOL_NAME" = "Bash" ]; then
  COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
  STDOUT=$(echo "$INPUT" | jq -r '.tool_response.stdout // empty')
  EXIT_CODE=$(echo "$INPUT" | jq -r '.tool_response.exit_code // "0"')

  if [ "$EXIT_CODE" != "0" ]; then
    exit 0
  fi

  CMD_LINE=$(strip_heredoc_body "$COMMAND")

  # Detect gh pr view that shows MERGED state — this is the confirmation
  # that an --auto merge actually completed
  if is_gh_pr_command "$CMD_LINE" "view"; then
    # Tightened MERGED detection (kaizen #172): match only as a standalone value,
    # not as a substring of other text. Handles both raw "MERGED" (from --jq .state)
    # and JSON "state":"MERGED" formats.
    if echo "$STDOUT" | grep -qE '(^MERGED$|"state"[[:space:]]*:[[:space:]]*"MERGED"|^"MERGED"$)'; then
      # Check if we have an awaiting_merge state to promote
      STATE_INFO=$(find_state_with_status "awaiting_merge")
      if [ $? -eq 0 ] && [ -n "$STATE_INFO" ]; then
        PR_URL=$(echo "$STATE_INFO" | cut -d'|' -f1)
        # Clear the awaiting_merge state
        clear_state_with_status "awaiting_merge"
        # Write the actual post-merge state now that merge is confirmed
        MERGE_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
        STATE_FILE="$STATE_DIR/post-merge-$(pr_url_to_state_key "$PR_URL")"
        printf 'PR_URL=%s\nSTATUS=%s\nBRANCH=%s\n' "$PR_URL" "needs_post_merge" "$MERGE_BRANCH" > "$STATE_FILE"
        chmod 600 "$STATE_FILE" 2>/dev/null

        cat <<EOF

🎉 PR merge confirmed: $PR_URL

Now complete the post-merge workflow:
1. **Kaizen reflection (REQUIRED)** — Run \`/kaizen\` NOW to reflect on impediments and process friction
2. **Mark case done** — if a case exists for this work
3. **Sync main** — \`git -C $MAIN_CHECKOUT fetch origin main && git -C $MAIN_CHECKOUT merge origin/main --no-edit\`
4. **Update linked issue** — close the kaizen/tracking issue with lessons learned

⛔ You will NOT be able to finish until /kaizen is run.
EOF
      fi
    fi
  fi
fi

exit 0
