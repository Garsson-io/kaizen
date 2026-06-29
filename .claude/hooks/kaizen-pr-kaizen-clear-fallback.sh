#!/bin/bash
# Part of kAIzen Agent Control Flow — see .agents/kaizen/README.md
# kaizen-pr-kaizen-clear-fallback.sh — Bash shim for PR kaizen gate clearing fallback.
#
# PostToolUse hook on Bash — always exits 0 (state management, not blocking).
#
# The primary clearing hook is pr-kaizen-clear-ts.sh (TypeScript via npx tsx). This
# fallback exists because npx tsx can timeout under load (e.g., when 5 parallel worktree
# agents all spawn tsx simultaneously, the 10s timeout expires and the gate stays stuck).
# See kaizen #492.
#
# This shim delegates to the pre-compiled pr-kaizen-clear-fallback.js via `node` (no tsx
# compilation overhead), which uses TS state functions (listStateFilesAnyBranch, etc.)
# from state-utils.ts. See kaizen #790 gap fix.

source "$(dirname "$0")/lib/resolve-kaizen-dir.sh" 2>/dev/null || exit 0
source "$(dirname "$0")/lib/input-utils.sh" 2>/dev/null || exit 0
source "$(dirname "$0")/lib/hook-telemetry.sh" 2>/dev/null || true

# Use pre-compiled TS version if available (no tsx overhead)
JS_PATH="$KAIZEN_DIR/dist/hooks/pr-kaizen-clear-fallback.js"
if [ -f "$JS_PATH" ]; then
  node "$JS_PATH"
  exit $?
fi

# Bash fallback when dist isn't built (CI, fresh checkout, pre-build)
read_hook_input
require_tool_bash
get_exit_code
require_success
get_command
get_stdout

if ! echo "$COMMAND$STDOUT" | grep -qE 'KAIZEN_IMPEDIMENTS:|KAIZEN_NO_ACTION'; then
  exit 0
fi

STATE_DIR="${STATE_DIR:-/tmp/.pr-review-state}"
[ -d "$STATE_DIR" ] || exit 0

for f in "$STATE_DIR"/pr-kaizen-*; do
  [ -f "$f" ] || continue
  STATUS=$(grep -E '^STATUS=' "$f" 2>/dev/null | head -1 | cut -d= -f2-)
  if [ "$STATUS" = "needs_pr_kaizen" ]; then
    PR_URL=$(grep -E '^PR_URL=' "$f" 2>/dev/null | head -1 | cut -d= -f2-)
    BRANCH=$(grep -E '^BRANCH=' "$f" 2>/dev/null | head -1 | cut -d= -f2-)
    printf 'PR_URL=%s\nSTATUS=kaizen_done\nBRANCH=%s\n' "$PR_URL" "$BRANCH" > "$f"
  fi
done
