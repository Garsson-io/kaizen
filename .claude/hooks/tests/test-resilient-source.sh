#!/bin/bash
# test-resilient-source.sh — Verify resilient source guards on all hooks
#
# INVARIANT: Every source call to lib/ (except scope-guard.sh) must have
# an error guard (|| { exit 0; }) to prevent hook crashes from corrupted
# libraries. This is the category prevention test for kaizen #386, #371.
#
# Also verifies the CI lints in validate-hook-integrity.sh catch violations.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOKS_DIR="$(dirname "$SCRIPT_DIR")"
source "$SCRIPT_DIR/test-helpers.sh"

echo "=== Resilient source guard tests ==="

# Phase 1: All hooks have guarded source calls
echo ""
echo "--- Phase 1: All lib source calls are guarded ---"

TOTAL_GUARDED=0
TOTAL_UNGUARDED=0
for f in "$HOOKS_DIR"/kaizen-*.sh "$HOOKS_DIR"/pr-*.sh; do
  [ -f "$f" ] || continue
  name=$(basename "$f")

  # Find unguarded source calls (not scope-guard, no || guard)
  unguarded=$(grep -c '^source .*/lib/' "$f" | head -1)
  guarded=$(grep -c '^source .*/lib/.*||' "$f" | head -1)
  scope=$(grep -c '^source .*/lib/scope-guard' "$f" | head -1)

  # All non-scope-guard sources should have guards
  expected_guarded=$((unguarded - scope))
  if [ "$expected_guarded" -gt 0 ] && [ "$guarded" -lt "$expected_guarded" ]; then
    echo "  FAIL: $name has $((expected_guarded - guarded)) unguarded source call(s)"
    FAILED_NAMES+=("$name unguarded source")
    ((FAIL++))
    ((TOTAL_UNGUARDED += expected_guarded - guarded))
  elif [ "$expected_guarded" -gt 0 ]; then
    ((TOTAL_GUARDED += guarded))
  fi
done

if [ "$TOTAL_UNGUARDED" -eq 0 ]; then
  echo "  PASS: all $TOTAL_GUARDED non-scope-guard source calls are guarded"
  ((PASS++))
fi

# Phase 2: Resilient source pattern causes fail-open on missing libs
echo ""
echo "--- Phase 2: Resilient source guard causes fail-open ---"

# Create a minimal hook that uses the resilient pattern with a missing lib
FAIL_OPEN_HOOK=$(mktemp)
cat > "$FAIL_OPEN_HOOK" << 'HOOK'
#!/bin/bash
source "/nonexistent/path/to/broken-lib.sh" 2>/dev/null || { exit 0; }
echo "SHOULD_NOT_REACH"
exit 1
HOOK
chmod +x "$FAIL_OPEN_HOOK"

EXIT_CODE=0
OUTPUT=$(bash "$FAIL_OPEN_HOOK" 2>/dev/null) || EXIT_CODE=$?
if [ "$EXIT_CODE" -eq 0 ] && [ -z "$OUTPUT" ]; then
  echo "  PASS: resilient guard exits 0 on missing lib (fail-open)"
  ((PASS++))
else
  echo "  FAIL: expected exit 0 with no output, got exit=$EXIT_CODE output='$OUTPUT'"
  FAILED_NAMES+=("resilient guard fail-open")
  ((FAIL++))
fi

# Verify: the guard stops execution before reaching dependent code
GUARDED_HOOK=$(mktemp)
cat > "$GUARDED_HOOK" << 'HOOK'
#!/bin/bash
source "/nonexistent/lib.sh" 2>/dev/null || { exit 0; }
echo "DEPENDENT_CODE_REACHED"
HOOK

OUTPUT=$(bash "$GUARDED_HOOK" 2>/dev/null)
if [ -z "$OUTPUT" ]; then
  echo "  PASS: guard prevents reaching dependent code after failed source"
  ((PASS++))
else
  echo "  FAIL: dependent code was reached despite failed source"
  FAILED_NAMES+=("guard prevents dependent code")
  ((FAIL++))
fi
rm -f "$FAIL_OPEN_HOOK" "$GUARDED_HOOK"

# Phase 3: validate-hook-integrity.sh catches unguarded source
echo ""
echo "--- Phase 3: CI lint catches unguarded source ---"

# Create a fake hook with unguarded source
FAKE_HOOKS_DIR=$(mktemp -d)
mkdir -p "$FAKE_HOOKS_DIR/.claude/hooks/lib"
echo '#!/bin/bash' > "$FAKE_HOOKS_DIR/.claude/hooks/lib/test-lib.sh"
cat > "$FAKE_HOOKS_DIR/.claude/hooks/kaizen-fake-test.sh" << 'HOOK'
#!/bin/bash
source "$(dirname "$0")/lib/test-lib.sh"
exit 0
HOOK
chmod +x "$FAKE_HOOKS_DIR/.claude/hooks/kaizen-fake-test.sh"

# Create minimal settings.json
cat > "$FAKE_HOOKS_DIR/.claude/settings.json" << 'JSON'
{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"command":"./.claude/hooks/kaizen-fake-test.sh"}]}]}}
JSON

LINT_OUTPUT=$(bash "$SCRIPT_DIR/validate-hook-integrity.sh" "$FAKE_HOOKS_DIR" 2>&1)
if echo "$LINT_OUTPUT" | grep -q "Unguarded source"; then
  echo "  PASS: CI lint detects unguarded source"
  ((PASS++))
else
  echo "  FAIL: CI lint did not detect unguarded source"
  echo "    output: $LINT_OUTPUT"
  FAILED_NAMES+=("CI lint unguarded source detection")
  ((FAIL++))
fi
rm -rf "$FAKE_HOOKS_DIR"

# Phase 4: validate-hook-integrity.sh passes with guarded hooks
echo ""
echo "--- Phase 4: CI lint passes on current hooks ---"

LINT_OUTPUT=$(bash "$SCRIPT_DIR/validate-hook-integrity.sh" 2>&1)
LINT_EXIT=$?
if [ "$LINT_EXIT" -eq 0 ]; then
  echo "  PASS: all current hooks pass CI lint"
  ((PASS++))
else
  echo "  FAIL: CI lint failed on current hooks"
  echo "$LINT_OUTPUT" | grep "::error::"
  FAILED_NAMES+=("CI lint on current hooks")
  ((FAIL++))
fi

print_results
