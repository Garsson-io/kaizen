#!/bin/bash
# test-validate-hook-integrity.sh — Tests for hook integrity validation
#
# Verifies that validate-hook-integrity.sh correctly:
# - Passes when all hooks are valid
# - Fails when a hook file is missing
# - Fails when a hook has syntax errors
# - Handles both settings.json and plugin.json

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

VALIDATOR="$SCRIPT_DIR/validate-hook-integrity.sh"

# Create isolated temp directory for each test
setup_test_env() {
  local tmpdir
  tmpdir=$(mktemp -d)
  mkdir -p "$tmpdir/.claude" "$tmpdir/.claude-plugin"
  echo "$tmpdir"
}

cleanup_test_env() {
  rm -rf "$1"
}

echo "=== validate-hook-integrity tests ==="

# Test: passes on valid hooks
test_valid_hooks() {
  local env
  env=$(setup_test_env)
  mkdir -p "$env/.claude/hooks"
  echo '#!/bin/bash' > "$env/.claude/hooks/good-hook.sh"
  echo 'echo hello' >> "$env/.claude/hooks/good-hook.sh"

  cat > "$env/.claude/settings.json" <<'JSON'
{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"./.claude/hooks/good-hook.sh"}]}]}}
JSON

  local output
  output=$(bash "$VALIDATOR" "$env" 2>&1)
  local rc=$?
  assert_eq "valid hooks exit 0" "0" "$rc"
  assert_contains "valid hooks reports 0 errors" "$output" "0 errors"
  cleanup_test_env "$env"
}
test_valid_hooks

# Test: fails on missing hook file
test_missing_hook() {
  local env
  env=$(setup_test_env)

  cat > "$env/.claude/settings.json" <<'JSON'
{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"./.claude/hooks/nonexistent.sh"}]}]}}
JSON

  local output
  output=$(bash "$VALIDATOR" "$env" 2>&1)
  local rc=$?
  assert_eq "missing hook exit 1" "1" "$rc"
  assert_contains "missing hook reports error" "$output" "Missing hook file"
  cleanup_test_env "$env"
}
test_missing_hook

# Test: fails on syntax error
test_syntax_error() {
  local env
  env=$(setup_test_env)
  mkdir -p "$env/.claude/hooks"
  cat > "$env/.claude/hooks/bad-hook.sh" <<'BASH'
#!/bin/bash
echo "unclosed quote
BASH

  cat > "$env/.claude/settings.json" <<'JSON'
{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"./.claude/hooks/bad-hook.sh"}]}]}}
JSON

  local output
  output=$(bash "$VALIDATOR" "$env" 2>&1)
  local rc=$?
  assert_eq "syntax error exit 1" "1" "$rc"
  assert_contains "syntax error reports error" "$output" "Syntax error"
  cleanup_test_env "$env"
}
test_syntax_error

# Test: validates plugin.json with CLAUDE_PLUGIN_ROOT paths
test_plugin_json() {
  local env
  env=$(setup_test_env)
  mkdir -p "$env/.claude/hooks"
  echo '#!/bin/bash' > "$env/.claude/hooks/plugin-hook.sh"

  cat > "$env/.claude-plugin/plugin.json" <<'JSON'
{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/.claude/hooks/plugin-hook.sh"}]}]}}
JSON

  local output
  output=$(bash "$VALIDATOR" "$env" 2>&1)
  local rc=$?
  assert_eq "plugin.json valid exit 0" "0" "$rc"
  cleanup_test_env "$env"
}
test_plugin_json

# Test: catches merge conflict markers (bash -n detects these)
test_conflict_markers() {
  local env
  env=$(setup_test_env)
  mkdir -p "$env/.claude/hooks"
  cat > "$env/.claude/hooks/conflicted.sh" <<'BASH'
#!/bin/bash
<<<<<<< HEAD
echo "ours"
=======
echo "theirs"
>>>>>>> branch
BASH

  cat > "$env/.claude/settings.json" <<'JSON'
{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"./.claude/hooks/conflicted.sh"}]}]}}
JSON

  local output
  output=$(bash "$VALIDATOR" "$env" 2>&1)
  local rc=$?
  assert_eq "conflict markers exit 1" "1" "$rc"
  assert_contains "conflict markers reports syntax error" "$output" "Syntax error"
  cleanup_test_env "$env"
}
test_conflict_markers

# Test: handles no settings.json gracefully
test_no_settings() {
  local env
  env=$(setup_test_env)
  # No settings.json or plugin.json created

  local output
  output=$(bash "$VALIDATOR" "$env" 2>&1)
  local rc=$?
  assert_eq "no settings exit 0" "0" "$rc"
  assert_contains "no settings reports 0 checked" "$output" "Checked 0"
  cleanup_test_env "$env"
}
test_no_settings

# Test: passes on real repo hooks
test_real_repo() {
  local repo_root
  repo_root="$(git rev-parse --show-toplevel 2>/dev/null)"
  if [ -z "$repo_root" ]; then
    echo "  SKIP: not in a git repo"
    return 0
  fi

  local output
  output=$(bash "$VALIDATOR" "$repo_root" 2>&1)
  local rc=$?
  assert_eq "real repo hooks valid" "0" "$rc"
}
test_real_repo

print_results
