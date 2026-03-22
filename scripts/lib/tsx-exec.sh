#!/usr/bin/env bash
# tsx-exec.sh — Resolve and exec a TypeScript source file via tsx or compiled dist/.
# Works from worktrees (no node_modules) by falling back to the main checkout.
# Usage: source this file, then call tsx_exec <basename>
#   e.g., tsx_exec worktree-du
set -euo pipefail

tsx_exec() {
  local name="$1"; shift
  local project_root
  project_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

  # In a worktree, node_modules lives in the main checkout.
  local main_root
  local git_common
  git_common="$(git rev-parse --git-common-dir 2>/dev/null)"
  if [ -n "$git_common" ] && [ "$git_common" != ".git" ]; then
    main_root="$(cd "$git_common/.." 2>/dev/null && pwd)"
  else
    main_root="$project_root"
  fi

  # Try tsx: worktree source + main checkout's node_modules
  local tsx="$main_root/node_modules/.bin/tsx"
  local ts_src="$project_root/src/$name.ts"
  if [ -x "$tsx" ] && [ -f "$ts_src" ]; then
    exec "$tsx" "$ts_src" "$@"
  fi

  # Fallback: plugin root (kaizen installed as Claude Code plugin)
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
    local plugin_tsx="$CLAUDE_PLUGIN_ROOT/node_modules/.bin/tsx"
    local plugin_ts="$CLAUDE_PLUGIN_ROOT/src/$name.ts"
    if [ -x "$plugin_tsx" ] && [ -f "$plugin_ts" ]; then
      exec "$plugin_tsx" "$plugin_ts" "$@"
    fi
  fi

  # Fallback: script's own repo root (when called from plugin cache)
  local script_root
  script_root="$(cd "$(dirname "${BASH_SOURCE[1]:-${BASH_SOURCE[0]}}")/.." 2>/dev/null && pwd)"
  if [ "$script_root" != "$main_root" ]; then
    local sr_tsx="$script_root/node_modules/.bin/tsx"
    local sr_ts="$script_root/src/$name.ts"
    if [ -x "$sr_tsx" ] && [ -f "$sr_ts" ]; then
      exec "$sr_tsx" "$sr_ts" "$@"
    fi
  fi

  # Fallback: compiled dist/ (try worktree first, then main)
  for root in "$project_root" "$main_root"; do
    local dist_js="$root/dist/$name.js"
    if [ -f "$dist_js" ]; then
      exec node "$dist_js" "$@"
    fi
  done

  echo "error: cannot find $name.ts or $name.js" >&2
  exit 1
}
