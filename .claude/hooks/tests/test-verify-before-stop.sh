#!/bin/bash
# Tests for kaizen-verify-before-stop.sh — advisory Stop hook
#
# INVARIANT UNDER TEST: When TypeScript files are modified, the hook
# warns about verification. When no TS files are modified, it's silent.
# The hook NEVER spawns heavy subprocesses (vitest, tsc) — see #474.
source "$(dirname "$0")/test-helpers.sh"

HOOK="$(cd "$(dirname "$0")/.." && pwd)/kaizen-verify-before-stop.sh"

MOCK_DIR=$(mktemp -d)
trap 'rm -rf "$MOCK_DIR"' EXIT

setup_git_mock() {
  local diff_head_output="$1"
  local diff_cached_output="${2:-}"
  cat > "$MOCK_DIR/git" << MOCK
#!/bin/bash
if [[ "\$*" == *"diff --name-only HEAD"* ]]; then
  printf '%s' "$diff_head_output"
  exit 0
fi
if [[ "\$*" == *"diff --cached --name-only"* ]]; then
  printf '%s' "$diff_cached_output"
  exit 0
fi
/usr/bin/git "\$@"
MOCK
  chmod +x "$MOCK_DIR/git"
}

run_hook() {
  PATH="$MOCK_DIR:$PATH" bash "$HOOK" 2>&1
  return $?
}

echo "=== No TypeScript changes: silent exit ==="

setup_git_mock "" ""
OUTPUT=$(run_hook)
EXIT_CODE=$?
assert_eq "exit code 0 when no TS changes" "0" "$EXIT_CODE"
assert_not_contains "no output when no changes" "Reminder" "$OUTPUT"

echo ""
echo "=== Non-TS changes only: silent exit ==="

setup_git_mock "README.md
package.json
.claude/kaizen/hooks/test.sh" ""
OUTPUT=$(run_hook)
EXIT_CODE=$?
assert_eq "exit code 0 with only non-TS changes" "0" "$EXIT_CODE"
assert_not_contains "no output for non-TS" "Reminder" "$OUTPUT"

echo ""
echo "=== Harness TS changes: warns and exits 0 ==="

setup_git_mock "src/index.ts
src/cases.ts" ""
OUTPUT=$(run_hook)
EXIT_CODE=$?
assert_eq "exit code 0 (advisory only)" "0" "$EXIT_CODE"
assert_contains "shows reminder" "Reminder" "$OUTPUT"
assert_contains "shows file count" "2" "$OUTPUT"

echo ""
echo "=== Single TS change: warns with count 1 ==="

setup_git_mock "src/index.ts" ""
OUTPUT=$(run_hook)
EXIT_CODE=$?
assert_eq "exit code 0 for single file" "0" "$EXIT_CODE"
assert_contains "shows count 1" "1 TypeScript" "$OUTPUT"

echo ""
echo "=== Staged-only TS changes: also warns ==="

setup_git_mock "" "src/new-file.ts"
OUTPUT=$(run_hook)
EXIT_CODE=$?
assert_eq "exit code 0 with staged-only changes" "0" "$EXIT_CODE"
assert_contains "warns for staged changes" "Reminder" "$OUTPUT"

echo ""
echo "=== Never spawns vitest or tsc ==="

# Create npx mock that records if it was called
cat > "$MOCK_DIR/npx" << 'MOCK'
#!/bin/bash
echo "NPX_CALLED: $*" >> /tmp/verify-hook-npx-calls.txt
exit 0
MOCK
chmod +x "$MOCK_DIR/npx"

rm -f /tmp/verify-hook-npx-calls.txt
setup_git_mock "src/index.ts" ""
OUTPUT=$(run_hook)
if [ -f /tmp/verify-hook-npx-calls.txt ]; then
  fail "hook must never call npx (called: $(cat /tmp/verify-hook-npx-calls.txt))"
else
  pass "npx was never called"
fi
rm -f /tmp/verify-hook-npx-calls.txt

print_results
