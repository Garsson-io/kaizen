#!/bin/bash
# Tests for kaizen-worktree-setup.sh per-worktree kaizen.issue provisioning
# (#1111 advisory → #1113 mechanism).
#
# On a canonical case branch the hook now SELF-HEALS: it binds the worktree to
# its branch token mechanically (no manual step), overriding any inherited leak.
# On a tokenless branch (run worktree) it cannot derive an issue, so it falls
# back to the advisory warning when a shared value would leak in. A worktree
# that already owns a binding is left untouched.
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
mkdir -p "$MAIN/node_modules"
# A prior run wrote the binding the OLD way — into shared config.
git -C "$MAIN" config kaizen.issue 1106

WT="$ROOT/wt"
git -C "$MAIN" worktree add -q -b case/260626-k1111-b "$WT"

echo "=== Case branch + leaked shared value: auto-bind to branch token, override the leak ==="
OUT=$(cd "$WT" && bash "$HOOK" 2>&1 >/dev/null)
assert_contains "announces the auto-bind" "Auto-bound this worktree to #1111" "$OUT"
assert_not_contains "does not merely warn about a leak" "Leaked kaizen.issue" "$OUT"
# The binding is now worktree-scoped to the branch token, beating the shared 1106.
WT_BOUND=$(cd "$WT" && git config --worktree --get kaizen.issue 2>/dev/null)
assert_eq "worktree-scoped binding set to branch token" "1111" "$WT_BOUND"
MERGED=$(cd "$WT" && git config --get kaizen.issue 2>/dev/null)
assert_eq "merged read now wins for the worktree, not the leak" "1111" "$MERGED"

echo ""
echo "=== Already bound per-worktree: untouched, no auto-bind, no warning ==="
git -C "$WT" config --worktree kaizen.issue 1111
OUT2=$(cd "$WT" && bash "$HOOK" 2>&1 >/dev/null)
assert_not_contains "no auto-bind announcement when already bound" "Auto-bound" "$OUT2"
assert_not_contains "no leak warning once worktree owns its binding" "Leaked kaizen.issue" "$OUT2"

echo ""
echo "=== Fresh case worktree (no shared leak): still auto-binds before first edit ==="
WT2="$ROOT/wt2"
git -C "$MAIN" config --unset kaizen.issue  # no shared leak this time
git -C "$MAIN" worktree add -q -b case/260626-k1106-c "$WT2"
OUT3=$(cd "$WT2" && bash "$HOOK" 2>&1 >/dev/null)
assert_contains "auto-binds a fresh case worktree to its token" "Auto-bound this worktree to #1106" "$OUT3"
WT2_BOUND=$(cd "$WT2" && git config --worktree --get kaizen.issue 2>/dev/null)
assert_eq "fresh case worktree bound to its token" "1106" "$WT2_BOUND"

echo ""
echo "=== EnterWorktree-sanitized case branch: normalized before binding ==="
WT4="$ROOT/wt4"
git -C "$MAIN" worktree add -q -b worktree-case+260626-k1506-demo "$WT4"
OUT5=$(cd "$WT4" && bash "$HOOK" 2>&1 >/dev/null)
assert_contains "announces sanitized branch normalization" "Normalized branch worktree-case+260626-k1506-demo -> case/260626-k1506-demo" "$OUT5"
WT4_BRANCH=$(git -C "$WT4" rev-parse --abbrev-ref HEAD 2>/dev/null)
assert_eq "sanitized branch renamed to canonical case branch" "case/260626-k1506-demo" "$WT4_BRANCH"
WT4_BOUND=$(cd "$WT4" && git config --worktree --get kaizen.issue 2>/dev/null)
assert_eq "normalized branch bound to its issue token" "1506" "$WT4_BOUND"
if [ -L "$WT4/node_modules" ]; then
  echo "  PASS: normalized worktree gets dependency symlink"
  ((PASS++))
else
  echo "  FAIL: normalized worktree missing dependency symlink"
  FAILED_NAMES+=("normalized worktree gets dependency symlink")
  ((FAIL++))
fi

echo ""
echo "=== Tokenless run worktree inheriting a shared leak: advisory warning, no auto-bind ==="
git -C "$MAIN" config kaizen.issue 1106  # restore a shared leak
WT3="$ROOT/wt3"
git -C "$MAIN" worktree add -q -b worktree-2606261501-3542 "$WT3"
OUT4=$(cd "$WT3" && bash "$HOOK" 2>&1 >/dev/null)
assert_contains "warns about the leak on a tokenless branch" "Leaked kaizen.issue" "$OUT4"
assert_contains "names the inherited issue" "#1106" "$OUT4"
assert_not_contains "does not auto-bind a tokenless worktree" "Auto-bound" "$OUT4"
WT3_BOUND=$(cd "$WT3" && git config --worktree --get kaizen.issue 2>/dev/null || true)
assert_eq "tokenless worktree gets no worktree-scoped binding" "" "$WT3_BOUND"

echo ""
print_results
