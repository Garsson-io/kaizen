#!/bin/bash
# auto-dent — Autonomous batch kaizen runner (trampoline).
#
# Thin outer loop that:
#   1. Parses args and creates the batch
#   2. Pulls main between runs (so merged improvements take effect)
#   3. Delegates each run to auto-dent-run.sh (re-read from disk each time)
#   4. Prints the batch summary when done
#
# All real logic (prompt building, output parsing, stream-json observability)
# lives in auto-dent-run.sh → auto-dent-run.ts, which self-updates
# when PRs merge to main.
#
# Cross-run state is persisted to $LOG_DIR/state.json — survives crashes,
# enables future --resume, and provides reporting data.
#
# Usage:
#   ./scripts/auto-dent.sh "focus on hooks reliability"
#   ./scripts/auto-dent.sh --max-runs 5 --budget 5.00 "improve test coverage"
#   ./scripts/auto-dent.sh --dry-run "test the prompt"
#
# Logs go to logs/auto-dent/<batch-id>/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Always resolve to the main checkout (not a worktree)
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's|/\.git$||')"
if [[ -z "$REPO_ROOT" ]]; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

# Read repo from kaizen.config.json
CONFIG_FILE="$REPO_ROOT/kaizen.config.json"
if [[ -f "$CONFIG_FILE" ]]; then
  KAIZEN_REPO=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$CONFIG_FILE','utf8')).kaizen?.repo || '')")
  HOST_REPO=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$CONFIG_FILE','utf8')).host?.repo || '')")
else
  echo "Warning: kaizen.config.json not found at $CONFIG_FILE" >&2
  KAIZEN_REPO=""
  HOST_REPO=""
fi

# Defaults
MAX_RUNS=0              # 0 = unlimited
COOLDOWN=30             # seconds between runs
BUDGET=""               # per-run budget
MAX_BUDGET=""           # total batch budget
MAX_FAILURES=3          # consecutive failures before stopping
MAX_RUN_SECONDS=1200    # 20 minutes per run (wall-time timeout, #686)
DRY_RUN=false
TEST_TASK=false
EXPERIMENT=false
NO_PLAN=false
GUIDANCE=""

usage() {
  cat <<'EOF'
auto-dent — Autonomous batch kaizen runner

Usage: auto-dent.sh [options] <guidance>
       auto-dent.sh --status
       auto-dent.sh --halt [batch-id]
       auto-dent.sh --score [--post-hoc] [batch-id]
       auto-dent.sh --watchdog [--threshold N]

Options:
  --max-runs N         Stop after N iterations (default: unlimited)
  --cooldown N         Seconds between runs (default: 30)
  --budget N.NN        Max USD per run (passed to claude --max-budget-usd)
  --max-budget N.NN    Max USD for entire batch (stops when cumulative cost exceeds)
  --max-failures N     Stop after N consecutive failures (default: 3)
  --max-run-seconds N  Wall-time timeout per run in seconds (default: 1200 = 20min)
  --no-plan            Skip planning pre-pass (use discovery mode)
  --dry-run            Show what would run without executing
  --test-task          Use synthetic fast task instead of /kaizen-deep-dive
  --experiment         Enable extra pipeline diagnostics
  --status             Show status of all batches (active and stopped)
  --halt [batch-id]    Halt a specific batch, or all active batches
  --score [batch-id]   Score batch(es) — efficiency, success rate, cost-per-PR
  --cleanup [batch-id] Close superseded PRs whose issues are already resolved
  --reflect [batch-id] Cross-run pattern analysis and learning
  --reflect --prompt [batch-id]  Output rendered reflection prompt for Claude
  --history            Cross-batch aggregate stats (all-time metrics)
  --trends             Cross-batch trend analysis (cost/PR, success rate over time)
  --aggregate [batch-id]  Append batch(es) to aggregate.jsonl (backfill)
  --watchdog [--threshold N]  Check heartbeats, halt stale batches (default: 600s)
  --help               Show this help

Self-update: between runs, the trampoline pulls main so that merged
improvements to the runner script take effect on the next iteration.

Halt: Ctrl+C halts from the same terminal. From another terminal:
  ./scripts/auto-dent.sh --halt              # halt all active
  ./scripts/auto-dent.sh --halt batch-id     # halt one batch

Examples:
  ./scripts/auto-dent.sh "focus on hooks reliability"
  ./scripts/auto-dent.sh --max-runs 5 --budget 5.00 "improve test coverage"
  ./scripts/auto-dent.sh --max-budget 50.00 --budget 5.00 "fix area/skills issues"
EOF
  exit 0
}

# Subcommands (handled before main arg parsing)
CTL_SCRIPT="$SCRIPT_DIR/auto-dent-ctl.ts"

if [[ "${1:-}" = "--status" ]]; then
  exec npx tsx "$CTL_SCRIPT" status
fi

if [[ "${1:-}" = "--halt" ]]; then
  shift
  exec npx tsx "$CTL_SCRIPT" halt "$@"
fi

if [[ "${1:-}" = "--score" ]]; then
  shift
  exec npx tsx "$CTL_SCRIPT" score "$@"
fi

if [[ "${1:-}" = "--cleanup" ]]; then
  shift
  exec npx tsx "$CTL_SCRIPT" cleanup "$@"
fi

if [[ "${1:-}" = "--reflect" ]]; then
  shift
  exec npx tsx "$CTL_SCRIPT" reflect "$@"
fi

if [[ "${1:-}" = "--watchdog" ]]; then
  shift
  exec npx tsx "$CTL_SCRIPT" watchdog "$@"
fi

if [[ "${1:-}" = "--history" ]]; then
  exec npx tsx "$CTL_SCRIPT" history
fi

if [[ "${1:-}" = "--aggregate" ]]; then
  shift
  exec npx tsx "$CTL_SCRIPT" aggregate "$@"
fi

if [[ "${1:-}" = "--trends" ]]; then
  shift
  exec npx tsx "$SCRIPT_DIR/batch-trends.ts" "$REPO_ROOT/logs/auto-dent" "$@"
fi

# Arg parsing
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help) usage ;;
    --max-runs) MAX_RUNS="$2"; shift 2 ;;
    --cooldown) COOLDOWN="$2"; shift 2 ;;
    --budget) BUDGET="$2"; shift 2 ;;
    --max-budget) MAX_BUDGET="$2"; shift 2 ;;
    --max-failures) MAX_FAILURES="$2"; shift 2 ;;
    --max-run-seconds) MAX_RUN_SECONDS="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --test-task) TEST_TASK=true; shift ;;
    --no-plan) NO_PLAN=true; shift ;;
    --experiment) EXPERIMENT=true; shift ;;
    -*) echo "Unknown option: $1" >&2; exit 1 ;;
    *) GUIDANCE="$1"; shift ;;
  esac
done

if [[ -z "$GUIDANCE" && "$TEST_TASK" != true ]]; then
  echo "Error: guidance prompt is required (or use --test-task)" >&2
  echo "Usage: auto-dent.sh [options] <guidance>" >&2
  exit 1
fi

# Default guidance for test-task mode
if [[ -z "$GUIDANCE" && "$TEST_TASK" = true ]]; then
  GUIDANCE="synthetic pipeline test"
fi

# Batch identity
BATCH_ID="batch-$(date +%y%m%d-%H%M)-$(printf '%04x' $RANDOM)"
BATCH_START=$(date +%s)
LOG_DIR="$REPO_ROOT/logs/auto-dent/$BATCH_ID"
mkdir -p "$LOG_DIR"
HALT_FILE="$LOG_DIR/HALT"

# Initialize state file
STATE_FILE="$LOG_DIR/state.json"

# JSON-escape guidance using node
GUIDANCE_JSON=$(node -e "process.stdout.write(JSON.stringify(process.argv[1]))" "$GUIDANCE")
BUDGET_JSON=$(if [[ -n "$BUDGET" ]]; then echo "\"$BUDGET\""; else echo "null"; fi)
MAX_BUDGET_JSON=$(if [[ -n "$MAX_BUDGET" ]]; then echo "\"$MAX_BUDGET\""; else echo "null"; fi)
KAIZEN_REPO_JSON=$(node -e "process.stdout.write(JSON.stringify(process.argv[1]))" "${KAIZEN_REPO:-}")
HOST_REPO_JSON=$(node -e "process.stdout.write(JSON.stringify(process.argv[1]))" "${HOST_REPO:-}")

cat > "$STATE_FILE" << STATEOF
{
  "batch_id": "$BATCH_ID",
  "guidance": $GUIDANCE_JSON,
  "batch_start": $BATCH_START,
  "max_runs": $MAX_RUNS,
  "cooldown": $COOLDOWN,
  "budget": $BUDGET_JSON,
  "max_budget": $MAX_BUDGET_JSON,
  "max_failures": $MAX_FAILURES,
  "kaizen_repo": $KAIZEN_REPO_JSON,
  "host_repo": $HOST_REPO_JSON,
  "run": 0,
  "consecutive_failures": 0,
  "current_cooldown": $COOLDOWN,
  "stop_reason": "",
  "prs": [],
  "issues_filed": [],
  "issues_closed": [],
  "cases": [],
  "last_issue": "",
  "last_pr": "",
  "last_case": "",
  "last_branch": "",
  "last_worktree": "",
  "progress_issue": "",
  "test_task": $TEST_TASK,
  "experiment": $EXPERIMENT,
  "max_run_seconds": $MAX_RUN_SECONDS,
  "last_heartbeat": 0
}
STATEOF

# State helpers (using node)
read_state() {
  node -e "
    const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    const v = s[process.argv[2]];
    console.log(v === null || v === undefined ? '' : String(v));
  " "$STATE_FILE" "$1"
}

update_state() {
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
  " "$STATE_FILE" "$1" "$2"
}

# Graceful shutdown
SHUTTING_DOWN=false

handle_shutdown() {
  if [[ "$SHUTTING_DOWN" = true ]]; then return; fi
  SHUTTING_DOWN=true
  echo ""
  echo ">>> Received shutdown signal. Finishing current run, then stopping..."
  update_state stop_reason "signal (SIGTERM/SIGINT)"
}
trap handle_shutdown SIGTERM SIGINT

print_last_state() {
  if [[ -n "$STATE_FILE" && -f "$STATE_FILE" ]]; then
    npx tsx "$CTL_SCRIPT" halt-state "$STATE_FILE" 2>/dev/null || true
  fi
}

check_halt_file() {
  if [[ -n "$HALT_FILE" && -f "$HALT_FILE" ]]; then
    echo ">>> Halt file detected: $HALT_FILE"
    update_state stop_reason "halt file (remote request)"
    SHUTTING_DOWN=true
    return 0
  fi
  return 1
}

# Banner
echo "╔══════════════════════════════════════════════════════════╗"
echo "║                 auto-dent (trampoline)                  ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║ Batch ID:  $BATCH_ID"
echo "║ Guidance:  $GUIDANCE"
echo "║ Max runs:  $([ "$MAX_RUNS" -eq 0 ] && echo "unlimited" || echo "$MAX_RUNS")"
echo "║ Cooldown:  ${COOLDOWN}s"
[[ -n "$BUDGET" ]] && echo "║ Budget/run: \$$BUDGET"
[[ -n "$MAX_BUDGET" ]] && echo "║ Max budget: \$$MAX_BUDGET (total batch)"
echo "║ Run timeout: ${MAX_RUN_SECONDS}s ($(( MAX_RUN_SECONDS / 60 ))min)"
[[ "$TEST_TASK" = true ]] && echo "║ Mode:      TEST TASK (synthetic pipeline probe)"
[[ "$EXPERIMENT" = true ]] && echo "║ Experiment: enabled (extra diagnostics)"
echo "║ Max consecutive failures: $MAX_FAILURES"
[[ -n "$KAIZEN_REPO" ]] && echo "║ Kaizen repo: $KAIZEN_REPO"
[[ -n "$HOST_REPO" ]] && echo "║ Host repo:   $HOST_REPO"
echo "║ Logs:      $LOG_DIR"
echo "║ State:     $STATE_FILE"
echo "║ Halt:      touch $HALT_FILE  (or --halt from another terminal)"
echo "║ Self-update: enabled (pulls main between runs)"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

if [[ "$MAX_RUNS" -eq 0 && -z "$MAX_BUDGET" ]]; then
  echo "⚠  WARNING: No --max-runs or --max-budget set. This batch will run indefinitely."
  echo "   Consider: --max-budget 50.00 or --max-runs 20"
  echo ""
fi

if [[ "$DRY_RUN" = true ]]; then
  echo "[dry-run] Would execute per run:"
  echo "  $REPO_ROOT/scripts/auto-dent-run.sh $STATE_FILE"
  echo ""
  echo "[dry-run] State file:"
  cat "$STATE_FILE"
  exit 0
fi

# Planning pre-pass: scan backlog and produce plan.json before the loop.
# Non-fatal: if planning fails, runs proceed in discovery mode.
PLAN_SCRIPT="$SCRIPT_DIR/auto-dent-plan.ts"
if [[ -f "$PLAN_SCRIPT" && "$TEST_TASK" != true && "$NO_PLAN" != true ]]; then
  echo ">>> Running planning pre-pass..."
  if npx tsx "$PLAN_SCRIPT" "$STATE_FILE" 2>&1; then
    if [[ -f "$LOG_DIR/plan.json" ]]; then
      PLAN_ITEMS=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$LOG_DIR/plan.json','utf8')).items.length)")
      echo ">>> Plan ready: $PLAN_ITEMS items queued."
      # Post plan summary to batch progress issue (#566)
      npx tsx "$SCRIPT_DIR/auto-dent-run.ts" --post-plan "$STATE_FILE" 2>/dev/null || echo ">>> Plan posting skipped (non-fatal)."
    fi
  else
    echo ">>> Planning skipped (non-fatal). Runs will use discovery mode."
  fi
  echo ""
fi

# Main loop (trampoline)
while true; do
  if [[ "$SHUTTING_DOWN" = true ]]; then break; fi
  check_halt_file && break

  # Read current state
  RUN=$(read_state run)
  CONSEC_FAIL=$(read_state consecutive_failures)
  CUR_COOLDOWN=$(read_state current_cooldown)
  STOP_REASON=$(read_state stop_reason)
  NEXT_RUN=$((RUN + 1))

  # Stop conditions
  if [[ -n "$STOP_REASON" ]]; then
    echo ">>> Stopping: $STOP_REASON"
    break
  fi

  if [[ "$MAX_RUNS" -gt 0 && "$NEXT_RUN" -gt "$MAX_RUNS" ]]; then
    update_state stop_reason "max runs reached ($MAX_RUNS)"
    break
  fi

  if [[ "$CONSEC_FAIL" -ge "$MAX_FAILURES" ]]; then
    echo ">>> Stopping: $MAX_FAILURES consecutive failures"
    update_state stop_reason "$MAX_FAILURES consecutive failures"
    break
  fi

  # Budget exhaustion check
  if [[ -n "$MAX_BUDGET" ]]; then
    TOTAL_COST=$(node -e "
      const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
      const total = (s.run_history || []).reduce((sum, r) => sum + (r.cost_usd || 0), 0);
      console.log(total.toFixed(2));
    " "$STATE_FILE")
    BUDGET_EXCEEDED=$(node -e "console.log(parseFloat('$TOTAL_COST') >= parseFloat('$MAX_BUDGET') ? 'yes' : 'no')")
    if [[ "$BUDGET_EXCEEDED" = "yes" ]]; then
      echo ">>> Stopping: total cost \$$TOTAL_COST >= max budget \$$MAX_BUDGET"
      update_state stop_reason "budget exhausted (\$$TOTAL_COST >= \$$MAX_BUDGET)"
      break
    fi
    BUDGET_REMAINING=$(node -e "console.log((parseFloat('$MAX_BUDGET') - parseFloat('$TOTAL_COST')).toFixed(2))")
    echo ">>> Budget: \$$TOTAL_COST spent / \$$MAX_BUDGET max (\$$BUDGET_REMAINING remaining)"
  fi

  # Self-update: pull main before each run
  if [[ "$EXPERIMENT" = true ]]; then
    MAIN_HEAD_BEFORE=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo "unknown")
    echo ">>> [experiment] main HEAD before pull: ${MAIN_HEAD_BEFORE:0:8}"
  fi
  echo ">>> Pulling main for self-update..."
  if git -C "$REPO_ROOT" pull --ff-only origin main 2>/dev/null; then
    echo ">>> Main updated."
  else
    echo ">>> Main already up-to-date (or pull failed, continuing with current)."
  fi
  if [[ "$EXPERIMENT" = true ]]; then
    MAIN_HEAD_AFTER=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo "unknown")
    echo ">>> [experiment] main HEAD after pull: ${MAIN_HEAD_AFTER:0:8}"
    if [[ "$MAIN_HEAD_BEFORE" != "$MAIN_HEAD_AFTER" ]]; then
      echo ">>> [experiment] main ADVANCED (PR merged between runs)"
    else
      echo ">>> [experiment] main UNCHANGED (no PR merged yet)"
    fi
  fi

  # Clean up superseded PRs between runs (issue #362)
  if [[ "$NEXT_RUN" -gt 1 ]]; then
    echo ">>> Cleaning up superseded PRs..."
    npx tsx "$CTL_SCRIPT" cleanup "$BATCH_ID" 2>/dev/null || echo ">>> Cleanup skipped (non-fatal)."
  fi

  # Cross-run reflection every 5 runs (issue #551, #571)
  if [[ "$NEXT_RUN" -gt 1 ]] && (( (NEXT_RUN - 1) % 5 == 0 )); then
    echo ">>> Running cross-run reflection (every 5 runs)..."
    if npx tsx "$CTL_SCRIPT" reflect --post "$BATCH_ID" 2>/dev/null; then
      echo ">>> Reflection complete (posted to progress issue)."
    else
      echo ">>> Reflection skipped (non-fatal)."
    fi
  fi

  # Resolve runner (re-resolve after pull in case it was updated)
  RUNNER="$REPO_ROOT/scripts/auto-dent-run.sh"
  if [[ ! -x "$RUNNER" ]]; then
    echo ">>> ERROR: Runner not found: $RUNNER"
    update_state stop_reason "runner not found"
    break
  fi

  # Execute the runner (re-read from disk each time)
  echo "━━━ Run #$NEXT_RUN starting at $(date) ━━━"
  EXIT_CODE=0
  "$RUNNER" "$STATE_FILE" || EXIT_CODE=$?

  # Runner updates state.json with results. Check for stop signal.
  STOP_REASON=$(read_state stop_reason)
  if [[ -n "$STOP_REASON" ]]; then
    echo ">>> Stopping: $STOP_REASON"
    break
  fi

  if [[ "$SHUTTING_DOWN" = true ]]; then break; fi

  # Cross-run progress
  COMPLETED_RUNS=$(read_state run)
  CONSEC_FAIL=$(read_state consecutive_failures)
  CUR_COOLDOWN=$(read_state current_cooldown)
  PR_COUNT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$STATE_FILE','utf8')).prs.length)")
  CLOSED_COUNT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$STATE_FILE','utf8')).issues_closed.length)")
  ELAPSED=$(( $(date +%s) - BATCH_START ))
  HOURS=$(( ELAPSED / 3600 ))
  MINS=$(( (ELAPSED % 3600) / 60 ))
  RUNS_LABEL="$COMPLETED_RUNS"
  [[ "$MAX_RUNS" -gt 0 ]] && RUNS_LABEL="$COMPLETED_RUNS/$MAX_RUNS"

  echo "━━━ Batch Progress ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Runs: $RUNS_LABEL completed | $CONSEC_FAIL consecutive failures"
  echo "  PRs:  $PR_COUNT created | Issues: $CLOSED_COUNT closed"
  echo "  Time: ${HOURS}h ${MINS}m elapsed"
  if [[ "$EXPERIMENT" = true ]]; then
    BATCH_KAIZEN_REPO=$(read_state kaizen_repo)
    ALL_PRS=$(node -e "JSON.parse(require('fs').readFileSync('$STATE_FILE','utf8')).prs.forEach(p=>console.log(p))")
    for PR_URL in $ALL_PRS; do
      PR_NUM=$(echo "$PR_URL" | grep -oE '[0-9]+$')
      PR_REPO=$(echo "$PR_URL" | grep -oP 'github\.com/\K[^/]+/[^/]+')
      PR_STATE=$(gh pr view "$PR_NUM" --repo "$PR_REPO" --json state,mergeStateStatus,autoMergeRequest --jq '.state + " | " + .mergeStateStatus + " | auto:" + (if .autoMergeRequest then "yes" else "no" end)' 2>/dev/null || echo "unknown")
      echo "  [experiment] PR #$PR_NUM: $PR_STATE"
    done
  fi
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # Check max-runs after run
  if [[ "$MAX_RUNS" -gt 0 && "$COMPLETED_RUNS" -ge "$MAX_RUNS" ]]; then
    update_state stop_reason "max runs reached ($MAX_RUNS)"
    break
  fi

  if [[ "$SHUTTING_DOWN" = true ]]; then break; fi
  check_halt_file && break

  # Cooldown with halt file polling (check every 3s)
  echo "Cooling down for ${CUR_COOLDOWN}s before next run... (touch $HALT_FILE to stop)"
  COOLDOWN_REMAINING=$CUR_COOLDOWN
  while [[ "$COOLDOWN_REMAINING" -gt 0 ]]; do
    POLL_INTERVAL=$(( COOLDOWN_REMAINING < 3 ? COOLDOWN_REMAINING : 3 ))
    sleep "$POLL_INTERVAL" &
    SLEEP_PID=$!
    wait $SLEEP_PID 2>/dev/null || true
    COOLDOWN_REMAINING=$((COOLDOWN_REMAINING - POLL_INTERVAL))
    if [[ "$SHUTTING_DOWN" = true ]]; then break; fi
    check_halt_file && break 2
  done
done

# Post structured batch summary to progress issue (#651)
PROGRESS_ISSUE=$(read_state progress_issue)
if [[ -f "$LOG_DIR/events.jsonl" ]]; then
  echo ">>> Generating structured batch summary from events.jsonl..."
  BATCH_SUMMARY_TEXT=$(npx tsx "$SCRIPT_DIR/batch-summary.ts" "$LOG_DIR" 2>/dev/null) || true
  if [[ -n "$BATCH_SUMMARY_TEXT" && -n "$PROGRESS_ISSUE" && -n "$KAIZEN_REPO" ]]; then
    echo ">>> Posting batch summary to $PROGRESS_ISSUE..."
    gh issue comment "$PROGRESS_ISSUE" --repo "$KAIZEN_REPO" --body "$BATCH_SUMMARY_TEXT" 2>/dev/null || echo ">>> Summary posting skipped (non-fatal)."
  fi
  # Also save summary to file
  if [[ -n "$BATCH_SUMMARY_TEXT" ]]; then
    echo "$BATCH_SUMMARY_TEXT" > "$LOG_DIR/batch-summary-report.md"
    echo ">>> Structured summary saved to $LOG_DIR/batch-summary-report.md"
  fi
else
  echo ">>> No events.jsonl found — skipping structured summary."
fi

# Close batch progress issue
npx tsx "$SCRIPT_DIR/auto-dent-run.ts" --close-batch "$STATE_FILE" 2>/dev/null || true

# Batch summary
node -e "
  const fs = require('fs');
  const s = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));

  const duration = Math.floor(Date.now() / 1000) - s.batch_start;
  const hours = Math.floor(duration / 3600);
  const mins = Math.floor((duration % 3600) / 60);

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║               auto-dent — Batch Summary                 ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log('║ Batch ID:  ' + s.batch_id);
  console.log('║ Guidance:  ' + s.guidance);
  console.log('║ Runs:      ' + s.run);
  console.log('║ Duration:  ' + hours + 'h ' + mins + 'm');
  console.log('║ Stop:      ' + (s.stop_reason || 'completed'));
  const totalCost = (s.run_history || []).reduce((sum, r) => sum + (r.cost_usd || 0), 0);
  if (totalCost > 0) console.log('║ Cost:      $' + totalCost.toFixed(2));
  console.log('╠══════════════════════════════════════════════════════════╣');

  if (s.prs.length > 0) {
    console.log('║ PRs created:');
    s.prs.forEach(pr => console.log('║   ' + pr));
  } else {
    console.log('║ PRs created: none');
  }

  if (s.issues_filed.length > 0) {
    console.log('║ Issues filed:');
    s.issues_filed.forEach(i => console.log('║   ' + i));
  }

  if (s.issues_closed.length > 0) {
    console.log('║ Issues closed: ' + s.issues_closed.join(' '));
  }

  if (s.run_history && s.run_history.length > 0) {
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log('║ Per-run metrics:');
    s.run_history.forEach(function(r) {
      var rm = Math.floor(r.duration_seconds / 60);
      var rs = r.duration_seconds % 60;
      var status = r.exit_code === 0 ? 'ok' : 'exit ' + r.exit_code;
      var prCount = r.prs.length;
      var line = '║   #' + r.run + ': ' + rm + 'm' + rs + 's $' + (r.cost_usd || 0).toFixed(2) + ' ' + r.tool_calls + 'tc ' + status;
      if (prCount > 0) line += ' ' + prCount + 'PR';
      if (r.stop_requested) line += ' STOP';
      console.log(line);
    });
  }

  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  // Finalize state
  if (!s.stop_reason) s.stop_reason = 'completed';
  s.batch_end = Math.floor(Date.now() / 1000);
  var content = JSON.stringify(s, null, 2) + '\n';
  if (fs.existsSync(process.argv[1])) fs.copyFileSync(process.argv[1], process.argv[1] + '.bak');
  fs.writeFileSync(process.argv[1] + '.tmp', content);
  fs.renameSync(process.argv[1] + '.tmp', process.argv[1]);
  console.log('State: ' + process.argv[1]);

  const summaryPath = process.argv[1].replace('state.json', 'batch-summary.txt');
  const lines = [
    'batch_id=' + s.batch_id,
    'guidance=' + s.guidance,
    'runs=' + s.run,
    'total_duration_seconds=' + duration,
    'total_cost_usd=' + totalCost.toFixed(2),
    'stop_reason=' + (s.stop_reason || 'completed'),
    'prs=' + s.prs.join(' '),
    'issues_filed=' + s.issues_filed.join(' '),
    'issues_closed=' + s.issues_closed.join(' '),
    'cases=' + s.cases.join(' '),
  ];
  if (s.run_history && s.run_history.length > 0) {
    lines.push('');
    s.run_history.forEach(function(r) {
      lines.push('run_' + r.run + '_duration=' + r.duration_seconds);
      lines.push('run_' + r.run + '_cost=' + (r.cost_usd || 0).toFixed(2));
      lines.push('run_' + r.run + '_tools=' + r.tool_calls);
      lines.push('run_' + r.run + '_exit=' + r.exit_code);
      if (r.prs.length > 0) lines.push('run_' + r.run + '_prs=' + r.prs.join(' '));
    });
  }
  fs.writeFileSync(summaryPath, lines.join('\n') + '\n');
  console.log('Summary: ' + summaryPath);
" "$STATE_FILE"

# Append to cross-batch aggregate (#586)
echo ">>> Appending batch to aggregate..."
npx tsx "$CTL_SCRIPT" aggregate "$BATCH_ID" 2>/dev/null || echo ">>> Aggregate append skipped (non-fatal)."

# Print last-worked-on state for easy resume
print_last_state
