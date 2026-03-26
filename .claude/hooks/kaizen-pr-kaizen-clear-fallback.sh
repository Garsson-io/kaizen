#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
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

KAIZEN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Use pre-compiled TS version if available (no tsx overhead)
JS_PATH="$KAIZEN_DIR/dist/hooks/pr-kaizen-clear-fallback.js"
if [ -f "$JS_PATH" ]; then
  exec node "$JS_PATH"
fi

# Bash fallback when dist isn't built (CI, fresh checkout, pre-build)
INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
[ "$TOOL_NAME" = "Bash" ] || exit 0

EXIT_CODE=$(echo "$INPUT" | jq -r '.tool_response.exit_code // "0"' 2>/dev/null)
[ "$EXIT_CODE" = "0" ] || exit 0

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
STDOUT=$(echo "$INPUT" | jq -r '.tool_response.stdout // empty' 2>/dev/null)

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
