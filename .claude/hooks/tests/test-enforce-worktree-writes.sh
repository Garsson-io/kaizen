#!/bin/bash
# Tests for kaizen-enforce-worktree-writes.sh — PreToolUse hook that blocks source
# code writes in the main checkout on the main branch.
#
# INVARIANT UNDER TEST: Source code files are blocked on main checkout + main
# branch. Runtime/config directories (.claude/, groups/, data/, store/, logs/)
# are always allowed.
#
# Note: These tests can only run fully when executed in the main checkout on
# main branch. When run in a worktree, the hook allows everything (by design).

source "$(dirname "$0")/test-helpers.sh"

HOOK="$(dirname "$0")/../kaizen-enforce-worktree-writes.sh"

# Helper: run the hook with a file_path in the Edit tool input
run_edit_hook() {
  local file_path="$1"
  local input
  input=$(jq -n --arg fp "$file_path" '{"tool_input":{"file_path":$fp}}')
  echo "$input" | bash "$HOOK" 2>/dev/null
}

# Detect if we're in main checkout on main branch
GIT_COMMON=$(git rev-parse --git-common-dir 2>/dev/null)
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
TOPLEVEL=$(git rev-parse --show-toplevel 2>/dev/null)

echo "=== Runtime directories always allowed ==="

# These should pass regardless of checkout type
for dir in ".claude/settings.json" ".claude/kaizen/hooks/test.sh" \
           "groups/telegram_garsson/CLAUDE.md" "data/ipc/main/messages/msg.json" \
           "store/messages.db" "logs/app.log"; do
  OUTPUT=$(run_edit_hook "$TOPLEVEL/$dir")
  assert_eq "allowed: $dir" "" "$OUTPUT"
done

echo ""
echo "=== .claude/worktrees/ path allowed ==="

OUTPUT=$(run_edit_hook "$TOPLEVEL/.claude/worktrees/260319/src/index.ts")
assert_eq "worktrees path allowed" "" "$OUTPUT"

echo ""
echo "=== Empty file path handled gracefully ==="

OUTPUT=$(run_edit_hook "")
assert_eq "empty path allowed" "" "$OUTPUT"

echo ""
echo "=== Files outside the repo allowed ==="

OUTPUT=$(run_edit_hook "/tmp/some-random-file.ts")
assert_eq "external file allowed" "" "$OUTPUT"

if [ "$GIT_COMMON" = ".git" ] && [ "$CURRENT_BRANCH" = "main" ]; then
  echo ""
  echo "=== Source files blocked on main checkout + main branch ==="

  for file in "src/index.ts" "container/Dockerfile" "package.json" "tsconfig.json"; do
    OUTPUT=$(run_edit_hook "$TOPLEVEL/$file")
    if is_denied "$OUTPUT"; then
      echo "  PASS: blocked: $file"
      ((PASS++))
    else
      echo "  FAIL: NOT blocked: $file"
      ((FAIL++))
    fi
  done

  echo ""
  echo "=== Block message is informative ==="

  OUTPUT=$(run_edit_hook "$TOPLEVEL/src/index.ts")
  assert_contains "mentions worktree" "worktree" "$OUTPUT"
  assert_contains "mentions main checkout" "main checkout" "$OUTPUT"
else
  echo ""
  echo "=== (Skipping main-checkout-only tests: not on main checkout + main branch) ==="
  echo "  GIT_COMMON=$GIT_COMMON BRANCH=$CURRENT_BRANCH"
fi

print_results
