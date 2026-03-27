#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# enforce-case-exists.sh — Level 2 kaizen enforcement (Issue #94)
# PreToolUse hook on Edit|Write: blocks source code edits in worktrees
# that don't have a corresponding case record.
#
# This catches agents that skip case creation (via CLI or IPC)
# before starting implementation work in a worktree.
#
# Only fires in worktrees (not main checkout — enforce-worktree-writes.sh
# handles that). Only blocks source files (same allowlist as
# enforce-worktree-writes.sh).
#
# Case lookup strategy (no direct DB access — delegates to host CLI):
#   1. If $KAIZEN_CASE_CLI is configured, use: $KAIZEN_CASE_CLI case-by-branch <branch>
#   2. If no case CLI configured, skip enforcement (can't check without a backend)

source "$(dirname "$0")/lib/allowlist.sh" 2>/dev/null || { exit 0; }
source "$(dirname "$0")/lib/read-config.sh" 2>/dev/null || { exit 0; }

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# If no file path, allow
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

source "$(dirname "$0")/lib/scope-guard.sh"
source "$(dirname "$0")/lib/hook-telemetry.sh" 2>/dev/null || true

# Detect worktree: git-dir differs from git-common-dir
GIT_DIR=$(git rev-parse --git-dir 2>/dev/null)
GIT_COMMON=$(git rev-parse --git-common-dir 2>/dev/null)

# Only enforce in worktrees (not main checkout)
if [ -z "$GIT_DIR" ] || [ -z "$GIT_COMMON" ] || [ "$GIT_DIR" = "$GIT_COMMON" ]; then
  exit 0
fi

# Resolve the worktree root
WORKTREE_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$WORKTREE_ROOT" ]; then
  exit 0
fi

# Resolve file to absolute path
ABS_FILE_PATH=$(realpath -m "$FILE_PATH" 2>/dev/null || echo "$FILE_PATH")

# Only care about files inside this worktree
if ! echo "$ABS_FILE_PATH" | grep -q "^${WORKTREE_ROOT}/"; then
  exit 0
fi

# Get relative path within worktree
REL_PATH="${ABS_FILE_PATH#${WORKTREE_ROOT}/}"

# Allow: non-source files — uses shared allowlist (kaizen #172)
if is_allowed_runtime_dir "$REL_PATH"; then
  exit 0
fi

# This is a source file edit in a worktree — check for a case
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ -z "$BRANCH" ]; then
  exit 0
fi

# No case CLI configured — can't check, so allow
if [ -z "$KAIZEN_CASE_CLI" ]; then
  exit 0
fi

# Query the case backend via the configured CLI
HAS_CASE=""
CASE_OUTPUT=$($KAIZEN_CASE_CLI case-by-branch "$BRANCH" 2>/dev/null)
CASE_EXIT=$?

if [ $CASE_EXIT -eq 0 ] && [ -n "$CASE_OUTPUT" ]; then
  # CLI returned a case — allow
  exit 0
fi

# If CLI failed (not installed, errored), allow gracefully
if [ $CASE_EXIT -ne 0 ] && [ -z "$CASE_OUTPUT" ]; then
  exit 0
fi

# No case found — block the edit with helpful guidance (kaizen #146)
WORKTREE_PATH="$WORKTREE_ROOT"
jq -n \
  --arg branch "$BRANCH" \
  --arg file "$FILE_PATH" \
  --arg cli "$KAIZEN_CASE_CLI" \
  --arg reason "No case record found for branch '$BRANCH'. All dev work must have a case before writing code.

Create a case first:
  $KAIZEN_CASE_CLI case-create --description \"your description\" --type dev --github-issue N

Or via /kaizen-implement (which calls the CLI for you).

This ensures:
  - /kaizen-write-plan collision detection prevents duplicate effort
  - Kaizen reflection fires on completion

If this is exploratory work (not implementation), use the main checkout with .claude/ paths instead." \
  '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
exit 0
