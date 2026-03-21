#!/bin/bash
# Tests for kaizen-check-cleanup-on-stop.sh — Stop hook that warns about
# uncommitted changes and removes lock files on session end.
#
# INVARIANT UNDER TEST: In a worktree, the hook warns about dirty files
# and unpushed commits, and removes lock files. In main checkout, it
# does nothing. It never blocks (always exits 0).
source "$(dirname "$0")/test-helpers.sh"

HOOK="$(cd "$(dirname "$0")/.." && pwd)/kaizen-check-cleanup-on-stop.sh"

MOCK_DIR=$(mktemp -d)
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$MOCK_DIR" "$WORK_DIR"' EXIT

# Helper: create mock git for worktree context
setup_worktree_git_mock() {
  local branch="$1"
  local git_common_dir="${2:-.git/worktrees/test}"
  local toplevel="${3:-$WORK_DIR}"
  local status_output="${4:-}"
  local unpushed_count="${5:-0}"

  cat > "$MOCK_DIR/git" << MOCK
#!/bin/bash
case "\$*" in
  *"rev-parse --abbrev-ref HEAD"*)
    echo "$branch"
    exit 0
    ;;
  *"rev-parse --show-toplevel"*)
    echo "$toplevel"
    exit 0
    ;;
  *"rev-parse --git-common-dir"*)
    echo "$git_common_dir"
    exit 0
    ;;
  *"status --porcelain"*)
    printf '%s' "$status_output"
    exit 0
    ;;
  *"log --oneline"*)
    # Generate N lines of fake unpushed commits
    for i in \$(seq 1 $unpushed_count); do
      echo "abc123\$i fix something"
    done
    exit 0
    ;;
  *)
    /usr/bin/git "\$@"
    ;;
esac
MOCK
  chmod +x "$MOCK_DIR/git"
}

# Helper: create mock git for main checkout context
setup_main_checkout_git_mock() {
  cat > "$MOCK_DIR/git" << 'MOCK'
#!/bin/bash
case "$*" in
  *"rev-parse --abbrev-ref HEAD"*)
    echo "main"
    exit 0
    ;;
  *"rev-parse --show-toplevel"*)
    echo "/home/user/projects/nanoclaw"
    exit 0
    ;;
  *"rev-parse --git-common-dir"*)
    echo ".git"
    exit 0
    ;;
  *)
    /usr/bin/git "$@"
    ;;
esac
MOCK
  chmod +x "$MOCK_DIR/git"
}

run_hook() {
  PATH="$MOCK_DIR:$PATH" bash "$HOOK" 2>&1
}

echo "=== Main checkout: no output, exits 0 ==="

# INVARIANT: Hook does nothing in main checkout (GIT_COMMON_DIR == ".git")
# SUT: kaizen-check-cleanup-on-stop.sh main checkout guard
setup_main_checkout_git_mock
OUTPUT=$(run_hook)
EXIT_CODE=$?
assert_eq "exit code 0 in main checkout" "0" "$EXIT_CODE"
assert_eq "no output in main checkout" "" "$OUTPUT"

echo ""
echo "=== Clean worktree: no warnings ==="

# INVARIANT: Clean worktree with no unpushed commits produces no warnings
# SUT: kaizen-check-cleanup-on-stop.sh clean state
setup_worktree_git_mock "fix/test-branch" ".git/worktrees/test" "$WORK_DIR" "" "0"
OUTPUT=$(run_hook)
EXIT_CODE=$?
assert_eq "exit code 0 in clean worktree" "0" "$EXIT_CODE"
assert_not_contains "no uncommitted warning" "uncommitted" "$OUTPUT"
assert_not_contains "no unpushed warning" "unpushed" "$OUTPUT"

echo ""
echo "=== Dirty worktree: warns about uncommitted changes ==="

# INVARIANT: When worktree has uncommitted changes, hook warns with file list
# SUT: kaizen-check-cleanup-on-stop.sh dirty file detection
DIRTY_OUTPUT=" M src/index.ts
 M src/cases.ts
?? new-file.ts"
setup_worktree_git_mock "fix/dirty-branch" ".git/worktrees/test" "$WORK_DIR" "$DIRTY_OUTPUT" "0"
OUTPUT=$(run_hook)
EXIT_CODE=$?
assert_eq "exit code 0 even with dirty files (advisory)" "0" "$EXIT_CODE"
assert_contains "warns about uncommitted changes" "uncommitted" "$OUTPUT"
assert_contains "shows dirty files" "src/index.ts" "$OUTPUT"

echo ""
echo "=== Unpushed commits: warns about unpushed ==="

# INVARIANT: When worktree has unpushed commits, hook warns with count
# SUT: kaizen-check-cleanup-on-stop.sh unpushed commit detection
setup_worktree_git_mock "fix/unpushed-branch" ".git/worktrees/test" "$WORK_DIR" "" "3"
OUTPUT=$(run_hook)
EXIT_CODE=$?
assert_eq "exit code 0 with unpushed commits (advisory)" "0" "$EXIT_CODE"
assert_contains "warns about unpushed commits" "unpushed" "$OUTPUT"
assert_contains "shows commit count" "3" "$OUTPUT"

echo ""
echo "=== Both dirty and unpushed: warns about both ==="

# INVARIANT: Both warnings can fire simultaneously
# SUT: kaizen-check-cleanup-on-stop.sh with both conditions
setup_worktree_git_mock "fix/both" ".git/worktrees/test" "$WORK_DIR" " M src/foo.ts" "2"
OUTPUT=$(run_hook)
EXIT_CODE=$?
assert_eq "exit code 0 with both conditions (advisory)" "0" "$EXIT_CODE"
assert_contains "warns about uncommitted" "uncommitted" "$OUTPUT"
assert_contains "warns about unpushed" "unpushed" "$OUTPUT"

echo ""
echo "=== Lock file removal: removes lock on stop ==="

# INVARIANT: If .worktree-lock.json exists, it is removed on stop
# SUT: kaizen-check-cleanup-on-stop.sh lock file cleanup
setup_worktree_git_mock "fix/locked" ".git/worktrees/test" "$WORK_DIR" "" "0"
echo '{"pid": 12345}' > "$WORK_DIR/.worktree-lock.json"

# Verify lock exists before hook
if [ -f "$WORK_DIR/.worktree-lock.json" ]; then
  echo "  PASS: lock file exists before hook"
  ((PASS++))
else
  echo "  FAIL: lock file should exist before hook"
  ((FAIL++))
fi

OUTPUT=$(run_hook)
EXIT_CODE=$?
assert_eq "exit code 0 after lock removal" "0" "$EXIT_CODE"

if [ ! -f "$WORK_DIR/.worktree-lock.json" ]; then
  echo "  PASS: lock file removed after hook"
  ((PASS++))
else
  echo "  FAIL: lock file should be removed after hook"
  ((FAIL++))
fi

echo ""
echo "=== No lock file: no error ==="

# INVARIANT: Missing lock file doesn't cause errors
# SUT: kaizen-check-cleanup-on-stop.sh with no lock file
setup_worktree_git_mock "fix/no-lock" ".git/worktrees/test" "$WORK_DIR" "" "0"
rm -f "$WORK_DIR/.worktree-lock.json"
OUTPUT=$(run_hook)
EXIT_CODE=$?
assert_eq "exit code 0 with no lock file" "0" "$EXIT_CODE"

echo ""
echo "=== Empty GIT_COMMON_DIR: treated as non-worktree ==="

# INVARIANT: If git commands fail (empty output), hook exits cleanly
# SUT: kaizen-check-cleanup-on-stop.sh error handling
setup_worktree_git_mock "main" "" "$WORK_DIR" "" "0"
OUTPUT=$(run_hook)
EXIT_CODE=$?
assert_eq "exit code 0 with empty git common dir" "0" "$EXIT_CODE"

print_results
