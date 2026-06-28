#!/bin/bash
# Part of kAIzen Agent Control Flow — see .agents/kaizen/README.md
# enforce-worktree-writes.sh — Level 3 kaizen enforcement
# @enforces I9 — No source edits on main branch outside a worktree.
#                Canonical: docs/kaizen-invariants.md
# Blocks Edit/Write tools that target SOURCE CODE in the main checkout on main branch.
# Source code changes must go through worktrees and PRs.
#
# Allowed on main checkout (runtime/config, not source code):
#   - .claude/          (memory, hooks, skills, settings)
#   - groups/           (per-group memory and config — runtime data)
#   - data/             (sessions, IPC, case workspaces — runtime data)
#   - store/            (SQLite database — runtime data)
#   - logs/             (log files — runtime data)
#   - strategy/        (machine-written batch memory — kaizen #703)
#   - .claude/worktrees/ (worktree directories)
#
# Blocked on main checkout when on main branch (source code):
#   - src/, container/, package.json, tsconfig.json, docs/, etc.
#
# Runs as PreToolUse hook on Edit and Write tool calls.

source "$(dirname "$0")/lib/allowlist.sh" 2>/dev/null || { exit 0; }
source "$(dirname "$0")/lib/input-utils.sh" 2>/dev/null || { exit 0; }
source "$(dirname "$0")/lib/hook-output.sh" 2>/dev/null || { exit 0; }

read_hook_input
get_file_path
get_cwd

# If no file path, allow (shouldn't happen for Edit/Write)
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

source "$(dirname "$0")/lib/scope-guard.sh"
source "$(dirname "$0")/lib/hook-telemetry.sh" 2>/dev/null || true

CONTEXT_CWD="${HOOK_CWD:-$(pwd)}"
if [ ! -d "$CONTEXT_CWD" ]; then
  CONTEXT_CWD=$(pwd)
fi
CONTEXT_CWD=$(realpath -m "$CONTEXT_CWD" 2>/dev/null || echo "$CONTEXT_CWD")

# Resolve the main checkout path from the hook event cwd, not the hook process
# cwd. Edit/Write tools report their intended cwd in the hook event; anchoring
# relative file paths there prevents cross-worktree path drift.
GIT_COMMON=$(git -C "$CONTEXT_CWD" rev-parse --git-common-dir 2>/dev/null)
if [ -z "$GIT_COMMON" ]; then
  exit 0
fi

GIT_COMMON_ABS=$(cd "$CONTEXT_CWD" && realpath -m "$GIT_COMMON" 2>/dev/null)
if [ -z "$GIT_COMMON_ABS" ]; then
  exit 0
fi

# Resolve FILE_PATH to absolute, using the hook event cwd for relative paths.
case "$FILE_PATH" in
  /*)
    ABS_FILE_PATH=$(realpath -m "$FILE_PATH" 2>/dev/null || echo "$FILE_PATH")
    ;;
  *)
    ABS_FILE_PATH=$(realpath -m "$CONTEXT_CWD/$FILE_PATH" 2>/dev/null || echo "$CONTEXT_CWD/$FILE_PATH")
    ;;
esac

if [ "$GIT_COMMON" = ".git" ]; then
  MAIN_ROOT=$(cd "$CONTEXT_CWD" && pwd)
else
  MAIN_ROOT=$(dirname "$GIT_COMMON_ABS")
fi

# Only care about files inside the main checkout
if ! echo "$ABS_FILE_PATH" | grep -q "^${MAIN_ROOT}/"; then
  exit 0
fi

# Strip the main root prefix to get the relative path
REL_PATH="${ABS_FILE_PATH#${MAIN_ROOT}/}"

# Allow: runtime/config directories (not source code, no PR needed)
# Uses shared allowlist (kaizen #172) to stay in sync with enforce-case-exists.sh
if is_allowed_runtime_dir "$REL_PATH"; then
  exit 0
fi

# Everything else is source code — block if main checkout is on main branch
MAIN_BRANCH=$(git -C "$MAIN_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
if [ "$MAIN_BRANCH" != "main" ]; then
  exit 0
fi

# Block the write — source code on main branch
REASON="Cannot write to '$FILE_PATH' — it's source code in the main checkout ($MAIN_ROOT) on main branch. Use a worktree for code changes. Runtime dirs (groups/, data/, store/, logs/) and .claude/ are allowed."
source "$(dirname "$0")/lib/resolve-kaizen-dir.sh" 2>/dev/null || true
WORKTREE_HINT=""
if [ -n "${KAIZEN_DIR:-}" ] && [ -f "$KAIZEN_DIR/src/hooks/worktree-integrity.ts" ]; then
  if [ -x "$KAIZEN_DIR/node_modules/.bin/tsx" ]; then
    WORKTREE_HINT=$("$KAIZEN_DIR/node_modules/.bin/tsx" "$KAIZEN_DIR/src/hooks/worktree-integrity.ts" main-edit-hint --main-root "$MAIN_ROOT" --rel-path "$REL_PATH" 2>/dev/null || true)
  elif command -v npx >/dev/null 2>&1; then
    WORKTREE_HINT=$(npx --prefix "$KAIZEN_DIR" tsx "$KAIZEN_DIR/src/hooks/worktree-integrity.ts" main-edit-hint --main-root "$MAIN_ROOT" --rel-path "$REL_PATH" 2>/dev/null || true)
  fi
fi

if [ -n "$WORKTREE_HINT" ]; then
  REASON="$REASON

$WORKTREE_HINT"
fi
emit_deny "$REASON"
