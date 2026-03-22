#!/bin/bash
# test-integration-audit-isolation.sh — E2E test for audit log path isolation
#
# Tests that no-action audit log entries are written to the AUDIT_LOG
# override path and NOT to the repo's default audit directory.
#
# INVARIANT: When AUDIT_LOG env var is set, all no-action declarations
# (KAIZEN_NO_ACTION and KAIZEN_IMPEDIMENTS: [] reason) write to that
# path exclusively. The repo's .claude/kaizen/audit/no-action.log is
# never touched.
#
# This test directly addresses kaizen #429 (audit log path isolation).

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOKS_DIR="$(dirname "$SCRIPT_DIR")"
source "$SCRIPT_DIR/harness.sh"

# Isolated state and audit directories
STATE_DIR="$HARNESS_TEMP/pr-review-state"
AUDIT_DIR="$HARNESS_TEMP/audit"
ISOLATED_AUDIT_LOG="$AUDIT_DIR/no-action.log"
mkdir -p "$STATE_DIR" "$AUDIT_DIR"
export STATE_DIR
export DEBUG_LOG="$HARNESS_TEMP/debug.log"

# The repo's real audit log path — must NOT be written to
REPO_AUDIT_LOG="$HOOKS_DIR/../audit/no-action.log"

PR_KAIZEN_CLEAR="$HOOKS_DIR/kaizen-pr-reflect-clear.sh"

# Mock gh to return OPEN for pr view
INTEG_MOCK_DIR="$HARNESS_TEMP/mock-bin"
setup_default_gh_mock "$INTEG_MOCK_DIR"

HOOK_ENV_VARS=$(printf 'STATE_DIR=%s\nAUDIT_LOG=%s\nPATH=%s\n' \
  "$STATE_DIR" "$ISOLATED_AUDIT_LOG" "$INTEG_MOCK_DIR:$PATH")

PR_URL="https://github.com/Garsson-io/kaizen/pull/429"

# Hook runner
run_post_clear() {
  local command="$1"
  local stdout="$2"
  local exit_code="${3:-0}"
  local input
  input=$(build_post_tool_use_input "Bash" \
    "$(jq -n --arg c "$command" '{command: $c}')" \
    "$stdout" "" "$exit_code")
  run_single_hook "$PR_KAIZEN_CLEAR" "$input" 10 "$HOOK_ENV_VARS"
}

# Helper: create a kaizen gate state file for the current branch
create_gate() {
  local pr_url="$1"
  local branch
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
  local state_key
  state_key=$(echo "$pr_url" | sed 's|https://github\.com/||;s|/pull/|_|;s|/|_|g')
  printf 'PR_URL=%s\nSTATUS=%s\nBRANCH=%s\n' \
    "$pr_url" "needs_pr_kaizen" "$branch" > "$STATE_DIR/pr-kaizen-$state_key"
}

# Helper: reset state between phases
reset() {
  rm -rf "$STATE_DIR"/*
  rm -f "$ISOLATED_AUDIT_LOG"
}

# Snapshot the repo audit log modification time (if it exists) to detect writes
REPO_AUDIT_SNAPSHOT=""
if [ -f "$REPO_AUDIT_LOG" ]; then
  REPO_AUDIT_SNAPSHOT=$(stat -c %Y "$REPO_AUDIT_LOG" 2>/dev/null || stat -f %m "$REPO_AUDIT_LOG" 2>/dev/null)
fi

# ================================================================
# Test 1: KAIZEN_NO_ACTION writes to AUDIT_LOG override
# ================================================================
echo "=== Test 1: KAIZEN_NO_ACTION writes to AUDIT_LOG override ==="

reset
create_gate "$PR_URL"

run_post_clear \
  "echo 'KAIZEN_NO_ACTION [docs-only]: updated README formatting'" \
  "KAIZEN_NO_ACTION [docs-only]: updated README formatting"

if [ -f "$ISOLATED_AUDIT_LOG" ]; then
  echo "  PASS: audit log created at isolated path"
  ((PASS++))
else
  echo "  FAIL: audit log NOT created at isolated path ($ISOLATED_AUDIT_LOG)"
  ((FAIL++))
fi

assert_contains "audit entry contains timestamp" "[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}T" "$(cat "$ISOLATED_AUDIT_LOG" 2>/dev/null)"
assert_contains "audit entry contains branch" "branch=" "$(cat "$ISOLATED_AUDIT_LOG" 2>/dev/null)"
assert_contains "audit entry contains category" "category=docs-only" "$(cat "$ISOLATED_AUDIT_LOG" 2>/dev/null)"
assert_contains "audit entry contains pr URL" "pr=$PR_URL" "$(cat "$ISOLATED_AUDIT_LOG" 2>/dev/null)"
assert_contains "audit entry contains reason" "reason=updated README formatting" "$(cat "$ISOLATED_AUDIT_LOG" 2>/dev/null)"

# ================================================================
# Test 2: Multiple entries append to the same isolated log
# ================================================================
echo ""
echo "=== Test 2: Multiple entries append to the same isolated log ==="

reset
create_gate "$PR_URL"

# First no-action declaration
run_post_clear \
  "echo 'KAIZEN_NO_ACTION [docs-only]: first doc update'" \
  "KAIZEN_NO_ACTION [docs-only]: first doc update"

# Create a new gate for a second declaration
create_gate "$PR_URL"

# Second no-action declaration
run_post_clear \
  "echo 'KAIZEN_NO_ACTION [typo]: fixed typo in comment'" \
  "KAIZEN_NO_ACTION [typo]: fixed typo in comment"

LINE_COUNT=$(wc -l < "$ISOLATED_AUDIT_LOG" 2>/dev/null | tr -d ' ')
assert_eq "two entries appended to audit log" "2" "$LINE_COUNT"
assert_contains "first entry present" "first doc update" "$(cat "$ISOLATED_AUDIT_LOG" 2>/dev/null)"
assert_contains "second entry present" "fixed typo in comment" "$(cat "$ISOLATED_AUDIT_LOG" 2>/dev/null)"

# ================================================================
# Test 3: All required fields present (ISO 8601 timestamp, branch, category, pr, reason)
# ================================================================
echo ""
echo "=== Test 3: All required fields present in audit entry ==="

reset
create_gate "$PR_URL"

run_post_clear \
  "echo 'KAIZEN_NO_ACTION [config-only]: updated tsconfig'" \
  "KAIZEN_NO_ACTION [config-only]: updated tsconfig"

AUDIT_ENTRY=$(cat "$ISOLATED_AUDIT_LOG" 2>/dev/null)

# ISO 8601 timestamp: YYYY-MM-DDTHH:MM:SSZ
if echo "$AUDIT_ENTRY" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z'; then
  echo "  PASS: timestamp is ISO 8601 format"
  ((PASS++))
else
  echo "  FAIL: timestamp is NOT ISO 8601 format"
  echo "    entry: $AUDIT_ENTRY"
  ((FAIL++))
fi

assert_contains "branch field present" "branch=" "$AUDIT_ENTRY"
assert_contains "category field present" "category=config-only" "$AUDIT_ENTRY"
assert_contains "pr field present" "pr=https://github.com/" "$AUDIT_ENTRY"
assert_contains "reason field present" "reason=updated tsconfig" "$AUDIT_ENTRY"

# ================================================================
# Test 4: Empty-array KAIZEN_IMPEDIMENTS also writes to audit log
# ================================================================
echo ""
echo "=== Test 4: Empty-array KAIZEN_IMPEDIMENTS writes to audit log ==="

reset
create_gate "$PR_URL"

run_post_clear \
  "echo 'KAIZEN_IMPEDIMENTS: [] straightforward bug fix, no process issues'" \
  "KAIZEN_IMPEDIMENTS: [] straightforward bug fix, no process issues"

if [ -f "$ISOLATED_AUDIT_LOG" ]; then
  echo "  PASS: audit log written for empty-array KAIZEN_IMPEDIMENTS"
  ((PASS++))
else
  echo "  FAIL: audit log NOT written for empty-array KAIZEN_IMPEDIMENTS"
  ((FAIL++))
fi

EMPTY_ENTRY=$(cat "$ISOLATED_AUDIT_LOG" 2>/dev/null)
assert_contains "empty-array entry has category" "category=empty-array" "$EMPTY_ENTRY"
assert_contains "empty-array entry has reason" "reason=straightforward bug fix" "$EMPTY_ENTRY"
assert_contains "empty-array entry has pr" "pr=$PR_URL" "$EMPTY_ENTRY"

# Verify ISO 8601 timestamp in empty-array entry too
if echo "$EMPTY_ENTRY" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z'; then
  echo "  PASS: empty-array entry has ISO 8601 timestamp"
  ((PASS++))
else
  echo "  FAIL: empty-array entry missing ISO 8601 timestamp"
  echo "    entry: $EMPTY_ENTRY"
  ((FAIL++))
fi

# ================================================================
# Test 5: Repo audit dir untouched
# ================================================================
echo ""
echo "=== Test 5: Repo audit dir untouched ==="

# Check that the repo's actual audit log was NOT written to during our tests
if [ -f "$REPO_AUDIT_LOG" ]; then
  REPO_AUDIT_CURRENT=$(stat -c %Y "$REPO_AUDIT_LOG" 2>/dev/null || stat -f %m "$REPO_AUDIT_LOG" 2>/dev/null)
  if [ "$REPO_AUDIT_SNAPSHOT" = "$REPO_AUDIT_CURRENT" ]; then
    echo "  PASS: repo audit log untouched (mtime unchanged)"
    ((PASS++))
  else
    echo "  FAIL: repo audit log was modified during tests!"
    echo "    before: $REPO_AUDIT_SNAPSHOT"
    echo "    after:  $REPO_AUDIT_CURRENT"
    ((FAIL++))
  fi
else
  if [ -z "$REPO_AUDIT_SNAPSHOT" ]; then
    echo "  PASS: repo audit log does not exist (was never created)"
    ((PASS++))
  else
    echo "  FAIL: repo audit log existed before but was deleted during tests!"
    ((FAIL++))
  fi
fi

harness_summary
