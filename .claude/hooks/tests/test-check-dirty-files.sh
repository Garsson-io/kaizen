#!/bin/bash
# Tests for kaizen-check-dirty-files.sh hook
# Run: bash .claude/kaizen/hooks/tests/test-kaizen-check-dirty-files.sh
#
# INVARIANT: gh pr create and git push are BLOCKED when dirty files exist.
# INVARIANT: gh pr merge is WARNED (advisory) when dirty files exist.
# INVARIANT: Clean worktree allows all commands.
# INVARIANT: node_modules, .DS_Store, dist/ are excluded from dirty check.
# SUT: kaizen-check-dirty-files.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOKS_DIR="$(dirname "$SCRIPT_DIR")"
HOOK="$HOOKS_DIR/kaizen-check-dirty-files.sh"
source "$SCRIPT_DIR/test-helpers.sh"

setup_mock_dir
trap 'rm -rf "$MOCK_DIR"' EXIT

echo "=== Non-triggering commands are ignored ==="

setup_git_status_mock " M src/dirty.ts"
OUTPUT=$(run_hook "$HOOK" "npm run build")
assert_eq "npm command ignored" "" "$OUTPUT"

OUTPUT=$(run_hook "$HOOK" "git add .")
assert_eq "git add ignored" "" "$OUTPUT"

OUTPUT=$(run_hook "$HOOK" "git commit -m test")
assert_eq "git commit ignored" "" "$OUTPUT"

echo ""
echo "=== Clean worktree allows all commands ==="

setup_git_status_mock ""

OUTPUT=$(run_hook "$HOOK" "gh pr create --title test --body test")
assert_eq "clean worktree allows pr create" "" "$OUTPUT"

OUTPUT=$(run_hook "$HOOK" "git push origin main")
assert_eq "clean worktree allows push" "" "$OUTPUT"

OUTPUT=$(run_hook "$HOOK" "gh pr merge 42")
assert_eq "clean worktree allows merge" "" "$OUTPUT"

echo ""
echo "=== Dirty worktree BLOCKS pr create ==="

setup_git_status_mock " M src/index.ts
?? debug-notes.txt"

OUTPUT=$(run_hook "$HOOK" "gh pr create --title test --body test")
assert_contains "pr create blocked with deny" "deny" "$OUTPUT"
assert_contains "pr create lists dirty files" "DIRTY FILES" "$OUTPUT"
assert_contains "pr create demands kaizen" "KAIZEN REFLECTION" "$OUTPUT"
assert_contains "pr create warns against stash" "DO NOT use" "$OUTPUT"

echo ""
echo "=== Dirty worktree BLOCKS git push ==="

OUTPUT=$(run_hook "$HOOK" "git push origin case/my-branch")
assert_contains "push blocked with deny" "deny" "$OUTPUT"
assert_contains "push says 'pushing code'" "pushing code" "$OUTPUT"

echo ""
echo "=== Dirty worktree WARNS on merge (advisory, not blocking) ==="

OUTPUT=$(run_hook "$HOOK" "gh pr merge 42")
assert_eq "merge not blocked (no JSON deny)" "" "$OUTPUT"

STDERR=$(run_hook_stderr "$HOOK" "gh pr merge 42")
assert_contains "merge warns on stderr" "DIRTY FILES DETECTED" "$STDERR"
assert_contains "merge demands kaizen on stderr" "KAIZEN REFLECTION" "$STDERR"

echo ""
echo "=== Noise patterns excluded ==="

setup_git_status_mock "?? node_modules/foo/bar.js
?? .DS_Store
?? dist/bundle.js"

OUTPUT=$(run_hook "$HOOK" "gh pr create --title test --body test")
assert_eq "noise-only files → allow" "" "$OUTPUT"

echo ""
echo "=== Mixed noise + real dirty files ==="

setup_git_status_mock "?? node_modules/foo.js
 M src/real-change.ts"

OUTPUT=$(run_hook "$HOOK" "gh pr create --title test --body test")
assert_contains "real dirty file causes block" "deny" "$OUTPUT"
assert_contains "real file listed" "real-change" "$OUTPUT"

echo ""
echo "=== Categorization: staged vs modified vs untracked ==="

setup_git_status_mock "M  src/staged.ts
 M src/modified.ts
?? src/untracked.ts"

OUTPUT=$(run_hook "$HOOK" "gh pr create --title test --body test")
assert_contains "shows staged category" "Staged but not committed" "$OUTPUT"
assert_contains "shows modified category" "Modified" "$OUTPUT"
assert_contains "shows untracked category" "Untracked" "$OUTPUT"

echo ""
echo "=== .worktree-lock.json excluded from dirty check (kaizen #225) ==="

setup_git_status_mock " D .worktree-lock.json"

OUTPUT=$(run_hook "$HOOK" "git push origin my-branch")
assert_eq "worktree-lock.json alone → allow" "" "$OUTPUT"

echo ""
echo "=== .worktree-lock.json excluded but real dirty files still block ==="

setup_git_status_mock " D .worktree-lock.json
 M src/real-change.ts"

OUTPUT=$(run_hook "$HOOK" "git push origin my-branch")
assert_contains "real dirty file still blocks" "deny" "$OUTPUT"
assert_contains "real file listed" "real-change" "$OUTPUT"
assert_not_contains "worktree-lock not listed as dirty" "worktree-lock" "$OUTPUT"

print_results

echo ""
echo "=== Cross-worktree: git -C targets correct directory (kaizen #232) ==="

# Create a mock git that differentiates based on -C flag
cat > "$MOCK_DIR/git" << 'MOCK'
#!/bin/bash
# When -C /clean/worktree, return clean status
if echo "$@" | grep -q "\-C /clean/worktree"; then
  if echo "$@" | grep -q "status --porcelain"; then
    # Clean worktree
    exit 0
  fi
fi
# When -C /dirty/worktree or no -C (CWD), return dirty status
if echo "$@" | grep -q "status --porcelain"; then
  echo " M src/dirty-in-cwd.ts"
  exit 0
fi
/usr/bin/git "$@"
MOCK
chmod +x "$MOCK_DIR/git"

# Push with -C to clean worktree should be allowed even if CWD is dirty
OUTPUT=$(run_hook "$HOOK" "git -C /clean/worktree push origin main")
assert_eq "push to clean worktree via -C is allowed" "" "$OUTPUT"

# Push without -C should be blocked (dirty CWD)
OUTPUT=$(run_hook "$HOOK" "git push origin main")
assert_contains "push without -C blocked (dirty CWD)" "deny" "$OUTPUT"

# Push with -C to another path (mock returns dirty for everything else)
cat > "$MOCK_DIR/git" << 'MOCK'
#!/bin/bash
if echo "$@" | grep -q "\-C /dirty/other"; then
  if echo "$@" | grep -q "status --porcelain"; then
    echo " M src/dirty-remote.ts"
    exit 0
  fi
fi
if echo "$@" | grep -q "status --porcelain"; then
  exit 0
fi
/usr/bin/git "$@"
MOCK
chmod +x "$MOCK_DIR/git"

OUTPUT=$(run_hook "$HOOK" "git -C /dirty/other push origin main")
assert_contains "push to dirty worktree via -C is blocked" "deny" "$OUTPUT"
