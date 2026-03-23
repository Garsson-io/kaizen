#!/bin/bash
# auto-dent-lib.sh — Shared functions for the auto-dent trampoline.
#
# Extracted from auto-dent.sh so they can be tested independently (#595).
# Source from auto-dent.sh:  source "$SCRIPT_DIR/auto-dent-lib.sh"
# Source from tests:         source "$SCRIPT_DIR/auto-dent-lib.sh"

# State file I/O (using node for safe JSON handling)

# Read a key from state.json.
# Usage: value=$(ad_read_state "$state_file" "key")
ad_read_state() {
  local state_file="$1"
  local key="$2"
  node -e "
    const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    const v = s[process.argv[2]];
    console.log(v === null || v === undefined ? '' : String(v));
  " "$state_file" "$key"
}

# Update a key in state.json (atomic write with backup).
# Usage: ad_update_state "$state_file" "key" "value"
ad_update_state() {
  local state_file="$1"
  local key="$2"
  local val="$3"
  node -e "
    const fs = require('fs');
    const path = process.argv[1];
    const key = process.argv[2];
    const val = process.argv[3];
    // Validate key is a simple identifier (no injection)
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      console.error('[state-io] Invalid state key: ' + key);
      process.exit(1);
    }
    const s = JSON.parse(fs.readFileSync(path, 'utf8'));
    s[key] = val;
    const content = JSON.stringify(s, null, 2) + '\n';
    // Validate round-trip
    JSON.parse(content);
    // Backup + atomic write
    if (fs.existsSync(path)) fs.copyFileSync(path, path + '.bak');
    fs.writeFileSync(path + '.tmp', content);
    fs.renameSync(path + '.tmp', path);
  " "$state_file" "$key" "$val"
}

# Check whether a halt file exists. Sets SHUTTING_DOWN=true if so.
# Usage: ad_check_halt_file "$halt_file" "$state_file" && break
# Returns 0 if halt file found, 1 otherwise.
ad_check_halt_file() {
  local halt_file="$1"
  local state_file="$2"
  if [[ -n "$halt_file" && -f "$halt_file" ]]; then
    echo ">>> Halt file detected: $halt_file"
    ad_update_state "$state_file" stop_reason "halt file (remote request)"
    SHUTTING_DOWN=true
    return 0
  fi
  return 1
}

# Initialize a state.json file for a new batch.
# Usage: ad_init_state "$state_file" "$batch_id" "$guidance" "$batch_start" \
#          "$max_runs" "$cooldown" "$budget" "$max_budget" "$max_failures" \
#          "$kaizen_repo" "$host_repo" "$test_task" "$experiment" "$max_run_seconds"
ad_init_state() {
  local state_file="$1"
  local batch_id="$2"
  local guidance="$3"
  local batch_start="$4"
  local max_runs="$5"
  local cooldown="$6"
  local budget="$7"
  local max_budget="$8"
  local max_failures="$9"
  local kaizen_repo="${10}"
  local host_repo="${11}"
  local test_task="${12}"
  local experiment="${13}"
  local max_run_seconds="${14}"

  node -e "
    const fs = require('fs');
    const state = {
      batch_id: process.argv[2],
      guidance: process.argv[3],
      batch_start: parseInt(process.argv[4], 10),
      max_runs: parseInt(process.argv[5], 10),
      cooldown: parseInt(process.argv[6], 10),
      budget: process.argv[7] || null,
      max_budget: process.argv[8] || null,
      max_failures: parseInt(process.argv[9], 10),
      kaizen_repo: process.argv[10] || null,
      host_repo: process.argv[11] || null,
      run: 0,
      consecutive_failures: 0,
      current_cooldown: parseInt(process.argv[6], 10),
      stop_reason: '',
      prs: [],
      issues_filed: [],
      issues_closed: [],
      cases: [],
      last_issue: '',
      last_pr: '',
      last_case: '',
      last_branch: '',
      last_worktree: '',
      progress_issue: '',
      test_task: process.argv[12] === 'true',
      experiment: process.argv[13] === 'true',
      max_run_seconds: parseInt(process.argv[14], 10),
      last_heartbeat: 0
    };
    const content = JSON.stringify(state, null, 2) + '\n';
    // Validate output is valid JSON
    JSON.parse(content);
    fs.writeFileSync(process.argv[1], content);
  " "$state_file" "$batch_id" "$guidance" "$batch_start" \
    "$max_runs" "$cooldown" "$budget" "$max_budget" "$max_failures" \
    "$kaizen_repo" "$host_repo" "$test_task" "$experiment" "$max_run_seconds"
}

# Check whether the batch should stop due to reaching max runs.
# Usage: ad_check_max_runs "$next_run" "$max_runs"
# Returns 0 if should stop, 1 if ok to continue.
ad_check_max_runs() {
  local next_run="$1"
  local max_runs="$2"
  if [[ "$max_runs" -gt 0 && "$next_run" -gt "$max_runs" ]]; then
    return 0
  fi
  return 1
}

# Check whether the batch should stop due to consecutive failures.
# Usage: ad_check_consecutive_failures "$consec_fail" "$max_failures"
# Returns 0 if should stop, 1 if ok to continue.
ad_check_consecutive_failures() {
  local consec_fail="$1"
  local max_failures="$2"
  if [[ "$consec_fail" -ge "$max_failures" ]]; then
    return 0
  fi
  return 1
}

# Check whether the batch has exceeded its total budget.
# Usage: ad_check_budget "$state_file" "$max_budget"
# Returns 0 if budget exceeded, 1 if ok. Prints cost info to stdout.
ad_check_budget() {
  local state_file="$1"
  local max_budget="$2"

  if [[ -z "$max_budget" ]]; then
    return 1
  fi

  local total_cost
  total_cost=$(node -e "
    const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    const total = (s.run_history || []).reduce((sum, r) => sum + (r.cost_usd || 0), 0);
    console.log(total.toFixed(2));
  " "$state_file")

  local exceeded
  exceeded=$(node -e "console.log(parseFloat('$total_cost') >= parseFloat('$max_budget') ? 'yes' : 'no')")

  if [[ "$exceeded" = "yes" ]]; then
    echo "$total_cost"
    return 0
  fi

  local remaining
  remaining=$(node -e "console.log((parseFloat('$max_budget') - parseFloat('$total_cost')).toFixed(2))")
  echo "$total_cost $remaining"
  return 1
}

# Parse auto-dent CLI arguments into variables.
# Usage: eval "$(ad_parse_args "$@")"
# Outputs: variable assignments that can be eval'd.
ad_parse_args() {
  local max_runs=0
  local cooldown=30
  local budget=""
  local max_budget=""
  local max_failures=3
  local max_run_seconds=1200
  local dry_run=false
  local test_task=false
  local experiment=false
  local no_plan=false
  local guidance=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --help) echo "SHOW_HELP=true"; return 0 ;;
      --max-runs) max_runs="$2"; shift 2 ;;
      --cooldown) cooldown="$2"; shift 2 ;;
      --budget) budget="$2"; shift 2 ;;
      --max-budget) max_budget="$2"; shift 2 ;;
      --max-failures) max_failures="$2"; shift 2 ;;
      --max-run-seconds) max_run_seconds="$2"; shift 2 ;;
      --dry-run) dry_run=true; shift ;;
      --test-task) test_task=true; shift ;;
      --no-plan) no_plan=true; shift ;;
      --experiment) experiment=true; shift ;;
      -*) echo "PARSE_ERROR='Unknown option: $1'"; return 1 ;;
      *) guidance="$1"; shift ;;
    esac
  done

  cat <<EOF
MAX_RUNS=$max_runs
COOLDOWN=$cooldown
BUDGET="$budget"
MAX_BUDGET="$max_budget"
MAX_FAILURES=$max_failures
MAX_RUN_SECONDS=$max_run_seconds
DRY_RUN=$dry_run
TEST_TASK=$test_task
NO_PLAN=$no_plan
EXPERIMENT=$experiment
GUIDANCE="$guidance"
EOF
}
