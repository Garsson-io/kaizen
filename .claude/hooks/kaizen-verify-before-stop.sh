#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# verify-before-stop.sh — Level 2 kaizen enforcement
# Runs when Claude Code agent finishes. Checks if source files were
# modified and reminds the agent to verify before stopping.
#
# IMPORTANT: This hook must NEVER spawn heavy subprocesses (vitest, tsc).
# Running vitest/tsc inside a Stop hook caused repeated OOM crashes:
# each Stop attempt spawned ~120MB processes that stacked up when the
# hook blocked and Claude retried. See kaizen #372.
#
# Instead, this hook checks whether verification was already done
# (by looking for a recent successful test run) and warns if not.
#
# Exit 0 = allow stop
# Exit 2 = block stop (agent must run tests first)

set -euo pipefail

# Check if any TypeScript source files were modified (staged or unstaged)
ALL_CHANGED=$(git diff --name-only HEAD 2>/dev/null || true)
ALL_STAGED=$(git diff --cached --name-only 2>/dev/null || true)
ALL_MODIFIED=$(printf '%s\n%s' "$ALL_CHANGED" "$ALL_STAGED" | sort -u)

CHANGED_TS=$(echo "$ALL_MODIFIED" | grep '\.ts$' || true)

if [ -z "$CHANGED_TS" ]; then
  exit 0
fi

source "$(dirname "$0")/lib/scope-guard.sh"
source "$(dirname "$0")/lib/hook-telemetry.sh" 2>/dev/null || true

FILE_COUNT=$(echo "$CHANGED_TS" | wc -l | tr -d ' ')

cat >&2 <<EOF
Reminder: $FILE_COUNT TypeScript file(s) were modified.
Please ensure you ran 'npm test' and 'npx tsc --noEmit' before stopping.
If tests and type-check passed, you're good to go.
EOF

# Advisory only — never block, never spawn heavy processes
exit 0
