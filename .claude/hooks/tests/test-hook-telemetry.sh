#!/bin/bash
# test-hook-telemetry.sh — Tests for hook-telemetry.sh JSONL emission
#
# INVARIANT: Every hook that sources hook-telemetry.sh emits valid JSONL
# with required fields (hook, timestamp, duration_ms, exit_code, branch).

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOKS_DIR="$(dirname "$SCRIPT_DIR")"
source "$SCRIPT_DIR/test-helpers.sh"

echo "=== Hook telemetry tests ==="

# Setup: temp dir for telemetry output
TELEMETRY_DIR=$(mktemp -d)
trap 'rm -rf "$TELEMETRY_DIR"' EXIT

# Phase 1: Telemetry file is created on hook execution
echo ""
echo "--- Phase 1: Telemetry JSONL file is created ---"

TELEMETRY_FILE="$TELEMETRY_DIR/hooks.jsonl"
echo '{"tool_input":{"command":"echo test"}}' | \
  KAIZEN_TELEMETRY_DIR="$TELEMETRY_DIR" bash "$HOOKS_DIR/kaizen-block-git-rebase.sh" >/dev/null 2>&1

if [ -f "$TELEMETRY_FILE" ]; then
  echo "  PASS: hooks.jsonl created"
  ((PASS++))
else
  echo "  FAIL: hooks.jsonl not created at $TELEMETRY_FILE"
  FAILED_NAMES+=("hooks.jsonl created")
  ((FAIL++))
fi

# Phase 2: Each JSONL line is valid JSON with required fields
echo ""
echo "--- Phase 2: JSONL lines contain required fields ---"

LINE=$(tail -1 "$TELEMETRY_FILE")

for field in hook timestamp duration_ms exit_code branch; do
  VAL=$(echo "$LINE" | jq -r ".$field" 2>/dev/null)
  if [ -n "$VAL" ] && [ "$VAL" != "null" ]; then
    echo "  PASS: field '$field' present (value: $VAL)"
    ((PASS++))
  else
    echo "  FAIL: field '$field' missing or null"
    FAILED_NAMES+=("field $field present")
    ((FAIL++))
  fi
done

# Phase 3: Hook name is correctly extracted
echo ""
echo "--- Phase 3: Hook name extraction ---"

HOOK_NAME=$(echo "$LINE" | jq -r '.hook')
assert_eq "hook name is kaizen-block-git-rebase" "kaizen-block-git-rebase" "$HOOK_NAME"

# Phase 4: Duration is a non-negative integer
echo ""
echo "--- Phase 4: Duration is non-negative ---"

DURATION=$(echo "$LINE" | jq '.duration_ms')
if [ "$DURATION" -ge 0 ] 2>/dev/null; then
  echo "  PASS: duration_ms is non-negative ($DURATION)"
  ((PASS++))
else
  echo "  FAIL: duration_ms is not a non-negative integer ($DURATION)"
  FAILED_NAMES+=("duration non-negative")
  ((FAIL++))
fi

# Phase 5: Exit code is captured
echo ""
echo "--- Phase 5: Exit code is captured correctly ---"

EXIT_CODE=$(echo "$LINE" | jq '.exit_code')
assert_eq "exit code is 0 for passthrough" "0" "$EXIT_CODE"

# Phase 6: Case ID extracted from branch name
echo ""
echo "--- Phase 6: Case ID extraction from branch ---"

CASE_ID=$(echo "$LINE" | jq -r '.case_id')
BRANCH=$(echo "$LINE" | jq -r '.branch')
if [[ "$BRANCH" =~ ^case/ ]]; then
  EXPECTED_CASE="${BRANCH#case/}"
  assert_eq "case_id extracted from branch" "$EXPECTED_CASE" "$CASE_ID"
else
  # Not on a case branch — case_id should be empty
  assert_eq "case_id empty when not on case branch" "" "$CASE_ID"
fi

# Phase 7: Multiple invocations append (don't overwrite)
echo ""
echo "--- Phase 7: Multiple invocations append ---"

LINES_BEFORE=$(wc -l < "$TELEMETRY_FILE")
echo '{"tool_input":{"command":"echo second"}}' | \
  KAIZEN_TELEMETRY_DIR="$TELEMETRY_DIR" bash "$HOOKS_DIR/kaizen-block-git-rebase.sh" >/dev/null 2>&1
LINES_AFTER=$(wc -l < "$TELEMETRY_FILE")

if [ "$LINES_AFTER" -gt "$LINES_BEFORE" ]; then
  echo "  PASS: new invocation appended ($LINES_BEFORE -> $LINES_AFTER lines)"
  ((PASS++))
else
  echo "  FAIL: file not appended ($LINES_BEFORE -> $LINES_AFTER lines)"
  FAILED_NAMES+=("append not overwrite")
  ((FAIL++))
fi

# Phase 8: Telemetry can be disabled
echo ""
echo "--- Phase 8: Telemetry disabled via env var ---"

LINES_BEFORE=$(wc -l < "$TELEMETRY_FILE")
echo '{"tool_input":{"command":"echo disabled"}}' | \
  KAIZEN_TELEMETRY_DIR="$TELEMETRY_DIR" KAIZEN_TELEMETRY_DISABLED=1 \
  bash "$HOOKS_DIR/kaizen-block-git-rebase.sh" >/dev/null 2>&1
LINES_AFTER=$(wc -l < "$TELEMETRY_FILE")

assert_eq "no new lines when disabled" "$LINES_BEFORE" "$LINES_AFTER"

# Phase 9: All lines in the file are valid JSON
echo ""
echo "--- Phase 9: All JSONL lines are valid JSON ---"

INVALID=$(while IFS= read -r line; do
  echo "$line" | jq . >/dev/null 2>&1 || echo "INVALID: $line"
done < "$TELEMETRY_FILE")

if [ -z "$INVALID" ]; then
  echo "  PASS: all $(wc -l < "$TELEMETRY_FILE") lines are valid JSON"
  ((PASS++))
else
  echo "  FAIL: invalid JSON found"
  echo "$INVALID"
  FAILED_NAMES+=("all lines valid JSON")
  ((FAIL++))
fi

print_results
