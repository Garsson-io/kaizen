#!/bin/bash
# Tests for kaizen-pr-kaizen-clear-fallback.sh — Bash fallback for PR kaizen gate clearing.
#
# INVARIANT UNDER TEST: When the TS clearing hook fails/times out, the bash
# fallback clears the PR kaizen gate on valid KAIZEN_IMPEDIMENTS or
# KAIZEN_NO_ACTION declarations. This prevents the gate from getting stuck
# and blocking all Bash commands indefinitely. (kaizen #492)
source "$(dirname "$0")/test-helpers.sh"

HOOK="$(dirname "$0")/../kaizen-pr-kaizen-clear-fallback.sh"
require_file "$HOOK" "kaizen-pr-kaizen-clear-fallback.sh" || exit 0
setup_test_env

setup() { reset_state; }
teardown() { reset_state; }

# Helper: create PR kaizen state file
create_pr_kaizen_state() {
  local pr_url="$1"
  local branch="${2:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)}"
  local filename
  filename="pr-kaizen-$(echo "$pr_url" | sed 's|https://github\.com/||;s|/pull/|_|;s|/|_|g')"
  printf 'PR_URL=%s\nSTATUS=%s\nBRANCH=%s\n' \
    "$pr_url" "needs_pr_kaizen" "$branch" > "$STATE_DIR/$filename"
}

# Helper: run PostToolUse hook simulating a Bash command
run_posttool_bash() {
  local command="$1"
  local stdout="$2"
  local exit_code="${3:-0}"
  local input
  input=$(jq -n \
    --arg cmd "$command" \
    --arg out "$stdout" \
    --arg ec "$exit_code" '{
    tool_name: "Bash",
    tool_input: { command: $cmd },
    tool_response: { stdout: $out, stderr: "", exit_code: ($ec | tonumber) }
  }')
  echo "$input" | bash "$HOOK" 2>/dev/null
}

# Helper: check gate status
get_gate_status() {
  local pr_url="$1"
  local filename
  filename="pr-kaizen-$(echo "$pr_url" | sed 's|https://github\.com/||;s|/pull/|_|;s|/|_|g')"
  grep -E '^STATUS=' "$STATE_DIR/$filename" 2>/dev/null | cut -d= -f2-
}

echo "Test: kaizen-pr-kaizen-clear-fallback.sh"

# Test 1: clears gate on KAIZEN_NO_ACTION
setup
create_pr_kaizen_state "https://github.com/test/repo/pull/1"
run_posttool_bash \
  "echo 'KAIZEN_NO_ACTION [docs-only]: test reason'" \
  "KAIZEN_NO_ACTION [docs-only]: test reason"
STATUS=$(get_gate_status "https://github.com/test/repo/pull/1")
assert_eq "clears gate on KAIZEN_NO_ACTION" "kaizen_done" "$STATUS"

# Test 2: clears gate on KAIZEN_IMPEDIMENTS
setup
create_pr_kaizen_state "https://github.com/test/repo/pull/2"
run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[{\"impediment\": \"test\", \"disposition\": \"filed\", \"ref\": \"#1\"}]
IMPEDIMENTS" \
  'KAIZEN_IMPEDIMENTS:
[{"impediment": "test", "disposition": "filed", "ref": "#1"}]'
STATUS=$(get_gate_status "https://github.com/test/repo/pull/2")
assert_eq "clears gate on KAIZEN_IMPEDIMENTS" "kaizen_done" "$STATUS"

# Test 3: does NOT fire on unrelated commands
setup
create_pr_kaizen_state "https://github.com/test/repo/pull/3"
run_posttool_bash "echo hello" "hello"
STATUS=$(get_gate_status "https://github.com/test/repo/pull/3")
assert_eq "does not clear on unrelated command" "needs_pr_kaizen" "$STATUS"

# Test 4: does nothing when no gate exists
setup
OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_NO_ACTION [docs-only]: test'" \
  "KAIZEN_NO_ACTION [docs-only]: test")
assert_eq "no output when no gate exists" "" "$OUTPUT"

# Test 5: ignores non-Bash tools
setup
create_pr_kaizen_state "https://github.com/test/repo/pull/5"
INPUT=$(jq -n '{
  tool_name: "Read",
  tool_input: { file_path: "/tmp/test" },
  tool_response: { content: "KAIZEN_NO_ACTION [docs-only]: test" }
}')
echo "$INPUT" | bash "$HOOK" 2>/dev/null
STATUS=$(get_gate_status "https://github.com/test/repo/pull/5")
assert_eq "ignores non-Bash tools" "needs_pr_kaizen" "$STATUS"

# Test 6: clears cross-branch gates (the actual #492 bug)
setup
create_pr_kaizen_state "https://github.com/test/repo/pull/6" "some-other-branch"
run_posttool_bash \
  "echo 'KAIZEN_NO_ACTION [docs-only]: test'" \
  "KAIZEN_NO_ACTION [docs-only]: test"
STATUS=$(get_gate_status "https://github.com/test/repo/pull/6")
assert_eq "clears cross-branch gate (kaizen #492)" "kaizen_done" "$STATUS"

# Test 7: ignores failed commands (non-zero exit)
setup
create_pr_kaizen_state "https://github.com/test/repo/pull/7"
run_posttool_bash \
  "echo 'KAIZEN_NO_ACTION [docs-only]: test'" \
  "KAIZEN_NO_ACTION [docs-only]: test" \
  "1"
STATUS=$(get_gate_status "https://github.com/test/repo/pull/7")
assert_eq "ignores failed commands" "needs_pr_kaizen" "$STATUS"

# Test 8: preserves PR_URL and BRANCH when clearing
setup
create_pr_kaizen_state "https://github.com/test/repo/pull/8" "feature-branch"
run_posttool_bash \
  "echo 'KAIZEN_NO_ACTION [docs-only]: test'" \
  "KAIZEN_NO_ACTION [docs-only]: test"
FILENAME="pr-kaizen-test_repo_8"
PR_URL=$(grep '^PR_URL=' "$STATE_DIR/$FILENAME" 2>/dev/null | cut -d= -f2-)
BRANCH=$(grep '^BRANCH=' "$STATE_DIR/$FILENAME" 2>/dev/null | cut -d= -f2-)
assert_eq "preserves PR_URL" "https://github.com/test/repo/pull/8" "$PR_URL"
assert_eq "preserves BRANCH" "feature-branch" "$BRANCH"

print_results
