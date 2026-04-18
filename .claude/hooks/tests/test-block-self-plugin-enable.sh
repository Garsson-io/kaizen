#!/bin/bash
# Tests for kaizen-block-self-plugin-enable.sh (kaizen #1061)
#
# INVARIANT UNDER TEST: `git commit` is blocked when .claude/settings.json
# (staged or working-tree) contains enabledPlugins["kaizen@kaizen"] = true.
# Non-commit commands pass. Commits in repos without the footgun pass.

source "$(dirname "$0")/test-helpers.sh"

HOOK="$(cd "$(dirname "$0")/.." && pwd)/kaizen-block-self-plugin-enable.sh"

# Set up a temporary git repo with a staged settings.json and cd into it.
# Returns the repo path via echo.
make_repo_with_settings() {
  local content="$1"
  local dir
  dir=$(mktemp -d)
  (
    cd "$dir" || exit 1
    git init -q
    git config user.email test@test
    git config user.name test
    mkdir -p .claude
    printf '%s' "$content" > .claude/settings.json
    git add .claude/settings.json
  )
  echo "$dir"
}

cleanup() {
  [ -n "$REPO_DIR" ] && [ -d "$REPO_DIR" ] && rm -rf "$REPO_DIR"
}
trap cleanup EXIT

echo "=== git commit BLOCKED when enabledPlugins[kaizen@kaizen]=true staged ==="
REPO_DIR=$(make_repo_with_settings '{"enabledPlugins":{"kaizen@kaizen":true},"hooks":{}}')
OUTPUT=$(cd "$REPO_DIR" && echo '{"tool_input":{"command":"git commit -m hi"}}' | bash "$HOOK" 2>/dev/null)
if is_denied "$OUTPUT"; then
  echo "  PASS: blocked as expected"
  ((PASS++))
else
  echo "  FAIL: not blocked (output: $OUTPUT)"
  ((FAIL++))
fi
rm -rf "$REPO_DIR"; REPO_DIR=""

echo ""
echo "=== git commit ALLOWED when enabledPlugins absent ==="
REPO_DIR=$(make_repo_with_settings '{"hooks":{}}')
OUTPUT=$(cd "$REPO_DIR" && echo '{"tool_input":{"command":"git commit -m hi"}}' | bash "$HOOK" 2>/dev/null)
if is_denied "$OUTPUT"; then
  echo "  FAIL: blocked when it should have passed (output: $OUTPUT)"
  ((FAIL++))
else
  echo "  PASS: passed"
  ((PASS++))
fi
rm -rf "$REPO_DIR"; REPO_DIR=""

echo ""
echo "=== git commit ALLOWED when enabledPlugins present but other plugin ==="
REPO_DIR=$(make_repo_with_settings '{"enabledPlugins":{"other@x":true},"hooks":{}}')
OUTPUT=$(cd "$REPO_DIR" && echo '{"tool_input":{"command":"git commit -m hi"}}' | bash "$HOOK" 2>/dev/null)
if is_denied "$OUTPUT"; then
  echo "  FAIL: blocked when it should have passed (output: $OUTPUT)"
  ((FAIL++))
else
  echo "  PASS: passed — only kaizen@kaizen gets blocked"
  ((PASS++))
fi
rm -rf "$REPO_DIR"; REPO_DIR=""

echo ""
echo "=== git status ALLOWED (not a commit) ==="
REPO_DIR=$(make_repo_with_settings '{"enabledPlugins":{"kaizen@kaizen":true},"hooks":{}}')
OUTPUT=$(cd "$REPO_DIR" && echo '{"tool_input":{"command":"git status"}}' | bash "$HOOK" 2>/dev/null)
if is_denied "$OUTPUT"; then
  echo "  FAIL: git status blocked (output: $OUTPUT)"
  ((FAIL++))
else
  echo "  PASS: git status passed"
  ((PASS++))
fi
rm -rf "$REPO_DIR"; REPO_DIR=""

echo ""
echo "=== echo 'git commit' ALLOWED (not actually a git command) ==="
# False-positive guard: heredoc body or echo'd string mentioning "git commit"
# should NOT trigger the block. The strip_heredoc_body lib helps with heredocs;
# a bare echo would still match on current regex — documenting known limitation.
REPO_DIR=$(make_repo_with_settings '{"enabledPlugins":{"kaizen@kaizen":true},"hooks":{}}')
OUTPUT=$(cd "$REPO_DIR" && echo '{"tool_input":{"command":"echo not a git commit"}}' | bash "$HOOK" 2>/dev/null)
if is_denied "$OUTPUT"; then
  echo "  FAIL: echo blocked (false positive — detection regex too loose)"
  ((FAIL++))
else
  echo "  PASS: echo passed"
  ((PASS++))
fi
rm -rf "$REPO_DIR"; REPO_DIR=""

echo ""
echo "Results: $PASS passed, $FAIL failed"
exit $FAIL
