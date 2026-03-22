#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# kaizen-pr-kaizen-clear-fallback.sh — Bash fallback for PR kaizen gate clearing
#
# PostToolUse hook on Bash — always exits 0 (state management, not blocking).
#
# The primary clearing hook is pr-kaizen-clear-ts.sh (TypeScript). This bash
# fallback exists because the TS hook can timeout under load (e.g., when 5
# parallel worktree agents all spawn npx tsx simultaneously, the 10s timeout
# expires and the gate stays stuck). See kaizen #492.
#
# This hook does the minimum: detect KAIZEN_IMPEDIMENTS or KAIZEN_NO_ACTION
# in command output, and clear the state file. No validation, no audit logging,
# no PR comments — the TS hook handles those when it runs successfully.
#
# The TS hook uses findNewestStateWithStatusAnyBranch so it clears cross-branch
# gates. This fallback does the same by scanning all state files.

source "$(dirname "$0")/lib/parse-command.sh" 2>/dev/null || exit 0
source "$(dirname "$0")/lib/state-utils.sh" 2>/dev/null || exit 0

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
[ "$TOOL_NAME" = "Bash" ] || exit 0

EXIT_CODE=$(echo "$INPUT" | jq -r '.tool_response.exit_code // "0"')
[ "$EXIT_CODE" = "0" ] || exit 0

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
STDOUT=$(echo "$INPUT" | jq -r '.tool_response.stdout // empty')

# Only fire if the command or output contains a kaizen declaration
if ! echo "$COMMAND$STDOUT" | grep -qE 'KAIZEN_IMPEDIMENTS:|KAIZEN_NO_ACTION'; then
  exit 0
fi

# Check if there's an active kaizen gate (any branch — handles cross-worktree leak)
STATE_DIR="${STATE_DIR:-/tmp/.pr-review-state}"
[ -d "$STATE_DIR" ] || exit 0

FOUND_GATE=false
for f in "$STATE_DIR"/pr-kaizen-*; do
  [ -f "$f" ] || continue
  STATUS=$(grep -E '^STATUS=' "$f" 2>/dev/null | head -1 | cut -d= -f2-)
  if [ "$STATUS" = "needs_pr_kaizen" ]; then
    FOUND_GATE=true
    break
  fi
done

[ "$FOUND_GATE" = true ] || exit 0

# The TS hook may have already cleared it (it runs in the same PostToolUse batch).
# Check again after a tiny delay to avoid racing.
sleep 0.1

# Re-check — if TS hook already cleared, we're done
STILL_ACTIVE=false
for f in "$STATE_DIR"/pr-kaizen-*; do
  [ -f "$f" ] || continue
  STATUS=$(grep -E '^STATUS=' "$f" 2>/dev/null | head -1 | cut -d= -f2-)
  if [ "$STATUS" = "needs_pr_kaizen" ]; then
    STILL_ACTIVE=true
    # Clear it — update status to kaizen_done
    PR_URL=$(grep -E '^PR_URL=' "$f" 2>/dev/null | head -1 | cut -d= -f2-)
    BRANCH=$(grep -E '^BRANCH=' "$f" 2>/dev/null | head -1 | cut -d= -f2-)
    cat > "$f" <<EOF
PR_URL=$PR_URL
STATUS=kaizen_done
BRANCH=$BRANCH
EOF
  fi
done

if [ "$STILL_ACTIVE" = true ]; then
  # Log that fallback fired (the TS hook failed/timed out)
  AUDIT_DIR="${AUDIT_DIR:-$(cd "$(dirname "$0")/../kaizen" && pwd)/audit}"
  mkdir -p "$AUDIT_DIR" 2>/dev/null
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) | FALLBACK_CLEAR | branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown) | pr=$PR_URL | reason=ts-hook-timeout-or-failure" >> "$AUDIT_DIR/fallback-clear.log" 2>/dev/null
fi

exit 0
