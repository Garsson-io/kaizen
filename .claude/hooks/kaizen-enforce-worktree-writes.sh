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

# If no file path, allow (shouldn't happen for Edit/Write)
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

source "$(dirname "$0")/lib/scope-guard.sh"
source "$(dirname "$0")/lib/hook-telemetry.sh" 2>/dev/null || true

# Resolve the main checkout path from git
GIT_COMMON=$(git rev-parse --git-common-dir 2>/dev/null)
if [ -z "$GIT_COMMON" ]; then
  exit 0
fi

# Determine main checkout root
if [ "$GIT_COMMON" = ".git" ]; then
  MAIN_ROOT=$(pwd)
else
  MAIN_ROOT=$(dirname "$GIT_COMMON")
fi

# Resolve FILE_PATH to absolute
ABS_FILE_PATH=$(realpath -m "$FILE_PATH" 2>/dev/null || echo "$FILE_PATH")

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
MATCHING_WORKTREE_TARGET=""
MATCHING_WORKTREE_COUNT=0
CURRENT_WT=""
CURRENT_BRANCH_REF=""
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    worktree\ *)
      CURRENT_WT="${line#worktree }"
      CURRENT_BRANCH_REF=""
      ;;
    branch\ refs/heads/*)
      CURRENT_BRANCH_REF="${line#branch refs/heads/}"
      ;;
    "")
      if [ -n "$CURRENT_WT" ] && [ "$CURRENT_WT" != "$MAIN_ROOT" ]; then
        case "$CURRENT_BRANCH_REF" in
          case/*)
            TARGET="$CURRENT_WT/$REL_PATH"
            TARGET_DIR=$(dirname "$TARGET")
            if [ -e "$TARGET" ] || [ -d "$TARGET_DIR" ]; then
              MATCHING_WORKTREE_TARGET="$TARGET"
              MATCHING_WORKTREE_COUNT=$((MATCHING_WORKTREE_COUNT + 1))
            fi
            ;;
        esac
      fi
      CURRENT_WT=""
      CURRENT_BRANCH_REF=""
      ;;
  esac
done <<EOF
$(git -C "$MAIN_ROOT" worktree list --porcelain 2>/dev/null)

EOF

if [ "$MATCHING_WORKTREE_COUNT" -eq 1 ]; then
  REASON="$REASON

Active case worktree target for this file:
  $MATCHING_WORKTREE_TARGET"
elif [ "$MATCHING_WORKTREE_COUNT" -gt 1 ]; then
  REASON="$REASON

Multiple active case worktrees contain this relative path. Choose the intended worktree before editing."
fi
emit_deny "$REASON"
