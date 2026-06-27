#!/bin/bash
# Tests for the #1270 runtag stamp in kaizen-capture-worktree-context.sh.
#
# On a successful `git worktree add case/*`, the hook stamps the per-worktree
# `kaizen.runtag` from $KAIZEN_RUN_TAG so the auto-dent rescue finalizer can
# attribute the worktree to its run even if the run crashed before emitting the
# IMPLEMENT marker. These tests use a REAL temp git repo + worktree so the
# git-config write path is exercised end to end (no git mock).
source "$(dirname "$0")/test-helpers.sh"

HOOK="$(cd "$(dirname "$0")/.." && pwd)/kaizen-capture-worktree-context.sh"
setup_test_env

# Build a throwaway repo with a real case worktree on a case/* branch.
# Echoes the worktree path.
make_case_worktree() {
  local repo="$1" branch="$2" wt
  wt="$repo/.claude/worktrees/$(basename "$branch")"
  git -C "$repo" worktree add -q -b "$branch" "$wt" HEAD 2>/dev/null
  echo "$wt"
}

new_repo() {
  local d
  d=$(mktemp -d)
  git -C "$d" init -q
  git -C "$d" config user.email t@t.t
  git -C "$d" config user.name t
  git -C "$d" commit -q --allow-empty -m init
  echo "$d"
}

run_capture_hook() {
  # $1 command, rest: env assignments inline via caller
  local cmd="$1"
  jq -n --arg cmd "$cmd" \
    '{tool_input:{command:$cmd}, tool_response:{stdout:"", stderr:"", exit_code:"0"}}' \
    | bash "$HOOK" 2>/dev/null
}

echo "=== Stamps kaizen.runtag on a successful case worktree add ==="
REPO=$(new_repo)
WT=$(make_case_worktree "$REPO" "case/260628-k9-demo")
KAIZEN_RUN_TAG="test-batch/run-7" run_capture_hook \
  "git -C $REPO worktree add -b case/260628-k9-demo $WT HEAD"
STAMP=$(git -C "$WT" config --worktree --get kaizen.runtag 2>/dev/null || true)
assert_eq "runtag stamped on case worktree" "test-batch/run-7" "$STAMP"
rm -rf "$REPO"

echo ""
echo "=== Does NOT stamp when KAIZEN_RUN_TAG is unset ==="
REPO=$(new_repo)
WT=$(make_case_worktree "$REPO" "case/260628-k9-demo")
run_capture_hook "git -C $REPO worktree add -b case/260628-k9-demo $WT HEAD"
STAMP=$(git -C "$WT" config --worktree --get kaizen.runtag 2>/dev/null || true)
assert_eq "no runtag when env unset" "" "$STAMP"
rm -rf "$REPO"

echo ""
echo "=== Does NOT stamp a non-case worktree ==="
REPO=$(new_repo)
WT="$REPO/.claude/worktrees/worktree-scratch"
git -C "$REPO" worktree add -q -b worktree-scratch "$WT" HEAD 2>/dev/null
KAIZEN_RUN_TAG="test-batch/run-7" run_capture_hook \
  "git -C $REPO worktree add -b worktree-scratch $WT HEAD"
STAMP=$(git -C "$WT" config --worktree --get kaizen.runtag 2>/dev/null || true)
assert_eq "no runtag on non-case branch" "" "$STAMP"
rm -rf "$REPO"

echo ""
echo "=== A non-worktree command (git push) is a no-op for stamping ==="
REPO=$(new_repo)
WT=$(make_case_worktree "$REPO" "case/260628-k9-demo")
KAIZEN_RUN_TAG="test-batch/run-7" run_capture_hook "git -C $REPO push origin main"
STAMP=$(git -C "$WT" config --worktree --get kaizen.runtag 2>/dev/null || true)
assert_eq "git push does not stamp any worktree" "" "$STAMP"
rm -rf "$REPO"

cleanup_test_env
print_results
