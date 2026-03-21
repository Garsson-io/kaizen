#!/bin/bash
# Tests for kaizen-capture-worktree-context.sh — .worktree-context.json on PR creation
source "$(dirname "$0")/test-helpers.sh"

HOOK="$(dirname "$0")/../kaizen-capture-worktree-context.sh"
setup_test_env

setup() { reset_state; rm -f .worktree-context.json; }
teardown() { reset_state; rm -f .worktree-context.json; }

echo "=== Basic: gh pr create writes context file ==="

setup

PR_CREATE_INPUT=$(jq -n '{
  "tool_input": {"command": "gh pr create --repo Garsson-io/kaizen --title \"fix: worktree context\""},
  "tool_response": {
    "stdout": "https://github.com/Garsson-io/kaizen/pull/42",
    "stderr": "",
    "exit_code": "0"
  }
}')

echo "$PR_CREATE_INPUT" | bash "$HOOK" 2>/dev/null

if [ -f ".worktree-context.json" ]; then
  echo "  PASS: context file created"
  ((PASS++))

  PR_NUM=$(jq -r '.pr_number' .worktree-context.json)
  PR_URL=$(jq -r '.pr_url' .worktree-context.json)

  assert_eq "pr_number is 42" "42" "$PR_NUM"
  assert_eq "pr_url is correct" "https://github.com/Garsson-io/kaizen/pull/42" "$PR_URL"
else
  echo "  FAIL: context file not created"
  ((FAIL++))
fi

teardown

echo ""
echo "=== Non-PR commands do NOT create context file ==="

setup

# git push — should not trigger
GIT_PUSH_INPUT=$(jq -n '{
  "tool_input": {"command": "git push origin main"},
  "tool_response": {"stdout": "Everything up-to-date", "stderr": "", "exit_code": "0"}
}')
echo "$GIT_PUSH_INPUT" | bash "$HOOK" 2>/dev/null

assert_eq "git push does not create context" "false" "$([ -f .worktree-context.json ] && echo true || echo false)"

# npm test — should not trigger
NPM_INPUT=$(jq -n '{
  "tool_input": {"command": "npm test"},
  "tool_response": {"stdout": "all tests pass", "stderr": "", "exit_code": "0"}
}')
echo "$NPM_INPUT" | bash "$HOOK" 2>/dev/null

assert_eq "npm test does not create context" "false" "$([ -f .worktree-context.json ] && echo true || echo false)"

teardown

echo ""
echo "=== Failed gh pr create does NOT create context file ==="

setup

FAILED_PR=$(jq -n '{
  "tool_input": {"command": "gh pr create --title \"test\""},
  "tool_response": {"stdout": "", "stderr": "pull request create failed", "exit_code": "1"}
}')
echo "$FAILED_PR" | bash "$HOOK" 2>/dev/null

assert_eq "failed PR create does not write context" "false" "$([ -f .worktree-context.json ] && echo true || echo false)"

teardown

echo ""
echo "=== Merge with existing context file (preserves issue info) ==="

setup

# Pre-populate context with issue info (as if written by case creation)
cat > .worktree-context.json << 'EXISTING'
{
  "case_id": "case-123",
  "case_name": "260321-0149-k280-fix-waiver",
  "description": "Fix waiver quality",
  "issue_number": 280,
  "issue_repo": "Garsson-io/kaizen",
  "issue_url": "https://github.com/Garsson-io/kaizen/issues/280"
}
EXISTING

PR_CREATE_MERGE=$(jq -n '{
  "tool_input": {"command": "gh pr create --repo Garsson-io/kaizen --title \"fix: waiver quality\""},
  "tool_response": {
    "stdout": "https://github.com/Garsson-io/kaizen/pull/99",
    "stderr": "",
    "exit_code": "0"
  }
}')
echo "$PR_CREATE_MERGE" | bash "$HOOK" 2>/dev/null

if [ -f ".worktree-context.json" ]; then
  # Verify PR info was added
  PR_NUM=$(jq -r '.pr_number' .worktree-context.json)
  PR_URL=$(jq -r '.pr_url' .worktree-context.json)
  assert_eq "pr_number merged correctly" "99" "$PR_NUM"
  assert_eq "pr_url merged correctly" "https://github.com/Garsson-io/kaizen/pull/99" "$PR_URL"

  # Verify original issue info preserved
  ISSUE_NUM=$(jq -r '.issue_number' .worktree-context.json)
  CASE_NAME=$(jq -r '.case_name' .worktree-context.json)
  CASE_ID=$(jq -r '.case_id' .worktree-context.json)
  ISSUE_URL=$(jq -r '.issue_url' .worktree-context.json)

  assert_eq "issue_number preserved" "280" "$ISSUE_NUM"
  assert_eq "case_name preserved" "260321-0149-k280-fix-waiver" "$CASE_NAME"
  assert_eq "case_id preserved" "case-123" "$CASE_ID"
  assert_eq "issue_url preserved" "https://github.com/Garsson-io/kaizen/issues/280" "$ISSUE_URL"
else
  echo "  FAIL: context file missing after merge"
  ((FAIL++))
fi

teardown

echo ""
echo "=== PR URL from stderr fallback ==="

setup

# Some gh versions print the URL to stderr
PR_STDERR=$(jq -n '{
  "tool_input": {"command": "gh pr create --title \"test\""},
  "tool_response": {
    "stdout": "Creating pull request...",
    "stderr": "https://github.com/Garsson-io/kaizen/pull/55",
    "exit_code": "0"
  }
}')
echo "$PR_STDERR" | bash "$HOOK" 2>/dev/null

if [ -f ".worktree-context.json" ]; then
  PR_NUM=$(jq -r '.pr_number' .worktree-context.json)
  assert_eq "PR from stderr: number extracted" "55" "$PR_NUM"
else
  echo "  FAIL: context file not created from stderr URL"
  ((FAIL++))
fi

teardown

echo ""
echo "=== PR URL from --repo flag + bare number reconstruction ==="

setup

# gh pr create with --repo flag but URL only appears as reconstructed
PR_REPO_FLAG=$(jq -n '{
  "tool_input": {"command": "gh pr create --repo Garsson-io/kaizen --title \"test\""},
  "tool_response": {
    "stdout": "https://github.com/Garsson-io/kaizen/pull/77",
    "stderr": "",
    "exit_code": "0"
  }
}')
echo "$PR_REPO_FLAG" | bash "$HOOK" 2>/dev/null

if [ -f ".worktree-context.json" ]; then
  PR_URL=$(jq -r '.pr_url' .worktree-context.json)
  assert_eq "PR URL from repo flag" "https://github.com/Garsson-io/kaizen/pull/77" "$PR_URL"
else
  echo "  FAIL: context file not created with --repo flag"
  ((FAIL++))
fi

teardown

echo ""
echo "=== Heredoc body does not trigger false positive ==="

setup

# Command with heredoc containing "gh pr create" text
HEREDOC_INPUT=$(jq -n '{
  "tool_input": {"command": "cat <<EOF\ngh pr create --title test\nEOF"},
  "tool_response": {"stdout": "gh pr create --title test", "stderr": "", "exit_code": "0"}
}')
echo "$HEREDOC_INPUT" | bash "$HOOK" 2>/dev/null

assert_eq "heredoc body does not trigger context" "false" "$([ -f .worktree-context.json ] && echo true || echo false)"

teardown

echo ""
echo "=== Context file is valid JSON after multiple writes ==="

setup

# First PR
FIRST_PR=$(jq -n '{
  "tool_input": {"command": "gh pr create --title \"first\""},
  "tool_response": {"stdout": "https://github.com/Garsson-io/kaizen/pull/10", "stderr": "", "exit_code": "0"}
}')
echo "$FIRST_PR" | bash "$HOOK" 2>/dev/null

# Second PR (overwrite — agent may close and reopen PR)
SECOND_PR=$(jq -n '{
  "tool_input": {"command": "gh pr create --title \"second\""},
  "tool_response": {"stdout": "https://github.com/Garsson-io/kaizen/pull/11", "stderr": "", "exit_code": "0"}
}')
echo "$SECOND_PR" | bash "$HOOK" 2>/dev/null

# Validate JSON
if jq empty .worktree-context.json 2>/dev/null; then
  echo "  PASS: context file is valid JSON after two writes"
  ((PASS++))
  PR_NUM=$(jq -r '.pr_number' .worktree-context.json)
  assert_eq "second PR overwrites first" "11" "$PR_NUM"
else
  echo "  FAIL: context file is invalid JSON after two writes"
  ((FAIL++))
fi

teardown

echo ""
echo "=== Cross-repo PR: garsson-prints ==="

setup

PR_PRINTS=$(jq -n '{
  "tool_input": {"command": "gh pr create --repo Garsson-io/garsson-prints --title \"feat: prints\""},
  "tool_response": {"stdout": "https://github.com/Garsson-io/garsson-prints/pull/5", "stderr": "", "exit_code": "0"}
}')
echo "$PR_PRINTS" | bash "$HOOK" 2>/dev/null

if [ -f ".worktree-context.json" ]; then
  PR_URL=$(jq -r '.pr_url' .worktree-context.json)
  assert_eq "cross-repo PR URL" "https://github.com/Garsson-io/garsson-prints/pull/5" "$PR_URL"
else
  echo "  FAIL: context file not created for cross-repo PR"
  ((FAIL++))
fi

teardown

# Print summary
echo ""
print_results
