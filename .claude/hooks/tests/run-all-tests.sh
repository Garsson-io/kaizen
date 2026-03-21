#!/bin/bash
# run-all-tests.sh — Run all hook tests (auto-discovered)
#
# Usage:
#   bash .claude/hooks/tests/run-all-tests.sh           # Run all
#   bash .claude/hooks/tests/run-all-tests.sh --unit     # Unit tests only
#   bash .claude/hooks/tests/run-all-tests.sh --harness  # Integration tests only
#   bash .claude/hooks/tests/run-all-tests.sh --quick    # Fast subset (python only)
#
# Test files are auto-discovered by naming convention:
#   test-integration-*.sh, test-*-e2e*.sh  → integration/harness tests
#   test-*.sh (everything else)            → unit tests
#
# To exclude a test, add it to EXCLUDE_TESTS below with a comment explaining why.
#
# Exit 0 = all passed, 1 = failures

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MODE="${1:-all}"

TOTAL_PASS=0
TOTAL_FAIL=0
TOTAL_TESTS=0
FAILED_FILES=()

# Tests to exclude from auto-discovery (with reasons)
EXCLUDE_TESTS=(
  # Shared library, not a test
  test-helpers.sh
)

is_excluded() {
  local name="$1"
  for exc in "${EXCLUDE_TESTS[@]}"; do
    [ "$name" = "$exc" ] && return 0
  done
  return 1
}

is_integration_test() {
  local name="$1"
  case "$name" in
    test-integration-*|test-*-e2e*|test-hook-interaction-matrix*|test-schema-validation*|test-real-world-commands*|test-claude-wt*|test-worktree-context-integration*|test-review-enforcement-e2e*)
      return 0 ;;
    *)
      return 1 ;;
  esac
}

run_test_file() {
  local file="$1"
  local name
  name=$(basename "$file" .sh)

  echo ""
  echo "━━━ $name ━━━"

  local output exit_code
  output=$(bash "$file" 2>&1)
  exit_code=$?

  # Extract pass/fail counts from output
  local pass fail
  pass=$(echo "$output" | grep -oP '(\d+) passed' | grep -oP '\d+' | tail -1)
  fail=$(echo "$output" | grep -oP '(\d+) failed' | grep -oP '\d+' | tail -1)
  pass=${pass:-0}
  fail=${fail:-0}

  TOTAL_PASS=$((TOTAL_PASS + pass))
  TOTAL_FAIL=$((TOTAL_FAIL + fail))
  TOTAL_TESTS=$((TOTAL_TESTS + pass + fail))

  if [ "$exit_code" -ne 0 ] || [ "$fail" -gt 0 ]; then
    echo "$output" | grep -E '(FAIL|PASS):' | head -20
    echo "  RESULT: $pass passed, $fail failed"
    FAILED_FILES+=("$name")
  else
    echo "  RESULT: $pass passed, $fail failed"
  fi
}

# Auto-discover and classify tests
UNIT_TESTS=()
HARNESS_TESTS=()
for f in "$SCRIPT_DIR"/test-*.sh; do
  [ -f "$f" ] || continue
  local_name=$(basename "$f")
  is_excluded "$local_name" && continue
  if is_integration_test "$local_name"; then
    HARNESS_TESTS+=("$f")
  else
    UNIT_TESTS+=("$f")
  fi
done

# Python harness test
PYTHON_TEST="$SCRIPT_DIR/test_hooks.py"

echo "Hook Test Suite"
echo "==============="
echo "Discovered ${#UNIT_TESTS[@]} unit tests, ${#HARNESS_TESTS[@]} integration tests"

run_python_tests() {
  echo ""
  echo "━━━ test_hooks.py (pytest) ━━━"
  if ! command -v python3 &>/dev/null; then
    echo "  SKIP: python3 not available"
    return
  fi
  if ! python3 -c "import pytest" 2>/dev/null; then
    echo "  SKIP: pytest not installed (pip3 install pytest)"
    return
  fi

  local output exit_code
  output=$(python3 -m pytest "$PYTHON_TEST" -v --tb=short 2>&1)
  exit_code=$?

  local pass fail
  pass=$(echo "$output" | grep -oP '(\d+) passed' | grep -oP '\d+' | tail -1)
  fail=$(echo "$output" | grep -oP '(\d+) failed' | grep -oP '\d+' | tail -1)
  pass=${pass:-0}
  fail=${fail:-0}

  TOTAL_PASS=$((TOTAL_PASS + pass))
  TOTAL_FAIL=$((TOTAL_FAIL + fail))
  TOTAL_TESTS=$((TOTAL_TESTS + pass + fail))

  if [ "$exit_code" -ne 0 ] || [ "$fail" -gt 0 ]; then
    echo "$output" | grep -E '(PASSED|FAILED)' | head -20
    echo "  RESULT: $pass passed, $fail failed"
    FAILED_FILES+=("test_hooks.py")
  else
    echo "  RESULT: $pass passed, $fail failed"
  fi
}

case "$MODE" in
  --unit)
    echo "Running unit tests only..."
    for t in "${UNIT_TESTS[@]}"; do
      run_test_file "$t"
    done
    ;;
  --harness)
    echo "Running harness tests only..."
    for t in "${HARNESS_TESTS[@]}"; do
      run_test_file "$t"
    done
    run_python_tests
    ;;
  --python)
    echo "Running Python tests only..."
    run_python_tests
    ;;
  --quick)
    echo "Running quick subset..."
    run_python_tests
    ;;
  all|*)
    echo "Running all tests..."
    for t in "${UNIT_TESTS[@]}"; do
      run_test_file "$t"
    done
    for t in "${HARNESS_TESTS[@]}"; do
      run_test_file "$t"
    done
    run_python_tests
    ;;
esac

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "TOTAL: $TOTAL_TESTS tests, $TOTAL_PASS passed, $TOTAL_FAIL failed"

if [ ${#FAILED_FILES[@]} -gt 0 ]; then
  echo ""
  echo "FAILED FILES:"
  for f in "${FAILED_FILES[@]}"; do
    echo "  - $f"
  done
  echo ""
  exit 1
fi

echo "All tests passed."
exit 0
