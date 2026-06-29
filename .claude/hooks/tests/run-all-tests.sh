#!/bin/bash
# run-all-tests.sh — Run all hook tests (auto-discovered)
#
# Usage:
#   bash .claude/hooks/tests/run-all-tests.sh           # Run all
#   bash .claude/hooks/tests/run-all-tests.sh --unit     # Unit tests only
#   bash .claude/hooks/tests/run-all-tests.sh --harness  # Integration tests only
#   bash .claude/hooks/tests/run-all-tests.sh --quick    # Fast subset (python only)
#   KAIZEN_HOOK_TEST_JOBS=1 bash .claude/hooks/tests/run-all-tests.sh  # Serial shell files
#   bash .claude/hooks/tests/run-all-tests.sh --jobs 4  # Parallel shell file count
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
RUNNER_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
MODE="all"
REQUESTED_JOBS="${KAIZEN_HOOK_TEST_JOBS:-}"

source "$SCRIPT_DIR/runner-dist-isolation.sh"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --unit|--harness|--python|--quick)
      MODE="$1"
      shift
      ;;
    --jobs)
      if [ "$#" -ge 2 ] && [[ "${2:-}" != --* ]]; then
        REQUESTED_JOBS="$2"
        shift 2
      else
        REQUESTED_JOBS=""
        shift
      fi
      ;;
    all)
      MODE="all"
      shift
      ;;
    *)
      MODE="$1"
      shift
      ;;
  esac
done

default_jobs() {
  local cpus
  if command -v nproc &>/dev/null; then
    cpus=$(nproc 2>/dev/null || echo 4)
  else
    cpus=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)
  fi
  case "$cpus" in
    ''|*[!0-9]*) cpus=4 ;;
  esac
  if [ "$cpus" -lt 1 ]; then cpus=1; fi
  if [ "$cpus" -gt 8 ]; then cpus=8; fi
  echo "$cpus"
}

if [ -z "$REQUESTED_JOBS" ]; then
  SHELL_TEST_JOBS=$(default_jobs)
else
  SHELL_TEST_JOBS="$REQUESTED_JOBS"
fi
case "$SHELL_TEST_JOBS" in
  ''|*[!0-9]*) SHELL_TEST_JOBS=1 ;;
esac
if [ "$SHELL_TEST_JOBS" -lt 1 ]; then SHELL_TEST_JOBS=1; fi

TOTAL_PASS=0
TOTAL_FAIL=0
TOTAL_TESTS=0
FAILED_FILES=()
# Failing test identifiers collected for the #1518 owned-failure classifier
# (pytest nodeids; shell test file names). A failure is only tolerated if it is
# owned by an OPEN issue in .agents/kaizen/known-failures.json.
FAILED_IDS=()
# Failures we could NOT turn into a classifiable test id — a missing test runner,
# or a test process that failed without emitting parseable test ids. These are
# infrastructure failures, never registry-ownable, so they are ALWAYS fatal and
# can never be "tolerated" by the owned-failure classifier.
UNCLASSIFIABLE_FAIL=0

# Global test isolation: all hooks write state to temp dirs by default.
# This prevents tests from polluting production state directories
# (/tmp/.pr-review-state/, repo kaizen/audit/, etc.).
# Individual tests that call setup_test_env() will override with their own
# temp dirs, which is fine — the important thing is that NO test can
# accidentally write to production paths. (kaizen #373, #340, #448)
GLOBAL_TEST_STATE_DIR=$(mktemp -d "/tmp/.kaizen-test-state-XXXXXX")
GLOBAL_TEST_AUDIT_DIR=$(mktemp -d "/tmp/.kaizen-test-audit-XXXXXX")
export STATE_DIR="$GLOBAL_TEST_STATE_DIR"
export AUDIT_DIR="$GLOBAL_TEST_AUDIT_DIR"
export AUDIT_LOG="$GLOBAL_TEST_AUDIT_DIR/no-action.log"
export DEBUG_LOG="/dev/null"
export KAIZEN_TEST_RUNNER=1

setup_private_dist_if_symlink "$RUNNER_ROOT"

cleanup_global_isolation() {
  restore_private_dist
  rm -rf "$GLOBAL_TEST_STATE_DIR" "$GLOBAL_TEST_AUDIT_DIR"
}
trap cleanup_global_isolation EXIT

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
    # Show FAIL lines first (most important), then PASS for context
    echo "$output" | grep -E 'FAIL:' || true
    echo "$output" | grep -E 'FAILED TESTS:' -A 100 || true
    echo "  RESULT: $pass passed, $fail failed"
    FAILED_FILES+=("$name")
    # Shell suites report file-level granularity; register entries by file name.
    FAILED_IDS+=("$name")
  else
    echo "  RESULT: $pass passed, $fail failed"
  fi
}

run_test_file_capture() {
  local file="$1"
  local index="$2"
  local result_dir="$3"
  local name
  name=$(basename "$file" .sh)

  local output_file="$result_dir/$index.output"
  local meta_file="$result_dir/$index.meta"
  local state_dir audit_dir exit_code pass fail
  state_dir=$(mktemp -d "/tmp/.kaizen-test-state-$name-XXXXXX")
  audit_dir=$(mktemp -d "/tmp/.kaizen-test-audit-$name-XXXXXX")

  STATE_DIR="$state_dir" \
    AUDIT_DIR="$audit_dir" \
    AUDIT_LOG="$audit_dir/no-action.log" \
    DEBUG_LOG="/dev/null" \
    KAIZEN_TEST_RUNNER=1 \
    bash "$file" >"$output_file" 2>&1
  exit_code=$?

  pass=$(grep -oP '(\d+) passed' "$output_file" | grep -oP '\d+' | tail -1)
  fail=$(grep -oP '(\d+) failed' "$output_file" | grep -oP '\d+' | tail -1)
  pass=${pass:-0}
  fail=${fail:-0}

  printf '%s\t%s\t%s\t%s\n' "$name" "$exit_code" "$pass" "$fail" >"$meta_file"
  rm -rf "$state_dir" "$audit_dir"
  exit "$exit_code"
}

replay_captured_test() {
  local index="$1"
  local result_dir="$2"
  local meta_file="$result_dir/$index.meta"
  local output_file="$result_dir/$index.output"

  if [ ! -f "$meta_file" ]; then
    echo ""
    echo "━━━ unknown-$index ━━━"
    echo "  FAIL: runner did not produce metadata"
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
    UNCLASSIFIABLE_FAIL=$((UNCLASSIFIABLE_FAIL + 1))
    FAILED_FILES+=("unknown-$index")
    return
  fi

  local name exit_code pass fail
  IFS=$'\t' read -r name exit_code pass fail <"$meta_file"

  echo ""
  echo "━━━ $name ━━━"

  TOTAL_PASS=$((TOTAL_PASS + pass))
  TOTAL_FAIL=$((TOTAL_FAIL + fail))
  TOTAL_TESTS=$((TOTAL_TESTS + pass + fail))

  if [ "$exit_code" -ne 0 ] || [ "$fail" -gt 0 ]; then
    grep -E 'FAIL:' "$output_file" || true
    grep -E 'FAILED TESTS:' -A 100 "$output_file" || true
    echo "  RESULT: $pass passed, $fail failed"
    FAILED_FILES+=("$name")
    FAILED_IDS+=("$name")
  else
    echo "  RESULT: $pass passed, $fail failed"
  fi
}

run_shell_tests() {
  if [ "$#" -eq 0 ]; then
    return
  fi

  if [ "$SHELL_TEST_JOBS" -le 1 ]; then
    echo "Running shell test files serially..."
    for t in "$@"; do
      run_test_file "$t"
    done
    return
  fi

  echo "Running shell test files with $SHELL_TEST_JOBS parallel jobs..."
  local result_dir total launched idx
  result_dir=$(mktemp -d "/tmp/.kaizen-hook-test-results-XXXXXX")
  total=$#
  launched=0
  for t in "$@"; do
    while [ "$(jobs -rp | wc -l | tr -d ' ')" -ge "$SHELL_TEST_JOBS" ]; do
      sleep 0.1
    done
    launched=$((launched + 1))
    run_test_file_capture "$t" "$launched" "$result_dir" &
  done
  wait || true

  for idx in $(seq 1 "$total"); do
    replay_captured_test "$idx" "$result_dir"
  done
  rm -rf "$result_dir"
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

# Missing python3/pytest normally means a local "soft skip" — but in the
# required CI path that silent skip is exactly the #1481 ambiguity (green CI
# while the local hook lifecycle suite is red). Set KAIZEN_REQUIRE_PYTHON_TESTS=1
# (CI does) to make the absence of the runner a HARD failure instead.
python_runner_missing() {
  local reason="$1"
  if [ "${KAIZEN_REQUIRE_PYTHON_TESTS:-0}" = "1" ]; then
    echo "  FAIL: $reason — required in this path (KAIZEN_REQUIRE_PYTHON_TESTS=1). Install pytest (pip install pytest)."
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
    FAILED_FILES+=("test_hooks.py (runner unavailable: $reason)")
    # Infrastructure failure — not a registry-ownable test, so never tolerable.
    UNCLASSIFIABLE_FAIL=$((UNCLASSIFIABLE_FAIL + 1))
  else
    echo "  SKIP: $reason"
  fi
}

run_python_tests() {
  echo ""
  echo "━━━ test_hooks.py (pytest) ━━━"
  if ! command -v python3 &>/dev/null; then
    python_runner_missing "python3 not available"
    return
  fi
  if ! python3 -c "import pytest" 2>/dev/null; then
    python_runner_missing "pytest not installed (pip install pytest)"
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
    # Collect pytest nodeids ("FAILED <nodeid> - ...") for the #1518 classifier.
    local nodeids_before=${#FAILED_IDS[@]}
    while IFS= read -r nodeid; do
      [ -n "$nodeid" ] && FAILED_IDS+=("$nodeid")
    done < <(echo "$output" | grep -oP '^FAILED \K\S+' || true)
    # A pytest failure with no parseable nodeids (e.g. a collection/import error)
    # cannot be attributed to a registry entry — treat as unclassifiable (fatal).
    if [ "${#FAILED_IDS[@]}" -eq "$nodeids_before" ]; then
      UNCLASSIFIABLE_FAIL=$((UNCLASSIFIABLE_FAIL + 1))
    fi
  else
    echo "  RESULT: $pass passed, $fail failed"
  fi
}

case "$MODE" in
  --unit)
    echo "Running unit tests only..."
    run_shell_tests "${UNIT_TESTS[@]}"
    ;;
  --harness)
    echo "Running harness tests only..."
    run_shell_tests "${HARNESS_TESTS[@]}"
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
    run_shell_tests "${UNIT_TESTS[@]}" "${HARNESS_TESTS[@]}"
    run_python_tests
    ;;
esac

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "TOTAL: $TOTAL_TESTS tests, $TOTAL_PASS passed, $TOTAL_FAIL failed"

# #1518: a failure is forbidden from blocking only if it is OWNED by an OPEN
# tracking issue in .agents/kaizen/known-failures.json. Route every failure
# through the single classifier; unowned failures (or an unavailable classifier)
# fail the suite. The registry ships empty, so today any failure is fatal.
classify_failures() {
  [ ${#FAILED_IDS[@]} -eq 0 ] && return 0
  local root="$SCRIPT_DIR/../../.."
  local tsx="$root/node_modules/.bin/tsx"
  local cli="$root/scripts/known-failures-status.ts"
  if [ ! -x "$tsx" ] || [ ! -f "$cli" ]; then
    echo "  (known-failures classifier unavailable — treating failures as unowned)"
    return 1
  fi
  printf '%s\n' "${FAILED_IDS[@]}" | "$tsx" "$cli" --classify
}

if [ ${#FAILED_FILES[@]} -gt 0 ]; then
  echo ""
  echo "FAILED FILES:"
  for f in "${FAILED_FILES[@]}"; do
    echo "  - $f"
  done
  echo ""
  echo "━━━ owned-failure check (#1518) ━━━"
  if [ "$UNCLASSIFIABLE_FAIL" -gt 0 ]; then
    echo "  $UNCLASSIFIABLE_FAIL infrastructure failure(s) (missing runner / unattributable) — never tolerable."
  elif classify_failures; then
    echo "All failures are owned by tracked OPEN issues (#1518) — tolerated, not blocking."
    exit 0
  fi
  exit 1
fi

echo "All tests passed."
exit 0
