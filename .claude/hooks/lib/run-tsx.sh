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
source "$(dirname "${BASH_SOURCE[0]}")/resolve-tsx-bin.sh" || exit 0

run_tsx() {
  local kaizen_dir="$1"
  local ts_file="$2"

  # Test harnesses may execute hooks from a worktree whose source is current but
  # whose node_modules is absent or incomplete. Let them provide a known-good
  # tsx binary while still running the source file from this kaizen_dir.
  if [ -n "${KAIZEN_TSX_BIN:-}" ] && [ -x "$KAIZEN_TSX_BIN" ]; then
    exec "$KAIZEN_TSX_BIN" "$ts_file"
  fi

  # 1. Shared resolver — local node_modules, parent worktree installs, git common dir
  local resolved_tsx
  resolved_tsx="$(resolve_tsx_bin "$kaizen_dir" || true)"
  if [ -n "$resolved_tsx" ]; then
    exec "$resolved_tsx" "$ts_file"
  fi

  # 2. npx with --prefix — finds tsx in kaizen's node_modules
  if command -v npx &>/dev/null; then
    exec npx --prefix "$kaizen_dir" tsx "$ts_file" 2>/dev/null
  fi

  # 3. tsx not available — exit gracefully instead of crashing
  exit 0
}
