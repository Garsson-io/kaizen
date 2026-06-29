#!/bin/bash
# runner-dist-isolation.sh — private dist handling for hook test runs.
#
# Worktree setup intentionally symlinks dist from the main checkout for speed.
# Hook tests that execute real entrypoints should not measure shared dist
# contention, so the test runner swaps only symlinked dist directories to a
# private per-run copy and restores the original symlink on exit.

KAIZEN_HOOK_TEST_DIST_ROOT=""
KAIZEN_HOOK_TEST_DIST_CHECKOUT=""
KAIZEN_HOOK_TEST_ORIGINAL_DIST_TARGET=""
KAIZEN_HOOK_TEST_DIST_ISOLATED=0

setup_private_dist_if_symlink() {
  local checkout_root="$1"
  local dist_path="$checkout_root/dist"
  local original_target target_abs private_dist

  [ "${KAIZEN_HOOK_TEST_ISOLATE_DIST:-1}" != "0" ] || return 0
  [ -L "$dist_path" ] || return 0

  original_target=$(readlink "$dist_path" 2>/dev/null || true)
  [ -n "$original_target" ] || return 0

  case "$original_target" in
    /*) target_abs="$original_target" ;;
    *) target_abs=$(cd "$checkout_root" 2>/dev/null && realpath -m "$original_target" 2>/dev/null) || return 0 ;;
  esac

  [ -d "$target_abs" ] || return 0

  KAIZEN_HOOK_TEST_DIST_ROOT=$(mktemp -d "/tmp/.kaizen-hook-test-dist-XXXXXX")
  private_dist="$KAIZEN_HOOK_TEST_DIST_ROOT/dist"
  mkdir -p "$private_dist" || return 1
  cp -a "$target_abs/." "$private_dist/" || {
    rm -rf "$KAIZEN_HOOK_TEST_DIST_ROOT"
    KAIZEN_HOOK_TEST_DIST_ROOT=""
    return 1
  }

  rm "$dist_path" || {
    rm -rf "$KAIZEN_HOOK_TEST_DIST_ROOT"
    KAIZEN_HOOK_TEST_DIST_ROOT=""
    return 1
  }
  ln -s "$private_dist" "$dist_path" || {
    ln -s "$original_target" "$dist_path" 2>/dev/null || true
    rm -rf "$KAIZEN_HOOK_TEST_DIST_ROOT"
    KAIZEN_HOOK_TEST_DIST_ROOT=""
    return 1
  }

  KAIZEN_HOOK_TEST_DIST_CHECKOUT="$checkout_root"
  KAIZEN_HOOK_TEST_ORIGINAL_DIST_TARGET="$original_target"
  KAIZEN_HOOK_TEST_DIST_ISOLATED=1
}

restore_private_dist() {
  local dist_path

  if [ "$KAIZEN_HOOK_TEST_DIST_ISOLATED" = "1" ] && [ -n "$KAIZEN_HOOK_TEST_DIST_CHECKOUT" ]; then
    dist_path="$KAIZEN_HOOK_TEST_DIST_CHECKOUT/dist"
    if [ -L "$dist_path" ]; then
      rm "$dist_path" 2>/dev/null || true
      ln -s "$KAIZEN_HOOK_TEST_ORIGINAL_DIST_TARGET" "$dist_path" 2>/dev/null || true
    fi
  fi

  [ -n "$KAIZEN_HOOK_TEST_DIST_ROOT" ] && rm -rf "$KAIZEN_HOOK_TEST_DIST_ROOT"

  KAIZEN_HOOK_TEST_DIST_ROOT=""
  KAIZEN_HOOK_TEST_DIST_CHECKOUT=""
  KAIZEN_HOOK_TEST_ORIGINAL_DIST_TARGET=""
  KAIZEN_HOOK_TEST_DIST_ISOLATED=0
}
