#!/bin/bash
# Tests for kaizen-enforce-case-exists.sh — Level 2 case existence enforcement
# Tests the pluggable $KAIZEN_CASE_CLI backend (read from kaizen.config.json)
source "$(dirname "$0")/test-helpers.sh"

HOOK="$(cd "$(dirname "$0")/.." && pwd)/kaizen-enforce-case-exists.sh"

echo "Testing kaizen-enforce-case-exists.sh"
echo ""

# Helper: run the hook with an Edit/Write tool input for a specific file path
# Uses a temp directory with a kaizen.config.json to control KAIZEN_CASE_CLI
run_edit_hook() {
  local file_path="$1"
  local input
  input=$(jq -n --arg fp "$file_path" '{"tool_input":{"file_path":$fp}}')
  echo "$input" | bash "$HOOK" 2>/dev/null
}

# Helper: run the hook with a custom caseCli configured via kaizen.config.json
# Creates a temp config dir so read-config.sh picks up the caseCli setting
run_edit_hook_with_cli() {
  local file_path="$1"
  local case_cli="$2"
  local input
  input=$(jq -n --arg fp "$file_path" '{"tool_input":{"file_path":$fp}}')

  # Create a temp dir with kaizen.config.json that sets host.caseCli
  local config_dir
  config_dir=$(mktemp -d)
  cat > "$config_dir/kaizen.config.json" << CONF
{
  "kaizen": { "repo": "Garsson-io/kaizen" },
  "host": { "name": "test", "repo": "test/test", "caseCli": "$case_cli" }
}
CONF

  # Run with CLAUDE_PROJECT_DIR so read-config.sh finds our config
  echo "$input" | CLAUDE_PROJECT_DIR="$config_dir" bash "$HOOK" 2>/dev/null
  local rc=$?
  rm -rf "$config_dir"
  return $rc
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
GIT_DIR=$(git rev-parse --git-dir 2>/dev/null)
GIT_COMMON=$(git rev-parse --git-common-dir 2>/dev/null)

if [ "$GIT_DIR" = "$GIT_COMMON" ]; then
  echo "  SKIP: running in main checkout, can't test worktree behavior"
  ((PASS++))
else
  OUTPUT=$(run_edit_hook "$WORKTREE_ROOT/src/test.ts")
  assert_eq "source edit allowed without case CLI" "" "$OUTPUT"
fi

# Test 4: caseCli returns a case → allow source edits
echo ""
echo "Test 4: case CLI returns case → allows source edits"

if [ "$GIT_DIR" = "$GIT_COMMON" ]; then
  echo "  SKIP: running in main checkout, can't test worktree behavior"
  ((PASS++))
else
  # Create a mock case CLI that returns a case record
  MOCK_CLI_DIR=$(mktemp -d)
  cat > "$MOCK_CLI_DIR/mock-case-cli" << 'MOCK'
#!/bin/bash
if [ "$1" = "case-by-branch" ]; then
  echo '{"id": 1, "branch": "test", "status": "ACTIVE"}'
  exit 0
fi
exit 1
MOCK
  chmod +x "$MOCK_CLI_DIR/mock-case-cli"

  OUTPUT=$(run_edit_hook_with_cli "$WORKTREE_ROOT/src/test.ts" "$MOCK_CLI_DIR/mock-case-cli")
  assert_eq "source edit allowed when case exists" "" "$OUTPUT"

  rm -rf "$MOCK_CLI_DIR"
fi

# Test 5: caseCli returns no case → block source edits
echo ""
echo "Test 5: case CLI returns no case → blocks source edits"

if [ "$GIT_DIR" = "$GIT_COMMON" ]; then
  echo "  SKIP: running in main checkout, can't test worktree behavior"
  ((PASS++))
  ((PASS++))
  ((PASS++))
else
  # Create a mock case CLI that returns empty (no case found)
  MOCK_CLI_DIR=$(mktemp -d)
  cat > "$MOCK_CLI_DIR/mock-case-cli" << 'MOCK'
#!/bin/bash
if [ "$1" = "case-by-branch" ]; then
  echo ""
  exit 0
fi
exit 1
MOCK
  chmod +x "$MOCK_CLI_DIR/mock-case-cli"

  BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
  OUTPUT=$(run_edit_hook_with_cli "$WORKTREE_ROOT/src/test.ts" "$MOCK_CLI_DIR/mock-case-cli")

  if is_denied "$OUTPUT"; then
    echo "  PASS: source edit blocked when no case exists"
    ((PASS++))
  else
    echo "  FAIL: source edit should be blocked when no case exists"
    echo "    output: $OUTPUT"
    ((FAIL++))
  fi

  # Verify the deny message mentions the branch and case-create
  assert_contains "deny message mentions branch" "$BRANCH" "$OUTPUT"
  assert_contains "deny message mentions case-create" "case-create" "$OUTPUT"

  rm -rf "$MOCK_CLI_DIR"
fi

# Test 6: Various source file patterns trigger enforcement when no case
echo ""
echo "Test 6: source file patterns are checked"

if [ "$GIT_DIR" != "$GIT_COMMON" ]; then
  MOCK_CLI_DIR=$(mktemp -d)
  cat > "$MOCK_CLI_DIR/mock-case-cli" << 'MOCK'
#!/bin/bash
if [ "$1" = "case-by-branch" ]; then
  echo ""
  exit 0
fi
exit 1
MOCK
  chmod +x "$MOCK_CLI_DIR/mock-case-cli"

  for path in "src/index.ts" "container/Dockerfile" "package.json" "docs/README.md" "tsconfig.json"; do
    OUTPUT=$(run_edit_hook_with_cli "$WORKTREE_ROOT/$path" "$MOCK_CLI_DIR/mock-case-cli")
    if is_denied "$OUTPUT"; then
      echo "  PASS: blocks $path without case"
      ((PASS++))
    else
      echo "  FAIL: should block $path without case"
      ((FAIL++))
    fi
  done

  rm -rf "$MOCK_CLI_DIR"
else
  echo "  SKIP: not in worktree"
  for i in 1 2 3 4 5; do ((PASS++)); done
fi

# Test 7: Files outside worktree are allowed
echo ""
echo "Test 7: files outside worktree are allowed"
OUTPUT=$(run_edit_hook "/tmp/some-random-file.ts")
assert_eq "file outside worktree allowed" "" "$OUTPUT"

print_results
