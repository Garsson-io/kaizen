#!/bin/bash
# hook-timing-sentinel.sh — Spot-check hook benchmark for speed monitoring (kaizen #453)
#
# Called by the reflect hook at PR create/merge time. Benchmarks all hooks
# with a test payload and reports any that exceed the performance budget.
# This makes hook performance a self-improving kaizen dimension.
#
# Usage:
#   source "$(dirname "$0")/lib/hook-timing-sentinel.sh"
#   TIMING_REPORT=$(run_hook_benchmark)
#   if [ -n "$TIMING_REPORT" ]; then
#     # Include in reflection prompt
#   fi

# Performance budgets (milliseconds)
HOOK_WARN_MS="${HOOK_WARN_MS:-100}"
HOOK_ISSUE_MS="${HOOK_ISSUE_MS:-500}"
EVENT_WARN_MS="${EVENT_WARN_MS:-500}"
EVENT_ISSUE_MS="${EVENT_ISSUE_MS:-2000}"

# Minimum number of hooks to benchmark (skip if fewer hooks found)
MIN_HOOKS_FOR_BENCHMARK=3

# Test payload for benchmarking (simulates a Bash tool call)
_BENCH_PAYLOAD='{"tool_name":"Bash","tool_input":{"command":"echo benchmark"},"tool_response":{"stdout":"benchmark","exit_code":"0"}}'

# Benchmark a single hook. Outputs duration in milliseconds.
_time_hook() {
  local hook="$1"
  local start end
  start=$(date +%s%3N 2>/dev/null)
  if [ -z "$start" ] || [ "$start" = "%3N" ]; then
    # Fallback for systems without %3N support
    start=$(python3 -c "import time; print(int(time.time()*1000))" 2>/dev/null || echo "0")
  fi
  echo "$_BENCH_PAYLOAD" | "$hook" >/dev/null 2>&1
  end=$(date +%s%3N 2>/dev/null)
  if [ -z "$end" ] || [ "$end" = "%3N" ]; then
    end=$(python3 -c "import time; print(int(time.time()*1000))" 2>/dev/null || echo "0")
  fi
  echo $(( end - start ))
}

# Get the list of hook scripts from settings.json.
# Returns unique hook paths, one per line.
_list_hooks_from_settings() {
  local settings_file
  local hook_dir
  hook_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  settings_file="$(cd "$hook_dir/../.." && pwd)/.claude/settings.json"
  [ -f "$settings_file" ] || return 1
  jq -r '.. | .command? // empty' "$settings_file" 2>/dev/null | sort -u
}

# Run the full hook benchmark. Outputs a formatted report if any hook
# exceeds the warning threshold. Outputs nothing if all hooks are fast.
#
# Optional arg 1: comma-separated list of changed files in the current PR
# (used for overlap detection with slow hooks).
run_hook_benchmark() {
  local changed_files="${1:-}"
  local hook_dir
  hook_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

  # Collect hooks to benchmark
  local hooks=()
  local project_root
  project_root="$(cd "$hook_dir/../.." && pwd)"

  for hook_path in "$hook_dir"/kaizen-*.sh; do
    [ -f "$hook_path" ] && [ -x "$hook_path" ] && hooks+=("$hook_path")
  done

  if [ "${#hooks[@]}" -lt "$MIN_HOOKS_FOR_BENCHMARK" ]; then
    return 0
  fi

  # Benchmark each hook
  local total_ms=0
  local slow_hooks=""
  local issue_hooks=""
  local warn_count=0
  local issue_count=0

  for hook in "${hooks[@]}"; do
    local name
    name=$(basename "$hook")
    local ms
    ms=$(_time_hook "$hook")
    total_ms=$(( total_ms + ms ))

    if [ "$ms" -ge "$HOOK_ISSUE_MS" ]; then
      issue_hooks="${issue_hooks}  ${name}  ${ms}ms  ISSUE-WORTHY (>${HOOK_ISSUE_MS}ms)\n"
      issue_count=$(( issue_count + 1 ))
    elif [ "$ms" -ge "$HOOK_WARN_MS" ]; then
      slow_hooks="${slow_hooks}  ${name}  ${ms}ms\n"
      warn_count=$(( warn_count + 1 ))
    fi
  done

  # Nothing to report if all hooks are fast
  if [ "$warn_count" -eq 0 ] && [ "$issue_count" -eq 0 ]; then
    return 0
  fi

  # Build the report
  local report=""
  report="HOOK PERFORMANCE — Session Spot-Check\n"
  report="${report}Total: ${total_ms}ms across ${#hooks[@]} hooks\n\n"

  if [ "$issue_count" -gt 0 ]; then
    report="${report}Issue-worthy (>${HOOK_ISSUE_MS}ms per hook):\n${issue_hooks}\n"
  fi

  if [ "$warn_count" -gt 0 ]; then
    report="${report}Warnings (>${HOOK_WARN_MS}ms per hook):\n${slow_hooks}\n"
  fi

  if [ "$total_ms" -ge "$EVENT_ISSUE_MS" ]; then
    report="${report}Total overhead ${total_ms}ms exceeds event budget (${EVENT_ISSUE_MS}ms) — ISSUE-WORTHY\n\n"
  elif [ "$total_ms" -ge "$EVENT_WARN_MS" ]; then
    report="${report}Total overhead ${total_ms}ms exceeds event warning (${EVENT_WARN_MS}ms)\n\n"
  fi

  # Check overlap with PR changed files
  if [ -n "$changed_files" ] && { [ "$warn_count" -gt 0 ] || [ "$issue_count" -gt 0 ]; }; then
    local overlap=""
    local all_slow
    all_slow=$(printf '%s\n%s' "$issue_hooks" "$slow_hooks")

    while IFS= read -r changed; do
      [ -z "$changed" ] && continue
      # Check if the changed file is a hook or hook library
      if echo "$changed" | grep -qE '\.claude/hooks/'; then
        overlap="${overlap}  ${changed}\n"
      fi
    done <<< "$(echo "$changed_files" | tr ',' '\n')"

    if [ -n "$overlap" ]; then
      report="${report}Files changed in this PR that overlap with hooks:\n${overlap}\n"
      report="${report}ACTION: Hook files are already being modified in this PR.\n"
      report="${report}Consider fixing slow hooks inline before merging.\n"
    else
      report="${report}No hook files are changed in this PR.\n"
      report="${report}ACTION: File a kaizen issue for slow hooks with label area/hooks.\n"
    fi
  fi

  printf '%b' "$report"
}
