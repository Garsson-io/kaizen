#!/bin/bash
# Tests for kaizen-enforce-case-exists.sh — Level 2 case existence enforcement
# Tests the pluggable $KAIZEN_CASE_CLI backend (read from kaizen.config.json)
source "$(dirname "$0")/test-helpers.sh"

HOOK="$(cd "$(dirname "$0")/.." && pwd)/kaizen-enforce-case-exists.sh"

echo "Testing kaizen-enforce-case-exists.sh"
echo ""

# Helper: run the hook with an Edit/Write tool input
run_edit_hook() {
  local file_path="$1"
  local input
  input=$(jq -n --arg fp "$file_path" '{"tool_input":{"file_path":$fp}}')
  echo "$input" | bash "$HOOK" 2>/dev/null
}

# Helper: run the hook with a mock caseCli injected via config
run_edit_hook_with_cli() {
  local file_path="$1"
  local input
  input=$(jq -n --arg fp "$file_path" '{"tool_input":{"file_path":$fp}}')
  echo "$input" | CLAUDE_PROJECT_DIR="$MOCK_CONFIG_DIR" bash "$HOOK" 2>/dev/null
}

# Test 1: Empty file_path → allow
echo "Test 1: empty file_path allows"
OUTPUT=$(echo '{"tool_input":{}}' | bash "$HOOK" 2>/dev/null)
assert_eq "empty file_path allows" "" "$OUTPUT"

# Test 2: Non-source files are always allowed (even without a case)
echo ""
echo "Test 2: non-source paths are allowed"
for path in ".claude/memory/test.md" "groups/test/config.json" "data/ipc/test.json" "store/test.db" "logs/test.log"; do
  WORKTREE_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
  ABS_PATH="$WORKTREE_ROOT/$path"
  OUTPUT=$(run_edit_hook "$ABS_PATH")
  assert_eq "allows $path" "" "$OUTPUT"
done

# Test 3: No caseCli in config → skip enforcement (allow everything)
echo ""
echo "Test 3: no caseCli configured → allows source edits"
WORKTREE_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)

if require_worktree; then
  OUTPUT=$(run_edit_hook "$WORKTREE_ROOT/src/test.ts")
  assert_eq "source edit allowed without case CLI" "" "$OUTPUT"
else
  skip_pass 1
fi

# Test 4: caseCli returns a case → allow source edits
echo ""
echo "Test 4: case CLI returns case → allows source edits"

if require_worktree; then
  setup_mock_case_cli "found"
  setup_mock_config '{"host":{"caseCli":"'"$MOCK_CASE_CLI"'"}}'

  OUTPUT=$(run_edit_hook_with_cli "$WORKTREE_ROOT/src/test.ts")
  assert_eq "source edit allowed when case exists" "" "$OUTPUT"

  rm -rf "$(dirname "$MOCK_CASE_CLI")" "$MOCK_CONFIG_DIR"
else
  skip_pass 1
fi

# Test 5: caseCli returns no case → block source edits
echo ""
echo "Test 5: case CLI returns no case → blocks source edits"

if require_worktree; then
  setup_mock_case_cli "empty"
  setup_mock_config '{"host":{"caseCli":"'"$MOCK_CASE_CLI"'"}}'

  BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
  OUTPUT=$(run_edit_hook_with_cli "$WORKTREE_ROOT/src/test.ts")

  if is_denied "$OUTPUT"; then
    echo "  PASS: source edit blocked when no case exists"
    ((PASS++))
  else
    echo "  FAIL: source edit should be blocked when no case exists"
    echo "    output: $OUTPUT"
    ((FAIL++))
  fi

  assert_contains "deny message mentions branch" "$BRANCH" "$OUTPUT"
  assert_contains "deny message mentions case-create" "case-create" "$OUTPUT"

  rm -rf "$(dirname "$MOCK_CASE_CLI")" "$MOCK_CONFIG_DIR"
else
  skip_pass 3
fi

# Test 6: Various source file patterns trigger enforcement when no case
echo ""
echo "Test 6: source file patterns are checked"

if require_worktree; then
  setup_mock_case_cli "empty"
  setup_mock_config '{"host":{"caseCli":"'"$MOCK_CASE_CLI"'"}}'

  for path in "src/index.ts" "container/Dockerfile" "package.json" "docs/README.md" "tsconfig.json"; do
    OUTPUT=$(run_edit_hook_with_cli "$WORKTREE_ROOT/$path")
    if is_denied "$OUTPUT"; then
      echo "  PASS: blocks $path without case"
      ((PASS++))
    else
      echo "  FAIL: should block $path without case"
      ((FAIL++))
    fi
  done

  rm -rf "$(dirname "$MOCK_CASE_CLI")" "$MOCK_CONFIG_DIR"
else
  skip_pass 5
fi

# Test 7: Files outside worktree are allowed
echo ""
echo "Test 7: files outside worktree are allowed"
OUTPUT=$(run_edit_hook "/tmp/some-random-file.ts")
assert_eq "file outside worktree allowed" "" "$OUTPUT"

print_results
