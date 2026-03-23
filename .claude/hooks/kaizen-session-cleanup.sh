#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# kaizen-session-cleanup.sh — SessionStart hook
# Runs cleanup_merged_review_states() to clear stale merged/closed PR state files.
# Moved out of find_needs_review_state() hot path in kaizen #452 — was adding ~400ms
# per PreToolUse call due to gh pr view HTTP roundtrip.


source "$(dirname "$0")/lib/scope-guard.sh"
source "$(dirname "$0")/lib/hook-telemetry.sh" 2>/dev/null || true
source "$(dirname "$0")/lib/state-utils.sh" 2>/dev/null || { exit 0; }
cleanup_merged_review_states
