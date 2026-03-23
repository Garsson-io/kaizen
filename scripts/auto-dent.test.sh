#!/bin/bash
# auto-dent.test.sh — Tests for the auto-dent trampoline library (#595)
#
# Tests extracted functions from auto-dent-lib.sh:
#   - State file initialization (ad_init_state)
#   - State read/write (ad_read_state, ad_update_state)
#   - Halt file detection (ad_check_halt_file)
#   - Stop conditions (ad_check_max_runs, ad_check_consecutive_failures, ad_check_budget)
#   - Arg parsing (ad_parse_args)
#
# Usage:
#   bash scripts/auto-dent.test.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../.claude/hooks/tests/test-helpers.sh"
source "$SCRIPT_DIR/auto-dent-lib.sh"

# Setup
TEST_TMP=$(mktemp -d)
trap 'rm -rf "$TEST_TMP"' EXIT

echo "=== auto-dent-lib.sh tests ==="
echo ""

# ad_init_state: basic initialization produces valid JSON
echo "--- ad_init_state ---"

test_state="$TEST_TMP/state-basic.json"
ad_init_state "$test_state" "test-batch" "focus on hooks" "1711234567" \
  "10" "30" "5.00" "50.00" "3" "Garsson-io/kaizen" "Garsson-io/host" \
  "false" "false" "1200"

assert_eq "init: file exists" "true" "$([ -f "$test_state" ] && echo true || echo false)"
# Validate JSON is parseable
VALID=$(node -e "try { JSON.parse(require('fs').readFileSync('$test_state','utf8')); console.log('yes') } catch(e) { console.log('no') }")
assert_eq "init: valid JSON" "yes" "$VALID"
# Check fields
assert_eq "init: batch_id" "test-batch" "$(ad_read_state "$test_state" batch_id)"
assert_eq "init: guidance" "focus on hooks" "$(ad_read_state "$test_state" guidance)"
assert_eq "init: max_runs" "10" "$(ad_read_state "$test_state" max_runs)"
assert_eq "init: cooldown" "30" "$(ad_read_state "$test_state" cooldown)"
assert_eq "init: budget" "5.00" "$(ad_read_state "$test_state" budget)"
assert_eq "init: max_budget" "50.00" "$(ad_read_state "$test_state" max_budget)"
assert_eq "init: max_failures" "3" "$(ad_read_state "$test_state" max_failures)"
assert_eq "init: run" "0" "$(ad_read_state "$test_state" run)"
assert_eq "init: consecutive_failures" "0" "$(ad_read_state "$test_state" consecutive_failures)"
assert_eq "init: test_task" "false" "$(ad_read_state "$test_state" test_task)"
assert_eq "init: experiment" "false" "$(ad_read_state "$test_state" experiment)"
assert_eq "init: max_run_seconds" "1200" "$(ad_read_state "$test_state" max_run_seconds)"

# ad_init_state: guidance with special characters (quotes, newlines, unicode)
test_state_special="$TEST_TMP/state-special.json"
ad_init_state "$test_state_special" "special-batch" 'fix "quoted" strings & <html> chars' \
  "1711234567" "0" "30" "" "" "3" "" "" "false" "false" "1200"
VALID2=$(node -e "try { JSON.parse(require('fs').readFileSync('$test_state_special','utf8')); console.log('yes') } catch(e) { console.log('no') }")
assert_eq "init: special chars produce valid JSON" "yes" "$VALID2"
GUIDANCE_BACK=$(ad_read_state "$test_state_special" guidance)
assert_eq "init: special chars roundtrip" 'fix "quoted" strings & <html> chars' "$GUIDANCE_BACK"

# ad_init_state: empty budget/max_budget become null
assert_eq "init: empty budget is null" "" "$(ad_read_state "$test_state_special" budget)"
assert_eq "init: empty max_budget is null" "" "$(ad_read_state "$test_state_special" max_budget)"

# ad_init_state: test_task=true
test_state_tt="$TEST_TMP/state-testtask.json"
ad_init_state "$test_state_tt" "tt-batch" "synthetic" "1711234567" \
  "5" "10" "" "" "3" "" "" "true" "true" "600"
assert_eq "init: test_task=true" "true" "$(ad_read_state "$test_state_tt" test_task)"
assert_eq "init: experiment=true" "true" "$(ad_read_state "$test_state_tt" experiment)"

echo ""
echo "--- ad_read_state / ad_update_state ---"

# ad_read_state: reads existing key
assert_eq "read: existing key" "test-batch" "$(ad_read_state "$test_state" batch_id)"

# ad_read_state: missing key returns empty
assert_eq "read: missing key" "" "$(ad_read_state "$test_state" nonexistent_key)"

# ad_update_state: updates a key
ad_update_state "$test_state" "run" "5"
assert_eq "update: run changed to 5" "5" "$(ad_read_state "$test_state" run)"

# ad_update_state: creates backup file
assert_eq "update: backup exists" "true" "$([ -f "$test_state.bak" ] && echo true || echo false)"

# ad_update_state: result is still valid JSON
VALID3=$(node -e "try { JSON.parse(require('fs').readFileSync('$test_state','utf8')); console.log('yes') } catch(e) { console.log('no') }")
assert_eq "update: valid JSON after update" "yes" "$VALID3"

# ad_update_state: rejects invalid keys
UPDATE_ERR=$(ad_update_state "$test_state" "invalid key!" "value" 2>&1) || true
assert_eq "update: key still 5 after bad key" "5" "$(ad_read_state "$test_state" run)"

# ad_update_state: value with special chars
ad_update_state "$test_state" "stop_reason" 'signal (SIGTERM/SIGINT) at "time"'
assert_eq "update: special chars in value" 'signal (SIGTERM/SIGINT) at "time"' "$(ad_read_state "$test_state" stop_reason)"

# Reset stop_reason for subsequent tests
ad_update_state "$test_state" "stop_reason" ""

echo ""
echo "--- ad_check_halt_file ---"

# No halt file — should return 1
SHUTTING_DOWN=false
HALT_DIR="$TEST_TMP/halt-test"
mkdir -p "$HALT_DIR"
HALT_TEST_FILE="$HALT_DIR/HALT"
HALT_STATE="$TEST_TMP/halt-state.json"
ad_init_state "$HALT_STATE" "halt-batch" "test" "1711234567" \
  "0" "30" "" "" "3" "" "" "false" "false" "1200"

if ad_check_halt_file "$HALT_TEST_FILE" "$HALT_STATE" 2>/dev/null; then
  assert_eq "halt: no file returns 1" "false" "true"
else
  assert_eq "halt: no file returns 1" "false" "false"
fi
assert_eq "halt: SHUTTING_DOWN still false" "false" "$SHUTTING_DOWN"

# Create halt file — should return 0
touch "$HALT_TEST_FILE"
if ad_check_halt_file "$HALT_TEST_FILE" "$HALT_STATE" 2>/dev/null; then
  assert_eq "halt: file present returns 0" "true" "true"
else
  assert_eq "halt: file present returns 0" "true" "false"
fi
assert_eq "halt: SHUTTING_DOWN set to true" "true" "$SHUTTING_DOWN"
HALT_REASON=$(ad_read_state "$HALT_STATE" stop_reason)
assert_contains "halt: stop_reason updated" "halt file" "$HALT_REASON"

# Empty halt file path — should return 1
SHUTTING_DOWN=false
if ad_check_halt_file "" "$HALT_STATE" 2>/dev/null; then
  assert_eq "halt: empty path returns 1" "false" "true"
else
  assert_eq "halt: empty path returns 1" "false" "false"
fi

echo ""
echo "--- ad_check_max_runs ---"

# Within limit
if ad_check_max_runs 5 10; then
  assert_eq "max_runs: 5/10 ok" "false" "true"
else
  assert_eq "max_runs: 5/10 ok" "false" "false"
fi

# At limit
if ad_check_max_runs 11 10; then
  assert_eq "max_runs: 11/10 stop" "true" "true"
else
  assert_eq "max_runs: 11/10 stop" "true" "false"
fi

# Exact boundary
if ad_check_max_runs 10 10; then
  assert_eq "max_runs: 10/10 ok (not exceeded)" "false" "true"
else
  assert_eq "max_runs: 10/10 ok (not exceeded)" "false" "false"
fi

# Unlimited (max_runs=0)
if ad_check_max_runs 999 0; then
  assert_eq "max_runs: unlimited ok" "false" "true"
else
  assert_eq "max_runs: unlimited ok" "false" "false"
fi

echo ""
echo "--- ad_check_consecutive_failures ---"

# Below threshold
if ad_check_consecutive_failures 2 3; then
  assert_eq "consec_fail: 2/3 ok" "false" "true"
else
  assert_eq "consec_fail: 2/3 ok" "false" "false"
fi

# At threshold
if ad_check_consecutive_failures 3 3; then
  assert_eq "consec_fail: 3/3 stop" "true" "true"
else
  assert_eq "consec_fail: 3/3 stop" "true" "false"
fi

# Above threshold
if ad_check_consecutive_failures 5 3; then
  assert_eq "consec_fail: 5/3 stop" "true" "true"
else
  assert_eq "consec_fail: 5/3 stop" "true" "false"
fi

echo ""
echo "--- ad_check_budget ---"

# Budget exceeded
BUDGET_STATE="$TEST_TMP/budget-state.json"
ad_init_state "$BUDGET_STATE" "budget-batch" "test" "1711234567" \
  "0" "30" "5.00" "10.00" "3" "" "" "false" "false" "1200"
# Add run_history with costs that exceed budget
node -e "
  const fs = require('fs');
  const s = JSON.parse(fs.readFileSync('$BUDGET_STATE', 'utf8'));
  s.run_history = [
    { run: 1, cost_usd: 4.50, duration_seconds: 100, tool_calls: 10, exit_code: 0, prs: [] },
    { run: 2, cost_usd: 3.50, duration_seconds: 100, tool_calls: 10, exit_code: 0, prs: [] },
    { run: 3, cost_usd: 3.00, duration_seconds: 100, tool_calls: 10, exit_code: 0, prs: [] }
  ];
  fs.writeFileSync('$BUDGET_STATE', JSON.stringify(s, null, 2) + '\n');
"
BUDGET_OUT=$(ad_check_budget "$BUDGET_STATE" "10.00") && BUDGET_EXCEEDED=true || BUDGET_EXCEEDED=false
assert_eq "budget: 11.00 >= 10.00 stops" "true" "$BUDGET_EXCEEDED"
assert_eq "budget: reports total cost" "11.00" "$BUDGET_OUT"

# Budget not exceeded
BUDGET_STATE2="$TEST_TMP/budget-state2.json"
ad_init_state "$BUDGET_STATE2" "budget-batch2" "test" "1711234567" \
  "0" "30" "5.00" "50.00" "3" "" "" "false" "false" "1200"
node -e "
  const fs = require('fs');
  const s = JSON.parse(fs.readFileSync('$BUDGET_STATE2', 'utf8'));
  s.run_history = [
    { run: 1, cost_usd: 4.50, duration_seconds: 100, tool_calls: 10, exit_code: 0, prs: [] }
  ];
  fs.writeFileSync('$BUDGET_STATE2', JSON.stringify(s, null, 2) + '\n');
"
BUDGET_OUT2=$(ad_check_budget "$BUDGET_STATE2" "50.00") && BUDGET_EXCEEDED2=true || BUDGET_EXCEEDED2=false
assert_eq "budget: 4.50 < 50.00 continues" "false" "$BUDGET_EXCEEDED2"
assert_contains "budget: reports remaining" "45.50" "$BUDGET_OUT2"

# No max_budget — always continues
BUDGET_OUT3=$(ad_check_budget "$BUDGET_STATE2" "") && BUDGET_EXCEEDED3=true || BUDGET_EXCEEDED3=false
assert_eq "budget: empty max_budget continues" "false" "$BUDGET_EXCEEDED3"

echo ""
echo "--- ad_parse_args ---"

# Basic guidance only
PARSE_OUT=$(ad_parse_args "focus on hooks")
assert_contains "parse: guidance" 'GUIDANCE="focus on hooks"' "$PARSE_OUT"
assert_contains "parse: defaults max_runs" "MAX_RUNS=0" "$PARSE_OUT"
assert_contains "parse: defaults cooldown" "COOLDOWN=30" "$PARSE_OUT"
assert_contains "parse: defaults dry_run" "DRY_RUN=false" "$PARSE_OUT"

# All flags
PARSE_OUT2=$(ad_parse_args --max-runs 5 --cooldown 60 --budget 3.00 --max-budget 25.00 \
  --max-failures 5 --max-run-seconds 900 --dry-run --test-task --no-plan --experiment "my guidance")
assert_contains "parse: max_runs=5" "MAX_RUNS=5" "$PARSE_OUT2"
assert_contains "parse: cooldown=60" "COOLDOWN=60" "$PARSE_OUT2"
assert_contains "parse: budget=3.00" 'BUDGET="3.00"' "$PARSE_OUT2"
assert_contains "parse: max_budget=25.00" 'MAX_BUDGET="25.00"' "$PARSE_OUT2"
assert_contains "parse: max_failures=5" "MAX_FAILURES=5" "$PARSE_OUT2"
assert_contains "parse: max_run_seconds=900" "MAX_RUN_SECONDS=900" "$PARSE_OUT2"
assert_contains "parse: dry_run=true" "DRY_RUN=true" "$PARSE_OUT2"
assert_contains "parse: test_task=true" "TEST_TASK=true" "$PARSE_OUT2"
assert_contains "parse: no_plan=true" "NO_PLAN=true" "$PARSE_OUT2"
assert_contains "parse: experiment=true" "EXPERIMENT=true" "$PARSE_OUT2"
assert_contains "parse: guidance" 'GUIDANCE="my guidance"' "$PARSE_OUT2"

# Unknown flag
PARSE_OUT3=$(ad_parse_args --unknown-flag 2>&1) || true
assert_contains "parse: unknown flag error" "PARSE_ERROR" "$PARSE_OUT3"

# Help flag
PARSE_OUT4=$(ad_parse_args --help 2>&1)
assert_contains "parse: help flag" "SHOW_HELP=true" "$PARSE_OUT4"

# Guidance with special characters
PARSE_OUT5=$(ad_parse_args 'fix "hooks" & <scripts>')
assert_contains "parse: special chars in guidance" 'fix "hooks" & <scripts>' "$PARSE_OUT5"

echo ""
echo "--- Subcommand dispatch (dry-run validation) ---"

# Verify auto-dent.sh --dry-run produces valid JSON state
DRY_OUT=$("$SCRIPT_DIR/auto-dent.sh" --dry-run "test guidance" 2>&1) || true
assert_contains "dry-run: shows state file" "batch_id" "$DRY_OUT"
assert_contains "dry-run: shows guidance" "test guidance" "$DRY_OUT"

echo ""

print_results
