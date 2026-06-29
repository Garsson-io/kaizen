#!/bin/bash
# Part of kAIzen Agent Control Flow — see .agents/kaizen/README.md
# enforce-case-worktree.sh — Worktree boundary guard
# Warns when git commit/push is attempted outside a worktree.
# Denies Bash commands from a linked worktree when the main checkout has dirty
# source files, catching patch-style edits that landed in the wrong checkout.
# Real enforcement is in git hooks (.husky/pre-commit, .husky/pre-push).
#
# Runs as PreToolUse hook on Bash tool calls.

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"

source "$HOOK_DIR/lib/input-utils.sh" 2>/dev/null || { exit 0; }

read_hook_input
get_command

source "$HOOK_DIR/lib/scope-guard.sh"
source "$HOOK_DIR/lib/hook-telemetry.sh" 2>/dev/null || true
source "$HOOK_DIR/lib/hook-output.sh" 2>/dev/null || { exit 0; }
source "$HOOK_DIR/lib/allowlist.sh" 2>/dev/null || { exit 0; }

is_linked_git_worktree() {
  GIT_DIR=$(git rev-parse --git-dir 2>/dev/null || true)
  GIT_COMMON=$(git rev-parse --git-common-dir 2>/dev/null || true)
  [ -n "$GIT_DIR" ] && [ -n "$GIT_COMMON" ] && [ "$GIT_DIR" != "$GIT_COMMON" ]
}

resolve_main_checkout_root() {
  local worktree_root common_dir common_abs
  worktree_root=$(git rev-parse --show-toplevel 2>/dev/null || true)
  common_dir=$(git rev-parse --git-common-dir 2>/dev/null || true)

  [ -n "$worktree_root" ] || return 1
  [ -n "$common_dir" ] || return 1

  if echo "$common_dir" | grep -qE '^/'; then
    common_abs=$(realpath -m "$common_dir" 2>/dev/null || echo "$common_dir")
  else
    common_abs=$(cd "$worktree_root" 2>/dev/null && realpath -m "$common_dir" 2>/dev/null) || return 1
  fi

  if [ "$(basename "$common_abs")" = ".git" ]; then
    dirname "$common_abs"
    return 0
  fi

  return 1
}

dirty_root_source_files() {
  local main_root="$1"
  local line rel_path
  ROOT_SOURCE_DIRTY_FILES=()

  while IFS= read -r line; do
    [ -n "$line" ] || continue

    rel_path="${line:3}"
    if echo "$rel_path" | grep -q ' -> '; then
      rel_path="${rel_path##* -> }"
    fi

    [ -n "$rel_path" ] || continue
    if is_allowed_runtime_dir "$rel_path"; then
      continue
    fi

    ROOT_SOURCE_DIRTY_FILES+=("$rel_path")
  done < <(git -C "$main_root" status --porcelain --untracked-files=all 2>/dev/null)

  [ "${#ROOT_SOURCE_DIRTY_FILES[@]}" -gt 0 ]
}

deny_root_source_drift_if_needed() {
  local main_root worktree_root file_count file_list limit idx reason

  main_root=$(resolve_main_checkout_root) || return 0
  worktree_root=$(git rev-parse --show-toplevel 2>/dev/null || true)
  [ -n "$worktree_root" ] || return 0
  [ "$main_root" != "$worktree_root" ] || return 0

  if ! dirty_root_source_files "$main_root"; then
    return 0
  fi

  file_count="${#ROOT_SOURCE_DIRTY_FILES[@]}"
  limit="$file_count"
  [ "$limit" -gt 8 ] && limit=8

  file_list=""
  for ((idx = 0; idx < limit; idx++)); do
    file_list="${file_list}
  - ${ROOT_SOURCE_DIRTY_FILES[$idx]}"
  done
  if [ "$file_count" -gt "$limit" ]; then
    file_list="${file_list}
  - ... $((file_count - limit)) more"
  fi

  reason="BLOCKED: root checkout has dirty source files while this session is running from a case worktree.

Current worktree:
  $worktree_root

Root checkout:
  $main_root

Dirty root source files:${file_list}

Patch-style tools can target the root checkout when the path is not anchored to the case worktree. Move or reapply these changes into the current worktree, or clean the root checkout, before continuing."

  emit_deny "$reason"
}

if is_linked_git_worktree; then
  deny_root_source_drift_if_needed
  # Worktree command context is valid once the root checkout is clean.
  exit 0
fi

# Only warn for git commit and git push commands in the main checkout.
if ! echo "$COMMAND" | grep -qE '^\s*git\s+(commit|push)'; then
  exit 0
fi

# Advisory warning (git hooks will enforce the real block)
# Allow strategy/ commits on main checkout (machine-written batch memory — kaizen #703)
if echo "$COMMAND" | grep -qE '^\s*git\s+commit'; then
  STAGED=$(git diff --cached --name-only 2>/dev/null)
  if [ -n "$STAGED" ] && ! echo "$STAGED" | grep -qvE '^strategy/'; then
    exit 0
  fi
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
echo "⚠️  You're about to commit/push on '$BRANCH' in the main checkout." >&2
echo "   Git pre-commit/pre-push hooks will block this." >&2
echo "   Use a worktree for dev work (claude-wt or git worktree add)." >&2
exit 0
