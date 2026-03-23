#!/bin/bash
# hook-telemetry.sh — Structured JSONL telemetry for hook execution (kaizen #588)
#
# Source this at the top of every hook (after scope-guard.sh). It records:
#   - Hook name, start time (ISO 8601), duration_ms
#   - Exit code
#   - Worktree context (branch, case ID if available)
#
# Output: appends one JSON line to $KAIZEN_TELEMETRY_DIR/hooks.jsonl
#
# Usage:
#   source "$(dirname "$0")/lib/hook-telemetry.sh"
#   # ... hook logic ...
#   # Telemetry is emitted automatically on exit via trap

# Telemetry output directory — defaults to <project_root>/.kaizen/telemetry
_HOOK_TELEMETRY_DIR="${KAIZEN_TELEMETRY_DIR:-}"
_HOOK_TELEMETRY_START_MS=""
_HOOK_TELEMETRY_NAME=""

_hook_telemetry_now_ms() {
  local ms
  ms=$(date +%s%3N 2>/dev/null)
  if [ -z "$ms" ] || [ "$ms" = "%3N" ]; then
    ms=$(python3 -c "import time; print(int(time.time()*1000))" 2>/dev/null || echo "0")
  fi
  echo "$ms"
}

_hook_telemetry_init() {
  _HOOK_TELEMETRY_START_MS=$(_hook_telemetry_now_ms)
  _HOOK_TELEMETRY_NAME=$(basename "${BASH_SOURCE[2]:-${BASH_SOURCE[1]:-unknown}}" .sh)

  # Resolve telemetry dir if not set
  if [ -z "$_HOOK_TELEMETRY_DIR" ]; then
    local project_root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
    # Walk up to find kaizen.config.json
    local dir="$project_root"
    while [ "$dir" != "/" ]; do
      [ -f "$dir/kaizen.config.json" ] && { project_root="$dir"; break; }
      dir="$(dirname "$dir")"
    done
    _HOOK_TELEMETRY_DIR="$project_root/.kaizen/telemetry"
  fi
}

_hook_telemetry_emit() {
  local exit_code=$?

  # Skip if telemetry is disabled
  [ "${KAIZEN_TELEMETRY_DISABLED:-}" = "1" ] && return "$exit_code"

  local end_ms
  end_ms=$(_hook_telemetry_now_ms)
  local duration_ms=$(( end_ms - _HOOK_TELEMETRY_START_MS ))

  # Gather context
  local branch=""
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
  local case_id=""
  if [[ "$branch" =~ ^case/ ]]; then
    case_id="${branch#case/}"
  fi

  # Ensure output directory exists
  mkdir -p "$_HOOK_TELEMETRY_DIR" 2>/dev/null || return "$exit_code"

  local telemetry_file="$_HOOK_TELEMETRY_DIR/hooks.jsonl"
  local timestamp
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%S.${_HOOK_TELEMETRY_START_MS: -3}Z" 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")

  # Emit JSONL — use jq if available, fall back to printf
  if command -v jq &>/dev/null; then
    jq -cn \
      --arg hook "$_HOOK_TELEMETRY_NAME" \
      --arg ts "$timestamp" \
      --argjson dur "$duration_ms" \
      --argjson exit "$exit_code" \
      --arg branch "$branch" \
      --arg case_id "$case_id" \
      '{
        hook: $hook,
        timestamp: $ts,
        duration_ms: $dur,
        exit_code: $exit,
        branch: $branch,
        case_id: $case_id
      }' >> "$telemetry_file" 2>/dev/null
  else
    printf '{"hook":"%s","timestamp":"%s","duration_ms":%d,"exit_code":%d,"branch":"%s","case_id":"%s"}\n' \
      "$_HOOK_TELEMETRY_NAME" "$timestamp" "$duration_ms" "$exit_code" "$branch" "$case_id" \
      >> "$telemetry_file" 2>/dev/null
  fi

  return "$exit_code"
}

# Initialize timing on source
_hook_telemetry_init

# Register exit trap — chain with any existing trap
trap '_hook_telemetry_emit' EXIT
