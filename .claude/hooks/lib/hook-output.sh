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
