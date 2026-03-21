#!/bin/bash
# Tests for kaizen-enforce-reflect-stop.sh — Stop hook that blocks session stop
# when a PR kaizen reflection gate (needs_pr_kaizen) is pending.
#
# INVARIANT UNDER TEST: Agent cannot stop a session while a kaizen
# reflection is required. The gate is set by kaizen-reflect.sh on
# gh pr create/merge and cleared by kaizen-pr-reflect-clear.sh on
# KAIZEN_IMPEDIMENTS submission.
source "$(dirname "$0")/test-helpers.sh"

HOOK="$(dirname "$0")/../kaizen-enforce-reflect-stop.sh"
setup_test_env

setup() { reset_state; }
teardown() { reset_state; }

# Helper: create PR kaizen state file (same as enforce-pr-kaizen tests)
create_pr_kaizen_state() {
  local pr_url="$1"
  local branch="${2:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)}"
  local filename
  filename="pr-kaizen-$(echo "$pr_url" | sed 's|https://github\.com/||;s|/pull/|_|;s|/|_|g')"
  printf 'PR_URL=%s\nSTATUS=%s\nBRANCH=%s\n' \
    "$pr_url" "needs_pr_kaizen" "$branch" > "$STATE_DIR/$filename"
}

# Helper: run Stop hook
run_stop_hook() {
  echo '{}' | bash "$HOOK" 2>/dev/null
}

echo "=== No pending kaizen gate: stop allowed ==="

setup
OUTPUT=$(run_stop_hook)
if [ -z "$OUTPUT" ]; then
  echo "  PASS: no gate, stop allowed (empty output)"
  ((PASS++))
else
  echo "  FAIL: unexpected output when no gate: $OUTPUT"
  ((FAIL++))
fi

echo ""
echo "=== Pending kaizen gate on current branch: stop blocked ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/kaizen/pull/42"

OUTPUT=$(run_stop_hook)
if is_blocked "$OUTPUT"; then
  echo "  PASS: stop blocked with pending kaizen gate"
  ((PASS++))
else
  echo "  FAIL: stop NOT blocked with pending kaizen gate"
  echo "    output: $OUTPUT"
  ((FAIL++))
fi
assert_contains "mentions PR URL" "pull/42" "$OUTPUT"
assert_contains "mentions KAIZEN_IMPEDIMENTS" "KAIZEN_IMPEDIMENTS" "$OUTPUT"

echo ""
echo "=== Pending kaizen gate on different branch: stop NOT blocked ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/kaizen/pull/42" "wt/other-branch"

# INVARIANT: Stop hooks use branch-scoped lookup to prevent cross-worktree
# contamination. A gate from another worktree should not block this one.
OUTPUT=$(run_stop_hook)
if [ -z "$OUTPUT" ]; then
  echo "  PASS: cross-branch gate does not block stop"
  ((PASS++))
else
  echo "  FAIL: cross-branch gate incorrectly blocks stop"
  echo "    output: $OUTPUT"
  ((FAIL++))
fi

echo ""
echo "=== Multiple pending kaizen gates: stop blocked with all PRs shown ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/kaizen/pull/10"
create_pr_kaizen_state "https://github.com/Garsson-io/kaizen/pull/20"

OUTPUT=$(run_stop_hook)
if is_blocked "$OUTPUT"; then
  echo "  PASS: stop blocked with multiple pending gates"
  ((PASS++))
else
  echo "  FAIL: stop NOT blocked with multiple pending gates"
  ((FAIL++))
fi
assert_contains "mentions first PR" "pull/10" "$OUTPUT"
assert_contains "mentions second PR" "pull/20" "$OUTPUT"

echo ""
echo "=== Stale kaizen gate: stop allowed ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/kaizen/pull/42"
# Backdate the state file beyond MAX_STATE_AGE (2 hours)
backdate_file "$STATE_DIR/pr-kaizen-Garsson-io_kaizen_42" 3

OUTPUT=$(run_stop_hook)
if [ -z "$OUTPUT" ]; then
  echo "  PASS: stale gate does not block stop"
  ((PASS++))
else
  echo "  FAIL: stale gate incorrectly blocks stop"
  ((FAIL++))
fi

echo ""
echo "=== Legacy state file without BRANCH: stop NOT blocked ==="

setup
# Legacy state files without BRANCH field should be ignored
printf 'PR_URL=https://github.com/Garsson-io/kaizen/pull/99\nSTATUS=needs_pr_kaizen\n' \
  > "$STATE_DIR/pr-kaizen-legacy"

OUTPUT=$(run_stop_hook)
if [ -z "$OUTPUT" ]; then
  echo "  PASS: legacy state without BRANCH ignored"
  ((PASS++))
else
  echo "  FAIL: legacy state without BRANCH incorrectly blocks"
  ((FAIL++))
fi

teardown
print_results
