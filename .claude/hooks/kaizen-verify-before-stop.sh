#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# verify-before-stop.sh — Level 2 kaizen enforcement
# Runs when Claude Code agent finishes. Checks if source files were
# modified and verifies they compile and tests pass.
#
# Exit 0 = allow stop
# Exit 2 = block stop (agent must fix issues first)

set -euo pipefail

# Check if any TypeScript source files were modified (staged or unstaged)
ALL_CHANGED=$(git diff --name-only HEAD 2>/dev/null || true)
ALL_STAGED=$(git diff --cached --name-only 2>/dev/null || true)
ALL_MODIFIED=$(printf '%s\n%s' "$ALL_CHANGED" "$ALL_STAGED" | sort -u)

CHANGED_TS=$(echo "$ALL_MODIFIED" | grep '\.ts$' || true)

if [ -z "$CHANGED_TS" ]; then
  # No TypeScript changes — nothing to verify
  exit 0
fi

# Determine which projects have changes
HARNESS_TS=$(echo "$CHANGED_TS" | grep -v '^container/agent-runner/' || true)
AGENT_RUNNER_TS=$(echo "$CHANGED_TS" | grep '^container/agent-runner/' || true)

echo "🔍 Verifying modified TypeScript files..." >&2

# Type-check harness (only if harness files changed)
if [ -n "$HARNESS_TS" ]; then
  if ! npx tsc --noEmit 2>&1; then
    echo "❌ Harness TypeScript type-check failed. Fix errors before finishing." >&2
    exit 2
  fi
fi

# Type-check agent-runner (only if agent-runner files changed)
if [ -n "$AGENT_RUNNER_TS" ] && [ -f "container/agent-runner/tsconfig.json" ]; then
  if ! (cd container/agent-runner && npx tsc --noEmit) 2>&1; then
    echo "❌ Agent-runner TypeScript type-check failed. Fix errors before finishing." >&2
    exit 2
  fi
fi

# Run harness tests if harness files changed
if [ -n "$HARNESS_TS" ]; then
  if [ -f "vitest.config.ts" ] || [ -f "vitest.config.js" ]; then
    if ! npx vitest run --reporter=verbose 2>&1; then
      echo "❌ Harness tests failed. Fix failing tests before finishing." >&2
      exit 2
    fi
  fi
fi

# Run agent-runner tests if agent-runner files changed
if [ -n "$AGENT_RUNNER_TS" ] && [ -f "container/agent-runner/vitest.config.ts" ]; then
  if ! (cd container/agent-runner && npx vitest run --reporter=verbose) 2>&1; then
    echo "❌ Agent-runner tests failed. Fix failing tests before finishing." >&2
    exit 2
  fi
fi

echo "✅ Type-check and tests passed." >&2
exit 0
