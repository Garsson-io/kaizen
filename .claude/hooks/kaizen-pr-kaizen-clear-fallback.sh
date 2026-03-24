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
exec node "$KAIZEN_DIR/dist/hooks/pr-kaizen-clear-fallback.js"
