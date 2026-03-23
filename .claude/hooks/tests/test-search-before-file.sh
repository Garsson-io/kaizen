#!/bin/bash
# Tests for kaizen-search-before-file.sh — PreToolUse advisory hook
#
# INVARIANT UNDER TEST: When an agent runs `gh issue create`, the hook
# searches for similar open issues and shows advisory output if matches found.
# Non-issue-create commands pass through silently.
source "$(dirname "$0")/test-helpers.sh"

HOOK="$(dirname "$0")/../kaizen-search-before-file.sh"
require_file "$HOOK" "kaizen-search-before-file.sh"
setup_test_env

setup() { reset_state; }
teardown() { reset_state; }

# Helper: run the PreToolUse hook with a command and custom gh mock
run_pretool_hook() {
  local command="$1"
  local input
  input=$(jq -n --arg cmd "$command" '{"tool_input":{"command":$cmd}}')
  echo "$input" | PATH="$TEST_MOCK_DIR:$PATH" bash "$HOOK" 2>/dev/null
}

echo "=== Non-issue-create commands pass silently ==="

setup

# INVARIANT: Non-gh commands produce no output
OUTPUT=$(run_pretool_hook "npm run build")
assert_eq "npm build passes silently" "" "$OUTPUT"

# INVARIANT: gh issue list passes silently
OUTPUT=$(run_pretool_hook "gh issue list --repo Garsson-io/kaizen")
assert_eq "gh issue list passes silently" "" "$OUTPUT"

# INVARIANT: gh pr create passes silently
OUTPUT=$(run_pretool_hook "gh pr create --title 'fix something'")
assert_eq "gh pr create passes silently" "" "$OUTPUT"

# INVARIANT: gh issue view passes silently
OUTPUT=$(run_pretool_hook "gh issue view 42")
assert_eq "gh issue view passes silently" "" "$OUTPUT"

echo ""
echo "=== gh issue create with no title passes silently ==="

setup

# INVARIANT: If no --title flag, hook can't search — passes silently
OUTPUT=$(run_pretool_hook "gh issue create --repo Garsson-io/kaizen --body 'some body'")
assert_eq "no title flag passes silently" "" "$OUTPUT"

echo ""
echo "=== gh issue create with title but no matches passes silently ==="

setup

# Create a mock gh that returns no search results
cat > "$TEST_MOCK_DIR/gh" << 'MOCK'
#!/bin/bash
if echo "$@" | grep -q "issue list.*--search"; then
  echo "[]" | jq -r '.[:5] | .[] | "#\(.number) \(.title)\n  \(.url)"'
  exit 0
fi
exit 0
MOCK
chmod +x "$TEST_MOCK_DIR/gh"

# INVARIANT: No matches → no output
OUTPUT=$(run_pretool_hook "gh issue create --repo Garsson-io/kaizen --title 'completely unique title xyz123'")
assert_eq "no matches passes silently" "" "$OUTPUT"

echo ""
echo "=== gh issue create with title and matches shows advisory ==="

setup

# Create a mock gh that returns search results
cat > "$TEST_MOCK_DIR/gh" << 'MOCK'
#!/bin/bash
if echo "$@" | grep -q "issue list.*--search"; then
  echo '[{"number":42,"title":"Fix OOM in hooks","url":"https://github.com/Garsson-io/kaizen/issues/42"}]' | \
    jq -r '.[:5] | .[] | "#\(.number) \(.title)\n  \(.url)"'
  exit 0
fi
exit 0
MOCK
chmod +x "$TEST_MOCK_DIR/gh"

# INVARIANT: When matches found, advisory output is shown
OUTPUT=$(run_pretool_hook "gh issue create --repo Garsson-io/kaizen --title 'Fix OOM in stop hook'")
assert_contains "shows DUPLICATE CHECK" "DUPLICATE CHECK" "$OUTPUT"
assert_contains "shows matching issue number" "#42" "$OUTPUT"
assert_contains "shows matching issue title" "Fix OOM in hooks" "$OUTPUT"
assert_contains "suggests adding comment" "Adding a comment" "$OUTPUT"

echo ""
echo "=== Title extraction variants ==="

setup

# Create a mock gh that echoes the search args so we can verify extraction
cat > "$TEST_MOCK_DIR/gh" << 'MOCK'
#!/bin/bash
if echo "$@" | grep -q "issue list.*--search"; then
  # Return one match so we get output
  echo '[{"number":1,"title":"test match","url":"https://github.com/x/y/issues/1"}]' | \
    jq -r '.[:5] | .[] | "#\(.number) \(.title)\n  \(.url)"'
  exit 0
fi
exit 0
MOCK
chmod +x "$TEST_MOCK_DIR/gh"

# INVARIANT: Double-quoted title is extracted
OUTPUT=$(run_pretool_hook 'gh issue create --repo Garsson-io/kaizen --title "Fix the OOM bug"')
assert_contains "double-quoted title extracted" "DUPLICATE CHECK" "$OUTPUT"

# INVARIANT: Single-quoted title is extracted
OUTPUT=$(run_pretool_hook "gh issue create --repo Garsson-io/kaizen --title 'Fix the OOM bug'")
assert_contains "single-quoted title extracted" "DUPLICATE CHECK" "$OUTPUT"

echo ""
echo "=== Segment splitting: gh issue create inside strings ignored ==="

setup

# INVARIANT: gh issue create inside echo/string is not triggered
OUTPUT=$(run_pretool_hook "echo 'you should use gh issue create to file bugs'")
assert_eq "gh issue create inside string ignored" "" "$OUTPUT"

echo ""
echo "=== Hook is advisory (exit 0 always) ==="

setup

# Create mock with matches
cat > "$TEST_MOCK_DIR/gh" << 'MOCK'
#!/bin/bash
if echo "$@" | grep -q "issue list.*--search"; then
  echo '[{"number":99,"title":"duplicate","url":"https://github.com/x/y/issues/99"}]' | \
    jq -r '.[:5] | .[] | "#\(.number) \(.title)\n  \(.url)"'
  exit 0
fi
exit 0
MOCK
chmod +x "$TEST_MOCK_DIR/gh"

# INVARIANT: Hook always exits 0 (advisory, not blocking)
INPUT=$(jq -n --arg cmd "gh issue create --repo Garsson-io/kaizen --title 'test dup'" '{"tool_input":{"command":$cmd}}')
echo "$INPUT" | PATH="$TEST_MOCK_DIR:$PATH" bash "$HOOK" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "exit code is 0 (advisory)" "0" "$EXIT_CODE"

# INVARIANT: Output is NOT a deny JSON — it's plain text advisory
OUTPUT=$(run_pretool_hook "gh issue create --repo Garsson-io/kaizen --title 'test dup'")
if echo "$OUTPUT" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null 2>&1; then
  echo "  FAIL: hook emits deny JSON — should be advisory only"
  ((FAIL++))
else
  echo "  PASS: hook does not emit deny JSON"
  ((PASS++))
fi

echo ""
echo "=== Prefix stripping ==="

setup

cat > "$TEST_MOCK_DIR/gh" << 'MOCK'
#!/bin/bash
if echo "$@" | grep -q "issue list.*--search"; then
  echo '[{"number":1,"title":"match","url":"https://github.com/x/y/issues/1"}]' | \
    jq -r '.[:5] | .[] | "#\(.number) \(.title)\n  \(.url)"'
  exit 0
fi
exit 0
MOCK
chmod +x "$TEST_MOCK_DIR/gh"

# INVARIANT: [L2] prefix is stripped from title before search
OUTPUT=$(run_pretool_hook "gh issue create --repo Garsson-io/kaizen --title '[L2] Search before file'")
assert_contains "L2 prefix title still triggers" "DUPLICATE CHECK" "$OUTPUT"

# INVARIANT: incident: prefix is handled
OUTPUT=$(run_pretool_hook "gh issue create --repo Garsson-io/kaizen --title 'incident: something broke'")
assert_contains "incident prefix title still triggers" "DUPLICATE CHECK" "$OUTPUT"

echo ""
echo "=== Empty input handled gracefully ==="

setup

# INVARIANT: Empty command produces no output
OUTPUT=$(echo '{}' | bash "$HOOK" 2>/dev/null)
assert_eq "empty input passes silently" "" "$OUTPUT"

OUTPUT=$(echo '{"tool_input":{}}' | bash "$HOOK" 2>/dev/null)
assert_eq "empty tool_input passes silently" "" "$OUTPUT"

print_results
