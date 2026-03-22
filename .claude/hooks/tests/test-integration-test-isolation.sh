#!/bin/bash
# test-integration-test-isolation.sh — Verify test isolation prevents state leakage
#
# INVARIANT: Tests NEVER write to production state directories.
# When STATE_DIR and AUDIT_DIR are set (as done by run-all-tests.sh and
# harness.py), hooks must write only to those directories, not to the
# default production paths.
#
# This test is the category prevention test for kaizen #373, #340, #448.
# It catches any new hook or test that bypasses isolation by writing to
# hardcoded paths.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

HOOKS_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Test isolation prevents state leakage ==="

# Phase 1: Verify run-all-tests.sh sets isolation env vars
echo ""
echo "--- Phase 1: Global isolation env vars (requires run-all-tests.sh) ---"

REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)"

# These checks only apply when run via run-all-tests.sh, which sets global isolation.
# When run standalone, STATE_DIR/AUDIT_DIR may not be set — that's expected.
if [ -z "${KAIZEN_TEST_RUNNER:-}" ]; then
  echo "  SKIP: not run via run-all-tests.sh (set KAIZEN_TEST_RUNNER=1 to enable)"
  skip_pass 2
else
  if [ "${STATE_DIR:-}" = "/tmp/.pr-review-state" ]; then
    echo "  FAIL: STATE_DIR is the production path"
    FAILED_NAMES+=("STATE_DIR is not production path")
    ((FAIL++))
  else
    echo "  PASS: STATE_DIR is not the production path"
    ((PASS++))
  fi
  if [[ "${AUDIT_DIR:-}" == "$REPO_ROOT"* ]]; then
    echo "  FAIL: AUDIT_DIR points into the repo"
    FAILED_NAMES+=("AUDIT_DIR is not in repo")
    ((FAIL++))
  else
    echo "  PASS: AUDIT_DIR is outside the repo"
    ((PASS++))
  fi
fi

# Phase 2: Verify setup_test_env() overrides to isolated paths
echo ""
echo "--- Phase 2: setup_test_env() uses isolated paths ---"

setup_test_env
# setup_test_env creates /tmp/.pr-review-state-test-$$ which is distinct from production /tmp/.pr-review-state
if [ "$STATE_DIR" = "/tmp/.pr-review-state" ]; then
  echo "  FAIL: setup_test_env STATE_DIR equals production path"
  FAILED_NAMES+=("setup STATE_DIR is not production")
  ((FAIL++))
else
  echo "  PASS: setup_test_env STATE_DIR is not production"
  ((PASS++))
fi
assert_contains "setup STATE_DIR is in /tmp" "/tmp/" "$STATE_DIR"
if [[ "$AUDIT_DIR" == "$REPO_ROOT"* ]]; then
  echo "  FAIL: setup_test_env AUDIT_DIR is in repo"
  FAILED_NAMES+=("setup AUDIT_DIR not in repo")
  ((FAIL++))
else
  echo "  PASS: setup_test_env AUDIT_DIR is outside repo"
  ((PASS++))
fi
cleanup_test_env

# Phase 3: Run a hook that writes state and verify it goes to isolated dir
echo ""
echo "--- Phase 3: Hook writes to isolated STATE_DIR ---"

setup_test_env

PR_REVIEW_LOOP="$HOOKS_DIR/pr-review-loop-ts.sh"
if [ -f "$PR_REVIEW_LOOP" ]; then
  TEST_PR_NUM=$((RANDOM + 100000))
  TEST_PR_URL="https://github.com/Garsson-io/isolation-test/pull/$TEST_PR_NUM"
  INPUT=$(jq -n --arg pr_url "$TEST_PR_URL" '{
    tool_input: {command: "gh pr create --title test --body test"},
    tool_response: {stdout: $pr_url, stderr: "", exit_code: "0"}
  }')

  echo "$INPUT" | STATE_DIR="$TEST_STATE_DIR" AUDIT_DIR="$TEST_AUDIT_DIR" \
    AUDIT_LOG="$TEST_AUDIT_DIR/no-action.log" \
    bash "$PR_REVIEW_LOOP" >/dev/null 2>&1

  # Verify state was written to isolated dir, not production
  PRODUCTION_STATE="/tmp/.pr-review-state"
  LEAKED_FILES=""
  if [ -d "$PRODUCTION_STATE" ]; then
    LEAKED_FILES=$(find "$PRODUCTION_STATE" -name "*isolation-test*" 2>/dev/null || true)
  fi
  assert_eq "no state leaked to production dir" "" "$LEAKED_FILES"

  # Clean up any leaked files (safety net)
  if [ -n "$LEAKED_FILES" ]; then
    echo "$LEAKED_FILES" | xargs rm -f 2>/dev/null || true
  fi
else
  echo "  SKIP: pr-review-loop-ts.sh not found"
  skip_pass 1
fi

cleanup_test_env

# Phase 4: Verify no hardcoded production paths in hook scripts
echo ""
echo "--- Phase 4: No hardcoded production state paths in hooks ---"

HARDCODED_STATE=$(grep -r '/tmp/\.pr-review-state' "$HOOKS_DIR" --include='*.sh' \
  | grep -v '/tests/' \
  | grep -v '# .*default\|# .*fallback\|# .*production\|:-' \
  | grep -v 'STATE_DIR=' || true)
assert_eq "no hardcoded /tmp/.pr-review-state in hooks (outside defaults)" "" "$HARDCODED_STATE"

# Phase 5: Verify Python harness auto-sets isolation
echo ""
echo "--- Phase 5: Python harness auto-isolation ---"

if command -v python3 &>/dev/null; then
  HARNESS_CHECK=$(python3 -c "
import sys
sys.path.insert(0, '$SCRIPT_DIR')
from harness import HookHarness
h = HookHarness()
print('STATE_DIR' in h.env_overrides and '/tmp/.pr-review-state' not in h.env_overrides['STATE_DIR'])
print('AUDIT_DIR' in h.env_overrides)
h.cleanup()
" 2>/dev/null || echo "error")
  assert_contains "harness sets isolated STATE_DIR" "True" "$HARNESS_CHECK"
  assert_contains "harness sets AUDIT_DIR" "True" "$HARNESS_CHECK"
else
  echo "  SKIP: python3 not available"
  skip_pass 2
fi

print_results
