#!/bin/bash
# Tests for kaizen-block-self-plugin-enable.sh (kaizen #1061, rescoped per #1063)
#
# INVARIANT UNDER TEST: `git commit` is blocked only when BOTH
# enabledPlugins["kaizen@kaizen"]=true AND a hooks block are present in
# .claude/settings.json. Either alone passes (activation switch vs
# direct registration — both valid in isolation; combined is the
# dual-load footgun).

source "$(dirname "$0")/test-helpers.sh"

HOOK="$(cd "$(dirname "$0")/.." && pwd)/kaizen-block-self-plugin-enable.sh"

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

REPO_DIR=""
cleanup() { [ -n "$REPO_DIR" ] && [ -d "$REPO_DIR" ] && rm -rf "$REPO_DIR"; }
trap cleanup EXIT

run_case() {
  local desc="$1"
  local content="$2"
  local expect="$3"  # "block" or "pass"
  local cmd="${4:-git commit -m hi}"

  REPO_DIR=$(make_repo_with_settings "$content")
  OUTPUT=$(cd "$REPO_DIR" && echo "{\"tool_input\":{\"command\":\"$cmd\"}}" | bash "$HOOK" 2>/dev/null)
  if [ "$expect" = "block" ]; then
    if is_denied "$OUTPUT"; then
      echo "  PASS: $desc — blocked as expected"
      ((PASS++))
    else
      echo "  FAIL: $desc — expected block, got: ${OUTPUT:-<empty>}"
      ((FAIL++))
    fi
  else
    if is_denied "$OUTPUT"; then
      echo "  FAIL: $desc — expected pass, got block: $OUTPUT"
      ((FAIL++))
    else
      echo "  PASS: $desc — passed"
      ((PASS++))
    fi
  fi
  rm -rf "$REPO_DIR"; REPO_DIR=""
}

echo "=== DUAL-LOAD (enabledPlugins + hooks) → BLOCKED ==="
run_case "both present" \
  '{"enabledPlugins":{"kaizen@kaizen":true},"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"./foo.sh"}]}]}}' \
  block

echo ""
echo "=== enabledPlugins ONLY (no hooks) → PASS (this is the #1063 target state) ==="
run_case "enabledPlugins only, no hooks block" \
  '{"enabledPlugins":{"kaizen@kaizen":true}}' \
  pass

echo ""
echo "=== enabledPlugins + empty hooks block → PASS ==="
run_case "enabledPlugins with empty hooks" \
  '{"enabledPlugins":{"kaizen@kaizen":true},"hooks":{}}' \
  pass

echo ""
echo "=== hooks ONLY (no enabledPlugins) → PASS (valid direct-registration for non-kaizen hooks) ==="
run_case "hooks only" \
  '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"./foo.sh"}]}]}}' \
  pass

echo ""
echo "=== other plugin enabled + kaizen hooks → PASS (not kaizen@kaizen) ==="
run_case "different plugin + hooks" \
  '{"enabledPlugins":{"other@x":true},"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"./foo.sh"}]}]}}' \
  pass

echo ""
echo "=== non-commit git command ignored ==="
run_case "git status" \
  '{"enabledPlugins":{"kaizen@kaizen":true},"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"./foo.sh"}]}]}}' \
  pass \
  "git status"

echo ""
echo "=== echo 'git commit' false-positive guard ==="
run_case "echo mentioning git commit" \
  '{"enabledPlugins":{"kaizen@kaizen":true},"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"./foo.sh"}]}]}}' \
  pass \
  "echo not a git commit"

echo ""
echo "Results: $PASS passed, $FAIL failed"
exit $FAIL
