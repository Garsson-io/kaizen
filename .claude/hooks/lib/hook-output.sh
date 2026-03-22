#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# hook-output.sh — Shared output helpers for hook scripts (kaizen #429)
#
# DRYs up the JSON output patterns used across hooks:
#   - PreToolUse deny (permissionDecision: "deny")
#   - Stop block (decision: "block")
#
# Usage:
#   source "$(dirname "$0")/lib/hook-output.sh"
#   emit_deny "reason text here"
#   emit_stop_block "reason text here"

# Emit a PreToolUse deny JSON response and exit 0.
# Usage: emit_deny "BLOCKED: reason..."
emit_deny() {
  local reason="$1"
  jq -n --arg reason "$reason" \
    '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: $reason
      }
    }'
  exit 0
}

# Emit a Stop block JSON response and exit 0.
# Usage: emit_stop_block "STOP BLOCKED: reason..."
emit_stop_block() {
  local reason="$1"
  jq -n --arg reason "$reason" '{ decision: "block", reason: $reason }'
  exit 0
}

# Load a prompt template from .claude/kaizen/prompts/ and substitute {{VAR}} placeholders.
# Usage: render_prompt "post-merge-block.md" PR_HEADER="PR: url" MAIN_CHECKOUT="/path"
# Returns the rendered text on stdout.
render_prompt() {
  local template_name="$1"
  shift

  # Resolve prompts dir relative to this lib file
  local lib_dir
  lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local prompts_dir="$lib_dir/../../kaizen/prompts"
  local template_file="$prompts_dir/$template_name"

  if [ ! -f "$template_file" ]; then
    echo "ERROR: prompt template not found: $template_file" >&2
    return 1
  fi

  local content
  content=$(cat "$template_file")

  # Substitute {{VAR}} placeholders from key=value args
  for arg in "$@"; do
    local key="${arg%%=*}"
    local val="${arg#*=}"
    content=$(echo "$content" | sed "s|{{${key}}}|${val}|g")
  done

  echo "$content"
}
