#!/bin/bash
# Tests for lib/parse-command.sh shared utilities
# Run: bash .claude/kaizen/hooks/tests/test-parse-command.sh
#
# INVARIANT: extract_pr_number returns ONLY the PR number from the correct
#   position in "gh pr <subcommand> <number>" — never from flags or other args.
# INVARIANT: is_gh_pr_command matches gh pr as a COMMAND, not as text in strings.
# INVARIANT: is_git_command matches git as a COMMAND, not as text in strings.
# INVARIANT: get_pr_changed_files uses gh pr diff for merges, git diff for creates.
# SUT: lib/parse-command.sh functions

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOKS_DIR="$(dirname "$SCRIPT_DIR")"
source "$HOOKS_DIR/lib/parse-command.sh"
source "$SCRIPT_DIR/test-helpers.sh"

echo "=== extract_pr_number ==="

assert_eq "merge with PR number" \
  "42" \
  "$(extract_pr_number "gh pr merge 42" "merge")"

assert_eq "merge with PR number and flags" \
  "42" \
  "$(extract_pr_number "gh pr merge 42 --repo Garsson-io/nanoclaw" "merge")"

assert_eq "merge without PR number" \
  "" \
  "$(extract_pr_number "gh pr merge" "merge")"

assert_eq "merge without PR number but with flags" \
  "" \
  "$(extract_pr_number "gh pr merge --squash --repo Garsson-io/nanoclaw" "merge")"

assert_eq "merge should not match repo numbers" \
  "" \
  "$(extract_pr_number "gh pr merge --delete-branch" "merge")"

assert_eq "view with PR number" \
  "99" \
  "$(extract_pr_number "gh pr view 99" "view")"

assert_eq "diff with PR number" \
  "7" \
  "$(extract_pr_number "gh pr diff 7 --name-only" "diff")"

assert_eq "extra whitespace" \
  "123" \
  "$(extract_pr_number "gh  pr  merge  123" "merge")"

assert_eq "create should not match merge pattern" \
  "" \
  "$(extract_pr_number "gh pr create --title foo" "merge")"

echo ""
echo "=== strip_heredoc_body ==="

assert_eq "simple command preserved" \
  "gh pr merge 42" \
  "$(strip_heredoc_body "gh pr merge 42")"

assert_eq "heredoc body stripped" \
  "gh pr create --title \"test\" --body \"\$(cat" \
  "$(strip_heredoc_body 'gh pr create --title "test" --body "$(cat
<<EOF
some body content
EOF
)"')"

echo ""
echo "=== is_gh_pr_command ==="

# Direct commands — should match
assert_ok "direct gh pr create" \
  is_gh_pr_command "gh pr create --title test" "create"

assert_ok "direct gh pr merge" \
  is_gh_pr_command "gh pr merge 42" "merge"

assert_ok "merge matches create|merge" \
  is_gh_pr_command "gh pr merge 42 --repo Garsson-io/nanoclaw" "create|merge"

# Chained/piped commands — should match
assert_ok "gh pr create after &&" \
  is_gh_pr_command "npm build && gh pr create --title test" "create"

assert_ok "gh pr create after pipe" \
  is_gh_pr_command "cat file | gh pr create" "create"

# FALSE POSITIVES — should NOT match
assert_fails "gh pr create inside echo" \
  is_gh_pr_command "echo 'gh pr create' | bash hook.sh" "create"

assert_fails "gh pr merge inside JSON echo" \
  is_gh_pr_command "echo '{\"command\":\"gh pr merge 42\"}' | bash -x hook.sh" "merge"

# Wrong subcommand — should NOT match
assert_fails "create should not match merge" \
  is_gh_pr_command "gh pr create --title test" "merge"

assert_fails "git push should not match gh pr" \
  is_gh_pr_command "git push origin main" "create|merge"

echo ""
echo "=== is_git_command ==="

assert_ok "direct git push" \
  is_git_command "git push origin main" "push"

assert_ok "git push after &&" \
  is_git_command "npm build && git push" "push"

assert_fails "git push inside echo" \
  is_git_command "echo 'git push' | bash hook.sh" "push"

assert_fails "git commit should not match push" \
  is_git_command "git commit -m test" "push"

echo ""
echo "=== extract_repo_flag ==="

assert_eq "extracts --repo value" \
  "Garsson-io/garsson-prints" \
  "$(extract_repo_flag "gh pr merge 5 --repo Garsson-io/garsson-prints --merge")"

assert_eq "extracts --repo without PR number" \
  "Garsson-io/nanoclaw" \
  "$(extract_repo_flag "gh pr merge --repo Garsson-io/nanoclaw")"

assert_eq "no --repo returns empty" \
  "" \
  "$(extract_repo_flag "gh pr merge 42")"

assert_eq "extracts --repo from create" \
  "Garsson-io/garsson-prints" \
  "$(extract_repo_flag "gh pr create --title test --repo Garsson-io/garsson-prints")"

echo ""
echo "=== detect_gh_repo ==="

# Test with the real repo (we're in a nanoclaw worktree)
REPO=$(detect_gh_repo)
assert_eq "detects repo from origin" "Garsson-io/nanoclaw" "$REPO"

echo ""
echo "=== get_pr_changed_files (with mocked gh/git) ==="

# Create temp dir with mock commands
MOCK_DIR=$(mktemp -d)
trap 'rm -rf "$MOCK_DIR"' EXIT

cat > "$MOCK_DIR/gh" << 'MOCK'
#!/bin/bash
if echo "$@" | grep -q "pr diff"; then
  echo "src/index.ts"
  echo "src/config.ts"
  exit 0
fi
exit 1
MOCK
chmod +x "$MOCK_DIR/gh"

cat > "$MOCK_DIR/git" << 'MOCK'
#!/bin/bash
if echo "$@" | grep -q "remote get-url"; then
  echo "https://github.com/Garsson-io/nanoclaw.git"
  exit 0
fi
if echo "$@" | grep -q "diff --name-only"; then
  echo "src/index.ts"
  echo "src/config.ts"
  echo "src/unrelated-dirty-file.ts"
  echo ".claude/kaizen/hooks/some-hook.sh"
  exit 0
fi
/usr/bin/git "$@"
MOCK
chmod +x "$MOCK_DIR/git"

export PATH="$MOCK_DIR:$PATH"

MERGE_FILES=$(get_pr_changed_files "gh pr merge 42" "true")
MERGE_COUNT=$(echo "$MERGE_FILES" | wc -l | tr -d ' ')
assert_eq "merge uses gh pr diff (2 files from PR)" \
  "2" \
  "$MERGE_COUNT"

DIRTY_COUNT=$(echo "$MERGE_FILES" | grep -c "unrelated-dirty-file" || true)
assert_eq "merge result does NOT contain unrelated dirty file" \
  "0" \
  "$DIRTY_COUNT"

CREATE_FILES=$(get_pr_changed_files "gh pr create --title test" "false")
CREATE_COUNT=$(echo "$CREATE_FILES" | wc -l | tr -d ' ')
assert_eq "create uses git diff (4 files from worktree)" \
  "4" \
  "$CREATE_COUNT"

# Test fallback: gh fails
cat > "$MOCK_DIR/gh" << 'MOCK'
#!/bin/bash
exit 1
MOCK
chmod +x "$MOCK_DIR/gh"

FALLBACK_FILES=$(get_pr_changed_files "gh pr merge 42" "true" 2>/dev/null)
FALLBACK_COUNT=$(echo "$FALLBACK_FILES" | wc -l | tr -d ' ')
assert_eq "merge falls back to git diff when gh fails (4 files)" \
  "4" \
  "$FALLBACK_COUNT"

echo ""
echo "=== reconstruct_pr_url (kaizen #111) ==="

# Fallback 1: URL in stdout
assert_eq "URL from stdout" \
  "https://github.com/Garsson-io/nanoclaw/pull/42" \
  "$(reconstruct_pr_url "gh pr merge 42" "https://github.com/Garsson-io/nanoclaw/pull/42" "" "merge")"

# Fallback 2: URL in stderr
assert_eq "URL from stderr" \
  "https://github.com/Garsson-io/nanoclaw/pull/42" \
  "$(reconstruct_pr_url "gh pr merge 42" "" "https://github.com/Garsson-io/nanoclaw/pull/42" "merge")"

# Fallback 3: URL in command args
assert_eq "URL from command args" \
  "https://github.com/Garsson-io/nanoclaw/pull/42" \
  "$(reconstruct_pr_url "gh pr merge https://github.com/Garsson-io/nanoclaw/pull/42 --squash" "" "" "merge")"

# Fallback 4: --repo + bare PR number
assert_eq "reconstruct from --repo + bare number" \
  "https://github.com/Garsson-io/nanoclaw/pull/150" \
  "$(reconstruct_pr_url "gh pr merge 150 --repo Garsson-io/nanoclaw --squash --delete-branch --auto" "" "" "merge")"

# Fallback 4 with different repo
assert_eq "reconstruct from --repo + bare number (garsson-prints)" \
  "https://github.com/Garsson-io/garsson-prints/pull/5" \
  "$(reconstruct_pr_url "gh pr merge 5 --repo Garsson-io/garsson-prints --merge" "" "" "merge")"

# Fallback 5: bare PR number + git remote detection
assert_eq "reconstruct from bare number + git remote" \
  "https://github.com/Garsson-io/nanoclaw/pull/99" \
  "$(reconstruct_pr_url "gh pr merge 99 --squash" "" "" "merge")"

# Empty when no PR number and no URL anywhere
assert_eq "empty when no URL or number" \
  "" \
  "$(reconstruct_pr_url "gh pr merge --squash --delete-branch" "" "" "merge")"

# Priority: stdout URL wins over --repo reconstruction
assert_eq "stdout URL takes priority over reconstruction" \
  "https://github.com/Garsson-io/nanoclaw/pull/42" \
  "$(reconstruct_pr_url "gh pr merge 99 --repo Garsson-io/nanoclaw" "https://github.com/Garsson-io/nanoclaw/pull/42" "" "merge")"

# Works with create subcommand
assert_eq "reconstruct works for create" \
  "https://github.com/Garsson-io/nanoclaw/pull/55" \
  "$(reconstruct_pr_url "gh pr create" "https://github.com/Garsson-io/nanoclaw/pull/55" "" "create")"

# --auto flag doesn't interfere
assert_eq "works with --auto flag" \
  "https://github.com/Garsson-io/nanoclaw/pull/150" \
  "$(reconstruct_pr_url "gh pr merge 150 --repo Garsson-io/nanoclaw --squash --delete-branch --auto" "" "" "merge")"

print_results

echo ""
echo "=== extract_git_c_path ==="

source "$(dirname "$0")/../lib/parse-command.sh"

RESULT=$(extract_git_c_path "git -C /path/to/worktree push origin main")
assert_eq "extracts -C path from git push" "/path/to/worktree" "$RESULT"

RESULT=$(extract_git_c_path "git -C /home/user/projects/repo push")
assert_eq "extracts -C path with deep path" "/home/user/projects/repo" "$RESULT"

RESULT=$(extract_git_c_path "git push origin main")
assert_eq "no -C returns empty" "" "$RESULT"

RESULT=$(extract_git_c_path "git -C /worktree1 push && git -C /worktree2 push")
assert_eq "extracts first -C from chained commands" "/worktree1" "$RESULT"

echo ""
echo "=== is_git_command with -C flag ==="

is_git_command "git -C /some/path push origin main" "push" && RESULT="matched" || RESULT="no match"
assert_eq "git -C path push matches push" "matched" "$RESULT"

is_git_command "git -C /some/path fetch origin" "push" && RESULT="matched" || RESULT="no match"
assert_eq "git -C path fetch does not match push" "no match" "$RESULT"

is_git_command "git -C /some/path push" "push" && RESULT="matched" || RESULT="no match"
assert_eq "git -C path push (no remote) matches push" "matched" "$RESULT"
