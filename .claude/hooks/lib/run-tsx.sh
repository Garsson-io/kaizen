#!/bin/bash
# Part of kAIzen Agent Control Flow
# run-tsx.sh — Reliable tsx execution for TS hook shims
#
# Resolves tsx from KAIZEN_DIR/node_modules, then global npx, then gives up
# gracefully (exit 0). Prevents hook errors when node_modules is missing
# (e.g., plugin installations without npm install).
#
# Usage (in a TS shim):
#   source "$(dirname "$0")/lib/run-tsx.sh"
#   run_tsx "$KAIZEN_DIR" "$KAIZEN_DIR/src/hooks/my-hook.ts"

source "$(dirname "${BASH_SOURCE[0]}")/resolve-kaizen-dir.sh" || exit 0

run_tsx() {
  local kaizen_dir="$1"
  local ts_file="$2"

  # 1. Direct path — fastest, no npx overhead
  local local_tsx="$kaizen_dir/node_modules/.bin/tsx"
  if [ -x "$local_tsx" ]; then
    exec "$local_tsx" "$ts_file"
  fi

  # 2. npx with --prefix — finds tsx in kaizen's node_modules
  if command -v npx &>/dev/null; then
    exec npx --prefix "$kaizen_dir" tsx "$ts_file" 2>/dev/null
  fi

  # 3. tsx not available — exit gracefully instead of crashing
  exit 0
}
