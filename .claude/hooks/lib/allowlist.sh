#!/bin/bash
# Part of kAIzen Agent Control Flow — see .agents/kaizen/README.md
# allowlist.sh — Shared allowlist functions for gate hooks.
# Source from hooks: source "$(dirname "$0")/lib/allowlist.sh"
#
# DRY EXTRACTION (Kaizen #172):
# These functions were extracted from enforce-pr-review.sh and enforce-pr-kaizen.sh
# to eliminate duplication. Both hooks had near-identical readonly command allowlists,
# and changes to one would not propagate to the other.
#
# Requires: parse-command.sh must be sourced first (for is_gh_pr_command, is_git_command,
# and segment-splitting helpers).

# Check if a command is a readonly monitoring command that should be allowed
# through any gate. These commands can't "do work" (build, deploy, edit),
# so they don't violate any gate's intent.
#
# Allowed commands:
#   gh api <anything>           — read-only API calls (CI monitoring, PR status)
#   gh run view|list|watch      — CI run monitoring
#   git diff|log|show|status|branch|fetch — read-only git commands
#   ls|cat|stat|find|head|tail|wc|file   — read-only filesystem commands
#
# Usage:
#   if is_readonly_monitoring_command "$cmd"; then return 0; fi
is_neutral_setup_segment() {
  local seg="$1"
  if echo "$seg" | grep -qE '^([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+)([[:space:]]+[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+)*$'; then
    return 0
  fi
  if echo "$seg" | grep -qE '^export[[:space:]]+[A-Za-z_][A-Za-z0-9_]*(=[^[:space:]]+)?([[:space:]]+[A-Za-z_][A-Za-z0-9_]*(=[^[:space:]]+)?)*$'; then
    return 0
  fi
  if echo "$seg" | grep -qE '^cd([[:space:]]+("[^"]+"|'\''[^'\'']+'\''|[^[:space:]]+))?$'; then
    return 0
  fi
  return 1
}

is_readonly_monitoring_segment() {
  local seg="$1"
  # gh api — read-only API calls (CI monitoring, PR status checks)
  if echo "$seg" | grep -qE '^gh[[:space:]]+api[[:space:]]'; then
    return 0
  fi
  # gh run view/list/watch — CI run monitoring
  if echo "$seg" | grep -qE '^gh[[:space:]]+run[[:space:]]+(view|list|watch)'; then
    return 0
  fi
  # git diff/log/show/status/branch/fetch — read-only git commands
  if is_git_command "$seg" "diff|log|show|status|branch|fetch"; then
    return 0
  fi
  # Read-only filesystem commands
  local first_word
  first_word=$(echo "$seg" | awk '{print $1}')
  case "$first_word" in
    ls|cat|stat|find|head|tail|wc|file) return 0 ;;
    grep|rg|awk|sed) return 0 ;;
  esac
  if echo "$seg" | grep -qE '^npm[[:space:]]+test'; then
    return 0
  fi
  if echo "$seg" | grep -qE '^npx[[:space:]]'; then
    return 0
  fi
  return 1
}

is_readonly_or_setup_segment() {
  local seg="$1"
  if is_neutral_setup_segment "$seg"; then
    return 0
  fi
  is_readonly_monitoring_segment "$seg"
}

is_readonly_monitoring_command() {
  local cmd="$1"
  local saw_segment=0
  local seg
  while IFS= read -r seg; do
    saw_segment=1
    if ! is_readonly_or_setup_segment "$seg"; then
      return 1
    fi
  done < <(split_command_segments "$cmd")
  [ "$saw_segment" -eq 1 ]
}

# Check if a relative path is in an allowed runtime directory (non-source code).
# These directories contain runtime data, config, and memory — not source code
# that requires PR review.
#
# Allowed directories:
#   .claude/          — memory, hooks, skills, settings
#   groups/           — per-group memory and config (runtime data)
#   data/             — sessions, IPC, case workspaces (runtime data)
#   store/            — SQLite database (runtime data)
#   logs/             — log files (runtime data)
#   strategy/         — machine-written batch memory (kaizen #703)
#
# Note: .claude/worktrees/ is a subset of .claude/ and is included automatically.
#
# Usage:
#   REL_PATH="${ABS_FILE_PATH#${ROOT}/}"
#   if is_allowed_runtime_dir "$REL_PATH"; then exit 0; fi
is_allowed_runtime_dir() {
  local rel_path="$1"
  if echo "$rel_path" | grep -qE "^(\.claude/|groups/|data/|store/|logs/|strategy/)"; then
    return 0
  fi
  return 1
}
