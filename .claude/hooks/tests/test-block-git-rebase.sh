#!/bin/bash
# Tests for kaizen-block-git-rebase.sh (kaizen #296)
#
# INVARIANT UNDER TEST: `git rebase` commands on PR branches are blocked.
# `git rebase --abort` is always allowed (recovery path).
# `git merge origin/main` is always allowed (safe alternative).
# Non-rebase git commands are not affected.
source "$(dirname "$0")/test-helpers.sh"

HOOK="$(dirname "$0")/../kaizen-block-git-rebase.sh"

# ============================================================
# Blocked commands (git rebase variants)
# ============================================================

echo "=== git rebase origin/main is BLOCKED ==="

OUTPUT=$(run_hook "$HOOK" "git rebase origin/main")
if is_denied "$OUTPUT"; then
  echo "  PASS: git rebase origin/main blocked"
  ((PASS++))
else
  echo "  FAIL: git rebase origin/main not blocked"
  echo "    output: $OUTPUT"
  ((FAIL++))
fi
assert_contains "suggests merge alternative" "git merge" "$OUTPUT"

echo ""
echo "=== git rebase main is BLOCKED ==="

OUTPUT=$(run_hook "$HOOK" "git rebase main")
if is_denied "$OUTPUT"; then
  echo "  PASS: git rebase main blocked"
  ((PASS++))
else
  echo "  FAIL: git rebase main not blocked"
  ((FAIL++))
fi

echo ""
echo "=== git rebase -i HEAD~3 is BLOCKED ==="

OUTPUT=$(run_hook "$HOOK" "git rebase -i HEAD~3")
if is_denied "$OUTPUT"; then
  echo "  PASS: git rebase -i blocked"
  ((PASS++))
else
  echo "  FAIL: git rebase -i not blocked"
  ((FAIL++))
fi

echo ""
echo "=== git rebase --onto is BLOCKED ==="

OUTPUT=$(run_hook "$HOOK" "git rebase --onto main feature")
if is_denied "$OUTPUT"; then
  echo "  PASS: git rebase --onto blocked"
  ((PASS++))
else
  echo "  FAIL: git rebase --onto not blocked"
  ((FAIL++))
fi

echo ""
echo "=== git -C /path rebase origin/main is BLOCKED ==="

OUTPUT=$(run_hook "$HOOK" "git -C /some/path rebase origin/main")
if is_denied "$OUTPUT"; then
  echo "  PASS: git -C rebase blocked"
  ((PASS++))
else
  echo "  FAIL: git -C rebase not blocked"
  ((FAIL++))
fi

echo ""
echo "=== piped rebase is BLOCKED (segment splitting) ==="

OUTPUT=$(run_hook "$HOOK" "echo 'hello' && git rebase origin/main")
if is_denied "$OUTPUT"; then
  echo "  PASS: piped rebase blocked"
  ((PASS++))
else
  echo "  FAIL: piped rebase not blocked"
  ((FAIL++))
fi

# ============================================================
# Allowed commands (recovery and safe alternatives)
# ============================================================

echo ""
echo "=== git rebase --abort is ALLOWED ==="

OUTPUT=$(run_hook "$HOOK" "git rebase --abort")
if ! is_denied "$OUTPUT"; then
  echo "  PASS: git rebase --abort allowed"
  ((PASS++))
else
  echo "  FAIL: git rebase --abort incorrectly blocked"
  ((FAIL++))
fi

echo ""
echo "=== git rebase --continue is ALLOWED ==="

OUTPUT=$(run_hook "$HOOK" "git rebase --continue")
if ! is_denied "$OUTPUT"; then
  echo "  PASS: git rebase --continue allowed"
  ((PASS++))
else
  echo "  FAIL: git rebase --continue incorrectly blocked"
  ((FAIL++))
fi

echo ""
echo "=== git rebase --skip is ALLOWED ==="

OUTPUT=$(run_hook "$HOOK" "git rebase --skip")
if ! is_denied "$OUTPUT"; then
  echo "  PASS: git rebase --skip allowed"
  ((PASS++))
else
  echo "  FAIL: git rebase --skip incorrectly blocked"
  ((FAIL++))
fi

echo ""
echo "=== git merge origin/main is ALLOWED ==="

OUTPUT=$(run_hook "$HOOK" "git merge origin/main")
if ! is_denied "$OUTPUT"; then
  echo "  PASS: git merge allowed"
  ((PASS++))
else
  echo "  FAIL: git merge incorrectly blocked"
  ((FAIL++))
fi

echo ""
echo "=== git push is ALLOWED ==="

OUTPUT=$(run_hook "$HOOK" "git push origin feature")
if ! is_denied "$OUTPUT"; then
  echo "  PASS: git push allowed"
  ((PASS++))
else
  echo "  FAIL: git push incorrectly blocked"
  ((FAIL++))
fi

echo ""
echo "=== git log is ALLOWED ==="

OUTPUT=$(run_hook "$HOOK" "git log --oneline -5")
if ! is_denied "$OUTPUT"; then
  echo "  PASS: git log allowed"
  ((PASS++))
else
  echo "  FAIL: git log incorrectly blocked"
  ((FAIL++))
fi

echo ""
echo "=== non-git command is ALLOWED ==="

OUTPUT=$(run_hook "$HOOK" "npm run build")
if ! is_denied "$OUTPUT"; then
  echo "  PASS: non-git command allowed"
  ((PASS++))
else
  echo "  FAIL: non-git command incorrectly blocked"
  ((FAIL++))
fi

# ============================================================
# Error message quality
# ============================================================

echo ""
echo "=== Blocking message includes helpful guidance ==="

OUTPUT=$(run_hook "$HOOK" "git rebase origin/main")
assert_contains "mentions merge alternative" "git merge origin/main" "$OUTPUT"
assert_contains "mentions rebase dangers" "force-push" "$OUTPUT"

# ============================================================
# Edge cases
# ============================================================

echo ""
echo "=== echo containing 'git rebase' is NOT blocked ==="

OUTPUT=$(run_hook "$HOOK" "echo 'use git rebase to fix it'")
if ! is_denied "$OUTPUT"; then
  echo "  PASS: echo with 'git rebase' text allowed"
  ((PASS++))
else
  echo "  FAIL: echo with 'git rebase' text incorrectly blocked"
  ((FAIL++))
fi

echo ""
echo "=== comment containing git rebase is NOT blocked ==="

OUTPUT=$(run_hook "$HOOK" "# git rebase origin/main")
if ! is_denied "$OUTPUT"; then
  echo "  PASS: comment with git rebase allowed"
  ((PASS++))
else
  echo "  FAIL: comment with git rebase incorrectly blocked"
  ((FAIL++))
fi

# ============================================================
# Done
# ============================================================

print_results
