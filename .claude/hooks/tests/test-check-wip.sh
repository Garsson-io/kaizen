#!/bin/bash
# Tests for kaizen-check-wip.sh — SessionStart hook that detects in-progress work
# when starting a session in the main checkout.
#
# INVARIANT UNDER TEST: In main checkout, the hook surfaces WIP (worktrees,
# PRs, unmerged branches, cases). In worktrees, it exits silently.
# It never blocks (always exits 0).
source "$(dirname "$0")/test-helpers.sh"

HOOK="$(dirname "$0")/../kaizen-check-wip.sh"

MOCK_DIR=$(mktemp -d)
trap 'rm -rf "$MOCK_DIR"' EXIT

# Helper: create mock git
setup_git_mock() {
  local git_common_dir="$1"
  local toplevel="${2:-/home/user/projects/nanoclaw}"
  local branch="${3:-main}"
  local worktree_list="${4:-}"
  local unmerged_branches="${5:-}"

  cat > "$MOCK_DIR/git" << MOCK
#!/bin/bash
case "\$*" in
  *"rev-parse --git-common-dir"*)
    echo "$git_common_dir"
    exit 0
    ;;
  *"rev-parse --show-toplevel"*)
    echo "$toplevel"
    exit 0
    ;;
  *"rev-parse --abbrev-ref HEAD"*)
    echo "$branch"
    exit 0
    ;;
  *"worktree list --porcelain"*)
    # Main worktree + any extras
    echo "worktree $toplevel"
    echo "HEAD abc1234"
    echo "branch refs/heads/main"
    echo ""
    printf '%s' "$worktree_list"
    exit 0
    ;;
  *"branch --no-merged"*)
    printf '%s' "$unmerged_branches"
    exit 0
    ;;
  *"-C"*)
    # For git -C <worktree> commands
    if echo "\$*" | grep -q "rev-parse --abbrev-ref HEAD"; then
      echo "fix/some-branch"
      exit 0
    fi
    if echo "\$*" | grep -q "status --porcelain"; then
      echo ""
      exit 0
    fi
    exit 0
    ;;
  *)
    /usr/bin/git "\$@"
    ;;
esac
MOCK
  chmod +x "$MOCK_DIR/git"
}

# Helper: create mock gh
setup_gh_mock() {
  local pr_list="${1:-}"
  cat > "$MOCK_DIR/gh" << MOCK
#!/bin/bash
if echo "\$*" | grep -q "pr list"; then
  printf '%s' "$pr_list"
  exit 0
fi
exit 0
MOCK
  chmod +x "$MOCK_DIR/gh"
}

# Helper: create mock CLI kaizen (for case listing)
setup_cli_kaizen_mock() {
  local cases_json="${1:-[]}"
  cat > "$MOCK_DIR/npx" << MOCK
#!/bin/bash
if echo "\$*" | grep -q "cli-kaizen"; then
  echo '$cases_json'
  exit 0
fi
# For resolve-cli-kaizen fallback
exit 1
MOCK
  chmod +x "$MOCK_DIR/npx"

  # Also mock node for the case list parsing
  cat > "$MOCK_DIR/node" << MOCK
#!/bin/bash
if echo "\$*" | grep -q "dist/cli-kaizen"; then
  echo '$cases_json'
  exit 0
fi
# For the node -e pipeline that parses cases JSON
/usr/bin/node "\$@"
MOCK
  chmod +x "$MOCK_DIR/node"
}

run_hook() {
  PATH="$MOCK_DIR:$PATH" bash "$HOOK" 2>&1
}

echo "=== Worktree context: exits silently ==="

# INVARIANT: Hook only runs in main checkout; exits 0 immediately in worktrees
# SUT: kaizen-check-wip.sh main checkout guard (GIT_COMMON_DIR != ".git")
setup_git_mock ".git/worktrees/test-wt" "/home/user/projects/nanoclaw/.claude/worktrees/test"
OUTPUT=$(run_hook)
EXIT_CODE=$?
assert_eq "exit code 0 in worktree" "0" "$EXIT_CODE"
assert_eq "no output in worktree" "" "$OUTPUT"

echo ""
echo "=== Main checkout, no WIP: shows warning only ==="

# INVARIANT: In main checkout with no WIP, shows worktree warning but no WIP summary
# SUT: kaizen-check-wip.sh main checkout with clean state
setup_git_mock ".git" "/home/user/projects/nanoclaw" "main" "" ""
setup_gh_mock ""
setup_cli_kaizen_mock "[]"
OUTPUT=$(run_hook)
EXIT_CODE=$?
assert_eq "exit code 0 in main checkout" "0" "$EXIT_CODE"
assert_contains "shows worktree warning" "WARNING" "$OUTPUT"
assert_contains "suggests claude-wt" "claude-wt" "$OUTPUT"
assert_not_contains "no WIP summary when clean" "in-progress work" "$OUTPUT"

echo ""
echo "=== Main checkout with open PRs: lists them ==="

# INVARIANT: Open PRs are surfaced in the WIP summary
# SUT: kaizen-check-wip.sh PR detection via gh pr list
setup_git_mock ".git" "/home/user/projects/nanoclaw" "main" "" ""
setup_gh_mock "#42 Fix auth bug (fix/auth-bug)
#43 Add feature (feat/new-feature)"
setup_cli_kaizen_mock "[]"
OUTPUT=$(run_hook)
EXIT_CODE=$?
assert_eq "exit code 0 with open PRs" "0" "$EXIT_CODE"
assert_contains "shows open PRs" "Open PRs" "$OUTPUT"
assert_contains "lists PR 42" "#42" "$OUTPUT"
assert_contains "lists PR 43" "#43" "$OUTPUT"

echo ""
echo "=== Main checkout with unmerged branches: lists them ==="

# INVARIANT: Unmerged branches are surfaced in the WIP summary
# SUT: kaizen-check-wip.sh unmerged branch detection
setup_git_mock ".git" "/home/user/projects/nanoclaw" "main" "" "  fix/old-branch
  feat/wip-feature"
setup_gh_mock ""
setup_cli_kaizen_mock "[]"
OUTPUT=$(run_hook)
EXIT_CODE=$?
assert_eq "exit code 0 with unmerged branches" "0" "$EXIT_CODE"
assert_contains "shows unmerged branches" "Unmerged branches" "$OUTPUT"
assert_contains "lists branch" "fix/old-branch" "$OUTPUT"

echo ""
echo "=== Main checkout with worktrees: lists them ==="

# INVARIANT: Non-main worktrees are surfaced in the WIP summary
# SUT: kaizen-check-wip.sh worktree detection
WORKTREE_LIST="worktree /home/user/projects/nanoclaw/.claude/worktrees/test-wt
HEAD def5678
branch refs/heads/fix/some-branch
"
setup_git_mock ".git" "/home/user/projects/nanoclaw" "main" "$WORKTREE_LIST" ""
setup_gh_mock ""
setup_cli_kaizen_mock "[]"
OUTPUT=$(run_hook)
EXIT_CODE=$?
assert_eq "exit code 0 with worktrees" "0" "$EXIT_CODE"
assert_contains "shows worktrees section" "Worktrees" "$OUTPUT"

echo ""
echo "=== Never blocks: always exits 0 ==="

# INVARIANT: This hook is advisory — never blocks the session
# SUT: kaizen-check-wip.sh exit code across all scenarios
setup_git_mock ".git" "/home/user/projects/nanoclaw" "main" "" "  branch1
  branch2
  branch3"
setup_gh_mock "#1 PR one (b1)
#2 PR two (b2)"
setup_cli_kaizen_mock "[]"
OUTPUT=$(run_hook)
EXIT_CODE=$?
assert_eq "exit code 0 even with lots of WIP" "0" "$EXIT_CODE"

echo ""
echo "=== gh not available: skips PR listing gracefully ==="

# INVARIANT: If gh CLI is not available, PR section is skipped
# SUT: kaizen-check-wip.sh graceful degradation
setup_git_mock ".git" "/home/user/projects/nanoclaw" "main" "" "  some-branch"
# Remove gh mock so command -v gh fails
rm -f "$MOCK_DIR/gh"
setup_cli_kaizen_mock "[]"
OUTPUT=$(run_hook)
EXIT_CODE=$?
assert_eq "exit code 0 without gh" "0" "$EXIT_CODE"
assert_not_contains "no PR section without gh" "Open PRs" "$OUTPUT"

# Restore gh mock for remaining tests
setup_gh_mock ""

print_results
