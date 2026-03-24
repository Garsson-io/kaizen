#!/bin/bash
# Shared test helpers for hook tests.
# Source from test files: source "$(dirname "$0")/test-helpers.sh"

# Inline pr_url_to_state_key — the only function test helpers need from the
# deleted state-utils.sh.  All state management now lives in TypeScript.
pr_url_to_state_key() {
  local url="$1"
  echo "$url" | sed 's|https://github\.com/||;s|/pull/|_|;s|/|_|g'
}

# Portable repo root — use git instead of fragile ../../../ counting
# Technique: portable path resolution (works from any directory depth)
REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel 2>/dev/null)"

# Skip-with-reason: skip a test file if a required file doesn't exist
# Usage: require_file "$SCRIPT_PATH" "worktree-du.sh" || exit 0
require_file() {
  local path="$1"
  local label="${2:-$1}"
  if [ ! -f "$path" ]; then
    echo "SKIP: $label not found at $path (not part of this repo)"
    echo "Results: 0 passed, 0 failed"
    exit 0
  fi
}

PASS=0
FAIL=0
FAILED_NAMES=()

assert_eq() {
  local test_name="$1"
  local expected="$2"
  local actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  PASS: $test_name"
    ((PASS++))
  else
    echo "  FAIL: $test_name"
    echo "    expected: '$expected'"
    echo "    actual:   '$actual'"
    FAILED_NAMES+=("$test_name")
    ((FAIL++))
  fi
}

assert_contains() {
  local test_name="$1"
  local needle="$2"
  local haystack="$3"
  if echo "$haystack" | grep -q "$needle"; then
    echo "  PASS: $test_name"
    ((PASS++))
  else
    echo "  FAIL: $test_name"
    echo "    expected to contain: '$needle'"
    echo "    actual: '$haystack'"
    FAILED_NAMES+=("$test_name")
    ((FAIL++))
  fi
}

assert_not_contains() {
  local test_name="$1"
  local needle="$2"
  local haystack="$3"
  if ! echo "$haystack" | grep -q "$needle"; then
    echo "  PASS: $test_name"
    ((PASS++))
  else
    echo "  FAIL: $test_name"
    echo "    expected NOT to contain: '$needle'"
    FAILED_NAMES+=("$test_name")
    ((FAIL++))
  fi
}

# Assert a function returns success (exit 0)
assert_ok() {
  local test_name="$1"
  shift
  if "$@" 2>/dev/null; then
    echo "  PASS: $test_name"
    ((PASS++))
  else
    echo "  FAIL: $test_name"
    echo "    expected success, got failure"
    FAILED_NAMES+=("$test_name")
    ((FAIL++))
  fi
}

# Assert a function returns failure (non-zero exit)
assert_fails() {
  local test_name="$1"
  shift
  if "$@" 2>/dev/null; then
    echo "  FAIL: $test_name"
    echo "    expected failure, got success"
    FAILED_NAMES+=("$test_name")
    ((FAIL++))
  else
    echo "  PASS: $test_name"
    ((PASS++))
  fi
}

# Create a temp directory for mock commands. Sets MOCK_DIR.
# Caller must set trap: trap 'rm -rf "$MOCK_DIR"' EXIT
setup_mock_dir() {
  MOCK_DIR=$(mktemp -d)
}

# Run a hook script with a simulated PreToolUse JSON input.
# Usage: OUTPUT=$(run_hook "$HOOK" "gh pr merge 42")
# Captures stdout only (stderr suppressed). Use run_hook_stderr for stderr.
run_hook() {
  local hook="$1"
  local command="$2"
  local input
  input=$(jq -n --arg cmd "$command" '{"tool_input":{"command":$cmd}}')
  echo "$input" | PATH="$MOCK_DIR:$PATH" bash "$hook" 2>/dev/null
}

# Run a hook and capture stderr only (stdout suppressed).
run_hook_stderr() {
  local hook="$1"
  local command="$2"
  local input
  input=$(jq -n --arg cmd "$command" '{"tool_input":{"command":$cmd}}')
  echo "$input" | PATH="$MOCK_DIR:$PATH" bash "$hook" 2>&1 1>/dev/null
}

# Create mock gh and git commands in MOCK_DIR.
# Usage: setup_gh_git_mocks "file1.ts\nfile2.ts" "file3.ts\nfile4.ts"
#   $1 = files returned by gh pr diff --name-only
#   $2 = files returned by git diff --name-only
setup_gh_git_mocks() {
  local gh_files="$1"
  local git_files="$2"

  cat > "$MOCK_DIR/gh" << MOCK
#!/bin/bash
if echo "\$@" | grep -q "pr diff"; then
  printf '%b\n' "$gh_files"
  exit 0
fi
if echo "\$@" | grep -q "pr view"; then
  # Return empty body by default
  echo ""
  exit 0
fi
exit 1
MOCK
  chmod +x "$MOCK_DIR/gh"

  cat > "$MOCK_DIR/git" << MOCK
#!/bin/bash
if echo "\$@" | grep -q "remote get-url"; then
  echo "https://github.com/Garsson-io/kaizen.git"
  exit 0
fi
if echo "\$@" | grep -q "diff --name-only"; then
  printf '%b\n' "$git_files"
  exit 0
fi
if echo "\$@" | grep -q "status --porcelain"; then
  exit 0
fi
/usr/bin/git "\$@"
MOCK
  chmod +x "$MOCK_DIR/git"
}

# Create a mock git that returns specific status --porcelain output.
# Usage: setup_git_status_mock " M src/dirty.ts"
setup_git_status_mock() {
  local status_output="$1"
  cat > "$MOCK_DIR/git" << MOCK
#!/bin/bash
if echo "\$@" | grep -q "status --porcelain"; then
  printf '%s' "$status_output"
  exit 0
fi
/usr/bin/git "\$@"
MOCK
  chmod +x "$MOCK_DIR/git"
}

# PR review state test environment
# Creates STATE_DIR, mock gh (returns OPEN), exports PATH.
# Call cleanup_test_env in a trap or at end of test.
setup_test_env() {
  TEST_STATE_DIR="/tmp/.pr-review-state-test-$$"
  rm -rf "$TEST_STATE_DIR"
  mkdir -p "$TEST_STATE_DIR"
  export STATE_DIR="$TEST_STATE_DIR"
  export DEBUG_LOG="/dev/null"

  # Isolate audit log from repo (kaizen #429, #438)
  # Set AUDIT_DIR so both
  # bash hooks and TS hooks write to the temp dir, not the repo.
  TEST_AUDIT_DIR="/tmp/.kaizen-audit-test-$$"
  rm -rf "$TEST_AUDIT_DIR"
  mkdir -p "$TEST_AUDIT_DIR"
  export AUDIT_DIR="$TEST_AUDIT_DIR"
  export AUDIT_LOG="$TEST_AUDIT_DIR/no-action.log"

  TEST_MOCK_DIR=$(mktemp -d)
  cat > "$TEST_MOCK_DIR/gh" << 'MOCK_EOF'
#!/bin/bash
echo "OPEN"
exit 0
MOCK_EOF
  chmod +x "$TEST_MOCK_DIR/gh"
  export PATH="$TEST_MOCK_DIR:$PATH"
}

# Reset state between tests (equivalent to setup() in individual files)
reset_state() {
  rm -rf "$STATE_DIR"
  mkdir -p "$STATE_DIR"
}

# Cleanup everything created by setup_test_env
cleanup_test_env() {
  rm -rf "$TEST_STATE_DIR" "$TEST_MOCK_DIR" "$TEST_AUDIT_DIR"
}

# Create PR review state file with mandatory BRANCH field
# Usage: create_state "https://github.com/owner/repo/pull/1" [round] [status] [branch]
create_state() {
  local pr_url="$1"
  local round="${2:-1}"
  local status="${3:-needs_review}"
  local branch="${4:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)}"
  local filename
  filename=$(pr_url_to_state_key "$pr_url")
  printf 'PR_URL=%s\nROUND=%s\nSTATUS=%s\nBRANCH=%s\n' \
    "$pr_url" "$round" "$status" "$branch" > "$STATE_DIR/$filename"
}

# Create post-merge workflow state file
# Usage: create_post_merge_state "https://github.com/owner/repo/pull/1" [status] [branch]
create_post_merge_state() {
  local pr_url="$1"
  local status="${2:-needs_post_merge}"
  local branch="${3:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)}"
  local filename
  filename="post-merge-$(pr_url_to_state_key "$pr_url")"
  printf 'PR_URL=%s\nSTATUS=%s\nBRANCH=%s\n' \
    "$pr_url" "$status" "$branch" > "$STATE_DIR/$filename"
}

# Decision extractors
is_denied() {
  echo "$1" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null 2>&1
}

is_blocked() {
  echo "$1" | jq -e '.decision == "block"' >/dev/null 2>&1
}

# Cross-platform file backdating
# Usage: backdate_file "path/to/file" [hours_ago]
backdate_file() {
  local file="$1"
  local hours="${2:-3}"
  touch -d "$hours hours ago" "$file" 2>/dev/null ||
    touch -t "$(date -d "$hours hours ago" +%Y%m%d%H%M.%S 2>/dev/null ||
      date -v-${hours}H +%Y%m%d%H%M.%S)" "$file" 2>/dev/null
}

# Create a default "OPEN" gh mock in a specified directory.
# Useful for integration tests that manage their own mock dirs.
# Usage: setup_default_gh_mock "/path/to/mock/dir"
setup_default_gh_mock() {
  local mock_dir="$1"
  mkdir -p "$mock_dir"
  cat > "$mock_dir/gh" << 'MOCK_EOF'
#!/bin/bash
echo "OPEN"
exit 0
MOCK_EOF
  chmod +x "$mock_dir/gh"
}

# Create a temp kaizen.config.json for hooks that use read-config.sh.
# Sets MOCK_CONFIG_DIR. Pass extra jq fields to customize.
# Usage: setup_mock_config '{"host":{"caseCli":"/path/to/cli"}}'
# Cleanup: rm -rf "$MOCK_CONFIG_DIR"
setup_mock_config() {
  local extra="${1:-"{}"}"
  MOCK_CONFIG_DIR=$(mktemp -d)
  # Merge defaults with caller's overrides
  jq -n --argjson extra "$extra" '{
    "kaizen": { "repo": "Garsson-io/kaizen" },
    "host": { "name": "test", "repo": "test/test" }
  } * $extra' > "$MOCK_CONFIG_DIR/kaizen.config.json"
}

# Create a mock case CLI script that responds to case-by-branch.
# Usage: setup_mock_case_cli "found"   → returns JSON case record
#        setup_mock_case_cli "empty"   → returns empty (no case)
#        setup_mock_case_cli "error"   → exits non-zero
# Sets MOCK_CASE_CLI path. Cleanup: rm -rf "$(dirname "$MOCK_CASE_CLI")"
setup_mock_case_cli() {
  local mode="${1:-empty}"
  local dir
  dir=$(mktemp -d)
  MOCK_CASE_CLI="$dir/mock-case-cli"

  case "$mode" in
    found)
      cat > "$MOCK_CASE_CLI" << 'MOCK'
#!/bin/bash
if [ "$1" = "case-by-branch" ]; then
  echo '{"id": 1, "branch": "'"$2"'", "status": "ACTIVE"}'
  exit 0
fi
exit 1
MOCK
      ;;
    empty)
      cat > "$MOCK_CASE_CLI" << 'MOCK'
#!/bin/bash
if [ "$1" = "case-by-branch" ]; then
  echo ""
  exit 0
fi
exit 1
MOCK
      ;;
    error)
      cat > "$MOCK_CASE_CLI" << 'MOCK'
#!/bin/bash
exit 1
MOCK
      ;;
  esac
  chmod +x "$MOCK_CASE_CLI"
}

# Guard for tests that require a worktree environment.
# Usage: if ! require_worktree; then skip_pass N; continue/return; fi
# Returns 0 if in worktree, 1 if in main checkout (prints SKIP message).
require_worktree() {
  local git_dir git_common
  git_dir=$(git rev-parse --git-dir 2>/dev/null)
  git_common=$(git rev-parse --git-common-dir 2>/dev/null)
  if [ -z "$git_dir" ] || [ -z "$git_common" ] || [ "$git_dir" = "$git_common" ]; then
    echo "  SKIP: running in main checkout, can't test worktree behavior"
    return 1
  fi
  return 0
}

# Pad PASS count when skipping multiple assertions.
# Usage: skip_pass 3  → adds 3 to PASS counter
skip_pass() {
  local n="${1:-1}"
  for ((i = 0; i < n; i++)); do ((PASS++)); done
}

# Print final results and exit with appropriate code
print_results() {
  echo ""
  echo "================================"
  echo "Results: $PASS passed, $FAIL failed"
  if [ "$FAIL" -gt 0 ]; then
    echo "FAILED TESTS:"
    for name in "${FAILED_NAMES[@]}"; do
      echo "  - $name"
    done
    exit 1
  fi
  echo "All tests passed."
}
