#!/bin/bash
# Tests for kaizen-worktree-setup.sh leaked-kaizen.issue provisioning guard (#1111).
# A fresh worktree that inherits a shared kaizen.issue (the leak) must be warned
# at SessionStart; a worktree with its own per-worktree binding must NOT be.
source "$(dirname "$0")/test-helpers.sh"

HOOK="$REPO_ROOT/.claude/hooks/kaizen-worktree-setup.sh"
require_file "$HOOK" "kaizen-worktree-setup.sh"

# Build a throwaway repo with a stale SHARED kaizen.issue (the old leaky path),
# then add worktrees off it.
ROOT=$(mktemp -d "/tmp/.kaizen-leak-test-XXXXXX")
trap 'rm -rf "$ROOT"' EXIT
MAIN="$ROOT/main"
git init -q "$MAIN"
git -C "$MAIN" config user.email "test@example.com"
git -C "$MAIN" config user.name "Test"
echo hi > "$MAIN/f.txt"
git -C "$MAIN" add .
git -C "$MAIN" commit -q -m init
# A prior run wrote the binding the OLD way — into shared config.
git -C "$MAIN" config kaizen.issue 1106

WT="$ROOT/wt"
git -C "$MAIN" worktree add -q -b case/260626-k1111-b "$WT"

echo "=== Leak present: fresh worktree inherits shared kaizen.issue ==="
OUT=$(cd "$WT" && bash "$HOOK" 2>&1 >/dev/null)
assert_contains "warns about leaked kaizen.issue" "Leaked kaizen.issue" "$OUT"
assert_contains "names the inherited issue" "#1106" "$OUT"
assert_contains "points to the bind CLI" "cli-issue-binding.ts bind" "$OUT"

echo ""
echo "=== Bound per-worktree: no leak warning ==="
git -C "$WT" config extensions.worktreeConfig true
git -C "$WT" config --worktree kaizen.issue 1111
OUT2=$(cd "$WT" && bash "$HOOK" 2>&1 >/dev/null)
assert_not_contains "no leak warning once worktree owns its binding" "Leaked kaizen.issue" "$OUT2"

echo ""
echo "=== Inherited value matches branch token: not flagged ==="
# New worktree whose case token equals the shared value — harmless to read.
WT2="$ROOT/wt2"
git -C "$MAIN" worktree add -q -b case/260626-k1106-c "$WT2"
OUT3=$(cd "$WT2" && bash "$HOOK" 2>&1 >/dev/null)
assert_not_contains "no warning when inherited value matches branch token" "Leaked kaizen.issue" "$OUT3"

echo ""
print_results
