#!/bin/bash
# Part of kAIzen Agent Control Flow
# run-tsx.sh — Reliable tsx execution for TS hook shims
#
# Runs precompiled dist output when a build freshness marker proves it is
# current, otherwise resolves tsx from KAIZEN_DIR/node_modules,
# parent/worktree installs, or the git common dir, then gives up loudly but
# fail-open. Prevents opaque hook errors when node_modules is missing (e.g.,
# plugin installations without npm install) while keeping hooks non-blocking.
#
# Usage (in a TS shim):
#   source "$(dirname "$0")/lib/run-tsx.sh"
#   run_tsx "$KAIZEN_DIR" "$KAIZEN_DIR/src/hooks/my-hook.ts"

source "$(dirname "${BASH_SOURCE[0]}")/resolve-kaizen-dir.sh" || exit 0
source "$(dirname "${BASH_SOURCE[0]}")/resolve-tsx-bin.sh" || exit 0

# When sourced by a real hook shim, measure the outer shim once. Direct library
# tests source run-tsx.sh without a caller script, so avoid writing telemetry
# just for loading the helper.
if [ -n "${BASH_SOURCE[1]:-}" ]; then
  export KAIZEN_HOOK_TELEMETRY_NAME
  KAIZEN_HOOK_TELEMETRY_NAME="$(basename "${BASH_SOURCE[1]}" .sh)"
  source "$(dirname "${BASH_SOURCE[0]}")/hook-telemetry.sh" 2>/dev/null || true
  unset KAIZEN_HOOK_TELEMETRY_NAME
fi

hook_dist_file_for_source() {
  local kaizen_dir="$1"
  local ts_file="$2"

  case "$ts_file" in
    "$kaizen_dir"/src/*.ts)
      local rel_path="${ts_file#"$kaizen_dir"/src/}"
      printf '%s\n' "$kaizen_dir/dist/${rel_path%.ts}.js"
      ;;
    *)
      return 1
      ;;
  esac
}

hook_build_is_fresh() {
  local kaizen_dir="$1"
  local marker="$kaizen_dir/dist/.kaizen-hook-build"

  [ -f "$marker" ] || return 1
  [ -d "$kaizen_dir/src" ] || return 1

  local newer_source
  newer_source="$(
    find "$kaizen_dir/src" \
      -type f \
      -name '*.ts' \
      ! -name '*.test.ts' \
      -newer "$marker" \
      -print \
      -quit 2>/dev/null
  )" || return 1

  [ -z "$newer_source" ]
}

run_tsx() {
  local kaizen_dir="$1"
  local ts_file="$2"

  # This trampoline is a real hook entrypoint. Direct TS hook smoke tests must
  # set STATE_DIR explicitly; wrappers mark production dispatch as trusted.
  export KAIZEN_TRUST_DEFAULT_STATE_DIR=1

  # Test harnesses may execute hooks from a worktree whose source is current but
  # whose node_modules is absent or incomplete. Let them provide a known-good
  # tsx binary while still running the source file from this kaizen_dir.
  if [ -n "${KAIZEN_TSX_BIN:-}" ] && [ -x "$KAIZEN_TSX_BIN" ]; then
    "$KAIZEN_TSX_BIN" "$ts_file"
    exit $?
  fi

  # 1. Fast path — use precompiled dist only when npm run build wrote a fresh
  # marker after all production TypeScript sources.
  local dist_file
  if dist_file="$(hook_dist_file_for_source "$kaizen_dir" "$ts_file")"; then
    if [ -f "$dist_file" ] && hook_build_is_fresh "$kaizen_dir"; then
      local node_bin
      node_bin="$(command -v node || true)"
      if [ -n "$node_bin" ]; then
        "$node_bin" "$dist_file"
        exit $?
      fi
    fi
  fi

  # 2. Shared resolver — local node_modules, parent worktree installs, git common dir
  local resolved_tsx
  resolved_tsx="$(resolve_tsx_bin "$kaizen_dir" || true)"
  if [ -n "$resolved_tsx" ]; then
    "$resolved_tsx" "$ts_file"
    exit $?
  fi

  # 3. tsx not available — exit gracefully instead of crashing. Do not shell
  # through `npx --prefix ... 2>/dev/null`: when the bound plugin/worktree root
  # lacks node_modules, npx exits non-zero with empty stderr and Claude reports
  # only "Failed with non-blocking status code: No stderr output" (#1131).
  echo "kaizen hook: tsx not found for $kaizen_dir — run npm install there or symlink node_modules from the main checkout; skipping $ts_file" >&2
  exit 0
}
