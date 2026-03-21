#!/bin/bash
# Tests for kaizen-post-merge-clear.sh — PostToolUse hook that clears the post-merge
# workflow gate when /kaizen skill is invoked.
#
# INVARIANT UNDER TEST: The post-merge gate (needs_post_merge) is cleared
# when the agent invokes the /kaizen skill, and only then.
source "$(dirname "$0")/test-helpers.sh"

HOOK="$(dirname "$0")/../kaizen-post-merge-clear.sh"
setup_test_env

setup() { reset_state; }
teardown() { reset_state; }

run_skill_hook() {
  local skill_name="$1"
  local input
  input=$(jq -n --arg skill "$skill_name" '{
    tool_name: "Skill",
    tool_input: { skill: $skill },
    tool_response: {}
  }')
  echo "$input" | bash "$HOOK" 2>/dev/null
}

run_bash_hook() {
  local command="$1"
  local stdout="$2"
  local exit_code="${3:-0}"
  local input
  input=$(jq -n \
    --arg cmd "$command" \
    --arg out "$stdout" \
    --arg ec "$exit_code" '{
    tool_name: "Bash",
    tool_input: { command: $cmd },
    tool_response: { stdout: $out, stderr: "", exit_code: ($ec | tonumber) }
  }')
  echo "$input" | bash "$HOOK" 2>/dev/null
}

echo "=== /kaizen skill clears needs_post_merge state ==="

setup
create_post_merge_state "https://github.com/Garsson-io/kaizen/pull/42"

# Verify state exists
if [ -f "$STATE_DIR/post-merge-Garsson-io_kaizen_42" ]; then
  echo "  (setup) post-merge state file exists"
else
  echo "  FAIL: setup - state file not created"
  ((FAIL++))
fi

# INVARIANT: Invoking /kaizen clears the needs_post_merge state
# SUT: kaizen-post-merge-clear.sh Skill trigger
OUTPUT=$(run_skill_hook "kaizen-reflect")
if [ ! -f "$STATE_DIR/post-merge-Garsson-io_kaizen_42" ]; then
  echo "  PASS: /kaizen cleared post-merge state"
  ((PASS++))
else
  echo "  FAIL: /kaizen did NOT clear post-merge state"
  ((FAIL++))
fi

assert_contains "output mentions gate cleared" "gate cleared" "$OUTPUT"

echo ""
echo "=== Other skills do NOT clear post-merge state ==="

setup
create_post_merge_state "https://github.com/Garsson-io/kaizen/pull/42"

# INVARIANT: Non-kaizen skills do not clear post-merge state
# SUT: kaizen-post-merge-clear.sh skill name check
OUTPUT=$(run_skill_hook "review-pr")
if [ -f "$STATE_DIR/post-merge-Garsson-io_kaizen_42" ]; then
  echo "  PASS: /kaizen-review-pr did not clear post-merge state"
  ((PASS++))
else
  echo "  FAIL: /kaizen-review-pr incorrectly cleared post-merge state"
  ((FAIL++))
fi

echo ""
echo "=== /kaizen with no pending state is a no-op ==="

setup

# INVARIANT: /kaizen without pending state produces no output
# SUT: kaizen-post-merge-clear.sh with empty state
OUTPUT=$(run_skill_hook "kaizen-reflect")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: /kaizen with no pending state is silent"
  ((PASS++))
else
  echo "  FAIL: /kaizen produced output with no pending state"
  echo "    output: $OUTPUT"
  ((FAIL++))
fi

echo ""
echo "=== gh pr view confirming MERGED promotes awaiting_merge ==="

setup
create_post_merge_state "https://github.com/Garsson-io/kaizen/pull/42" "awaiting_merge"

# INVARIANT: When agent confirms merge via gh pr view showing MERGED,
# awaiting_merge is promoted to needs_post_merge
# SUT: kaizen-post-merge-clear.sh Bash trigger for merge confirmation
OUTPUT=$(run_bash_hook "gh pr view https://github.com/Garsson-io/kaizen/pull/42 --json state --jq .state" "MERGED")

# awaiting_merge should be cleared
AWAITING_COUNT=$(ls "$STATE_DIR"/ 2>/dev/null | grep -c "post-merge" || echo 0)
if [ "$AWAITING_COUNT" -gt 0 ]; then
  # Check that the new state is needs_post_merge
  NEW_STATUS=$(grep -h 'STATUS=' "$STATE_DIR"/post-merge-* 2>/dev/null | head -1 | cut -d= -f2-)
  if [ "$NEW_STATUS" = "needs_post_merge" ]; then
    echo "  PASS: awaiting_merge promoted to needs_post_merge"
    ((PASS++))
  else
    echo "  FAIL: state not promoted correctly (status=$NEW_STATUS)"
    ((FAIL++))
  fi
else
  echo "  FAIL: no post-merge state file found after promotion"
  ((FAIL++))
fi

assert_contains "output mentions merge confirmed" "merge confirmed" "$OUTPUT"

echo ""
echo "=== gh pr view with non-MERGED state does not promote ==="

setup
create_post_merge_state "https://github.com/Garsson-io/kaizen/pull/42" "awaiting_merge"

# INVARIANT: gh pr view showing OPEN does not promote awaiting_merge
# SUT: kaizen-post-merge-clear.sh MERGED detection
OUTPUT=$(run_bash_hook "gh pr view https://github.com/Garsson-io/kaizen/pull/42 --json state --jq .state" "OPEN")
CURRENT_STATUS=$(grep -h 'STATUS=' "$STATE_DIR"/post-merge-* 2>/dev/null | head -1 | cut -d= -f2-)
if [ "$CURRENT_STATUS" = "awaiting_merge" ]; then
  echo "  PASS: OPEN state does not promote awaiting_merge"
  ((PASS++))
else
  echo "  FAIL: OPEN state incorrectly changed status (status=$CURRENT_STATUS)"
  ((FAIL++))
fi

echo ""
echo "=== Failed Bash commands are ignored ==="

setup
create_post_merge_state "https://github.com/Garsson-io/kaizen/pull/42" "awaiting_merge"

# INVARIANT: Failed commands do not trigger state changes
# SUT: kaizen-post-merge-clear.sh exit code check
OUTPUT=$(run_bash_hook "gh pr view --json state" "error" "1")
CURRENT_STATUS=$(grep -h 'STATUS=' "$STATE_DIR"/post-merge-* 2>/dev/null | head -1 | cut -d= -f2-)
if [ "$CURRENT_STATUS" = "awaiting_merge" ]; then
  echo "  PASS: failed command does not change state"
  ((PASS++))
else
  echo "  FAIL: failed command changed state (status=$CURRENT_STATUS)"
  ((FAIL++))
fi

echo ""
echo "=== Cross-worktree isolation: /kaizen only clears own branch state ==="

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
setup
create_post_merge_state "https://github.com/Garsson-io/kaizen/pull/42" "needs_post_merge" "wt/other-branch"
create_post_merge_state "https://github.com/Garsson-io/kaizen/pull/43" "needs_post_merge" "$CURRENT_BRANCH"

# INVARIANT: /kaizen only clears state for the current branch
# SUT: kaizen-post-merge-clear.sh worktree isolation via clear_state_with_status
OUTPUT=$(run_skill_hook "kaizen-reflect")
# PR 42 (other branch) should still exist
if [ -f "$STATE_DIR/post-merge-Garsson-io_kaizen_42" ]; then
  echo "  PASS: other branch's state preserved"
  ((PASS++))
else
  echo "  FAIL: other branch's state was cleared"
  ((FAIL++))
fi
# PR 43 (our branch) should be cleared
if [ ! -f "$STATE_DIR/post-merge-Garsson-io_kaizen_43" ]; then
  echo "  PASS: own branch's state cleared"
  ((PASS++))
else
  echo "  FAIL: own branch's state NOT cleared"
  ((FAIL++))
fi

echo ""
echo "=== MERGED detection specificity (kaizen #172) ==="

# INVARIANT: Only actual MERGED state triggers promotion, not incidental
# occurrences of the word "MERGED" in other text.

setup
create_post_merge_state "https://github.com/Garsson-io/kaizen/pull/42" "awaiting_merge"

# False positive: text contains "MERGED" as a substring
OUTPUT=$(run_bash_hook "gh pr view https://github.com/Garsson-io/kaizen/pull/42 --json body" "This PR was NOT MERGED yet, it needs review")
CURRENT_STATUS=$(grep -h 'STATUS=' "$STATE_DIR"/post-merge-* 2>/dev/null | head -1 | cut -d= -f2-)
if [ "$CURRENT_STATUS" = "awaiting_merge" ]; then
  echo "  PASS: text containing 'NOT MERGED yet' does not promote"
  ((PASS++))
else
  echo "  FAIL: text containing 'NOT MERGED yet' incorrectly promoted"
  ((FAIL++))
fi

setup
create_post_merge_state "https://github.com/Garsson-io/kaizen/pull/42" "awaiting_merge"

# True positive: raw jq output "MERGED" on its own line
OUTPUT=$(run_bash_hook "gh pr view https://github.com/Garsson-io/kaizen/pull/42 --json state --jq .state" "MERGED")
CURRENT_STATUS=$(grep -h 'STATUS=' "$STATE_DIR"/post-merge-* 2>/dev/null | head -1 | cut -d= -f2-)
if [ "$CURRENT_STATUS" = "needs_post_merge" ]; then
  echo "  PASS: standalone 'MERGED' promotes correctly"
  ((PASS++))
else
  echo "  FAIL: standalone 'MERGED' did not promote (status=$CURRENT_STATUS)"
  ((FAIL++))
fi

setup
create_post_merge_state "https://github.com/Garsson-io/kaizen/pull/42" "awaiting_merge"

# True positive: JSON format with state field
OUTPUT=$(run_bash_hook "gh pr view https://github.com/Garsson-io/kaizen/pull/42 --json state" '{"state":"MERGED"}')
CURRENT_STATUS=$(grep -h 'STATUS=' "$STATE_DIR"/post-merge-* 2>/dev/null | head -1 | cut -d= -f2-)
if [ "$CURRENT_STATUS" = "needs_post_merge" ]; then
  echo "  PASS: JSON state:MERGED promotes correctly"
  ((PASS++))
else
  echo "  FAIL: JSON state:MERGED did not promote (status=$CURRENT_STATUS)"
  ((FAIL++))
fi

teardown
print_results

echo ""
echo "=== /kaizen clears ALL stacked post-merge states (kaizen #279) ==="

reset_state
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
create_post_merge_state "https://github.com/Garsson-io/kaizen/pull/200" "needs_post_merge" "$CURRENT_BRANCH"
create_post_merge_state "https://github.com/Garsson-io/kaizen/pull/201" "needs_post_merge" "$CURRENT_BRANCH"
create_post_merge_state "https://github.com/Garsson-io/kaizen/pull/202" "needs_post_merge" "$CURRENT_BRANCH"

OUTPUT=$(echo '{"tool_name":"Skill","tool_input":{"skill":"kaizen-reflect"},"tool_response":{}}' | bash "$HOOK" 2>/dev/null)
assert_contains "output mentions all pending PRs cleared" "all pending PRs" "$OUTPUT"

# Verify all states are cleared
REMAINING=$(find_all_states_with_status "needs_post_merge" 2>/dev/null)
assert_eq "all three post-merge states cleared" "" "$REMAINING"
