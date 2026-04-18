#!/bin/bash
# Integration tests for kaizen-prehook-no-verify.sh (epic #1059).
#
# INVARIANT UNDER TEST: `git push --no-verify` is blocked; other git push
# variants (dry run, force-with-lease, kaizen-force push option) pass through.
source "$(dirname "$0")/test-helpers.sh"

HOOK="$(dirname "$0")/../kaizen-prehook-no-verify.sh"

echo "=== git push --no-verify is BLOCKED ==="
OUTPUT=$(run_hook "$HOOK" "git push --no-verify")
if is_denied "$OUTPUT"; then
  echo "  PASS: git push --no-verify blocked"
  ((PASS++))
else
  echo "  FAIL: git push --no-verify not blocked"
  echo "    output: $OUTPUT"
  ((FAIL++))
fi
assert_contains "message mentions kaizen-force escape hatch" "kaizen-force" "$OUTPUT"

echo ""
echo "=== git push origin main --no-verify is BLOCKED ==="
OUTPUT=$(run_hook "$HOOK" "git push origin main --no-verify")
if is_denied "$OUTPUT"; then
  echo "  PASS: git push origin main --no-verify blocked"
  ((PASS++))
else
  echo "  FAIL: blocked case failed"
  ((FAIL++))
fi

echo ""
echo "=== plain git push is ALLOWED ==="
OUTPUT=$(run_hook "$HOOK" "git push")
if is_denied "$OUTPUT"; then
  echo "  FAIL: plain push was blocked"
  echo "    output: $OUTPUT"
  ((FAIL++))
else
  echo "  PASS: plain git push allowed"
  ((PASS++))
fi

echo ""
echo "=== git push --dry-run (-n) is ALLOWED ==="
OUTPUT=$(run_hook "$HOOK" "git push -n")
if is_denied "$OUTPUT"; then
  echo "  FAIL: -n (dry-run) was incorrectly blocked"
  ((FAIL++))
else
  echo "  PASS: -n allowed (dry run ≠ --no-verify)"
  ((PASS++))
fi

echo ""
echo "=== git push -o kaizen-force is ALLOWED (escape hatch) ==="
OUTPUT=$(run_hook "$HOOK" "git push -o kaizen-force origin main")
if is_denied "$OUTPUT"; then
  echo "  FAIL: kaizen-force push option was incorrectly blocked"
  ((FAIL++))
else
  echo "  PASS: kaizen-force push option allowed"
  ((PASS++))
fi

echo ""
echo "=== unrelated commands are ALLOWED ==="
OUTPUT=$(run_hook "$HOOK" "ls -la")
if is_denied "$OUTPUT"; then
  echo "  FAIL: unrelated command was blocked"
  ((FAIL++))
else
  echo "  PASS: unrelated command allowed"
  ((PASS++))
fi

echo ""
echo "Total: PASS=$PASS FAIL=$FAIL"
exit $FAIL
