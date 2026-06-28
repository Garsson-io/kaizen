#!/bin/bash
# resolve-tsx-bin.sh — shared tsx discovery for hook test harnesses

resolve_tsx_bin() {
  local kaizen_dir="$1"
  local candidates=()

  candidates+=("$kaizen_dir/node_modules/.bin/tsx")

  local dir
  dir="$(dirname "$kaizen_dir")"
  for _ in 1 2 3 4 5; do
    candidates+=("$dir/node_modules/.bin/tsx")
    local parent
    parent="$(dirname "$dir")"
    if [ "$parent" = "$dir" ]; then
      break
    fi
    dir="$parent"
  done

  local git_common
  git_common="$(git -C "$kaizen_dir" rev-parse --git-common-dir 2>/dev/null || true)"
  if [ -n "$git_common" ]; then
    local common_abs
    case "$git_common" in
      /*) common_abs="$git_common" ;;
      *) common_abs="$kaizen_dir/$git_common" ;;
    esac
    candidates+=("$(dirname "$common_abs")/node_modules/.bin/tsx")
  fi

  local candidate
  for candidate in "${candidates[@]}"; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  resolve_tsx_bin "${1:-$(pwd)}"
fi
