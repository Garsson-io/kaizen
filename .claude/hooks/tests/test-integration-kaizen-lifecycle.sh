#!/bin/bash
# test-integration-kaizen-lifecycle.sh — End-to-end kaizen reflection lifecycle
#
# Tests the full interaction between four hooks:
#   kaizen-reflect.sh (PostToolUse) → sets needs_pr_kaizen gate
#   kaizen-enforce-pr-reflect.sh (PreToolUse) → blocks non-kaizen commands
#   kaizen-enforce-reflect-stop.sh (Stop) → blocks session stop
#   kaizen-pr-reflect-clear.sh (PostToolUse) → clears gate on valid KAIZEN_IMPEDIMENTS
#
# INVARIANT: The kaizen reflection lifecycle transitions correctly across
# all four hooks. An agent cannot escape kaizen reflection by either:
#   1. Running non-kaizen commands (blocked by PreToolUse gate)
#   2. Stopping the session (blocked by Stop hook)
#
# This test directly addresses kaizen #317 (exit-before-enforcement anti-pattern).

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOKS_DIR="$(dirname "$SCRIPT_DIR")"
source "$SCRIPT_DIR/harness.sh"

# Isolated state and audit directories
STATE_DIR="$HARNESS_TEMP/pr-review-state"
AUDIT_DIR="$HARNESS_TEMP/audit"
mkdir -p "$STATE_DIR" "$AUDIT_DIR"
export STATE_DIR
export AUDIT_DIR
export DEBUG_LOG="$HARNESS_TEMP/debug.log"

KAIZEN_REFLECT="$HOOKS_DIR/kaizen-reflect.sh"
ENFORCE_PR_KAIZEN="$HOOKS_DIR/kaizen-enforce-pr-reflect.sh"
ENFORCE_KAIZEN_STOP="$HOOKS_DIR/kaizen-enforce-reflect-stop.sh"
PR_KAIZEN_CLEAR="$HOOKS_DIR/kaizen-pr-reflect-clear.sh"

# Mock gh to return OPEN for pr view
INTEG_MOCK_DIR="$HARNESS_TEMP/mock-bin"
setup_default_gh_mock "$INTEG_MOCK_DIR"

HOOK_ENV_VARS=$(printf 'STATE_DIR=%s\nAUDIT_DIR=%s\nPATH=%s\n' "$STATE_DIR" "$AUDIT_DIR" "$INTEG_MOCK_DIR:$PATH")

PR_URL="https://github.com/Garsson-io/kaizen/pull/99"

# Hook runners using the harness
run_pre_kaizen() {
  local command="$1"
  local input
  input=$(build_pre_tool_use_input "Bash" "$(jq -n --arg c "$command" '{command: $c}')")
  run_single_hook "$ENFORCE_PR_KAIZEN" "$input" 10 "$HOOK_ENV_VARS"
}

run_post_reflect() {
  local command="$1"
  local stdout="$2"
  local exit_code="${3:-0}"
  local input
  input=$(build_post_tool_use_input "Bash" \
    "$(jq -n --arg c "$command" '{command: $c}')" \
    "$stdout" "" "$exit_code")
  run_single_hook "$KAIZEN_REFLECT" "$input" 10 "$HOOK_ENV_VARS"
}

run_post_clear() {
  local command="$1"
  local stdout="$2"
  local exit_code="${3:-0}"
  local input
  input=$(build_post_tool_use_input "Bash" \
    "$(jq -n --arg c "$command" '{command: $c}')" \
    "$stdout" "" "$exit_code")
  run_single_hook "$PR_KAIZEN_CLEAR" "$input" 10 "$HOOK_ENV_VARS"
}

run_stop() {
  local input
  input=$(build_stop_input "task_complete")
  run_single_hook "$ENFORCE_KAIZEN_STOP" "$input" 10 "$HOOK_ENV_VARS"
}

# Helpers
has_kaizen_state() {
  local count
  count=$(find "$STATE_DIR" -name "pr-kaizen-*" 2>/dev/null | wc -l)
  [ "$count" -gt 0 ]
}

reset() {
  rm -rf "$STATE_DIR"/*
}

# ================================================================
# Phase 1: Before PR create — no gates active
# ================================================================
echo "=== Phase 1: Before PR create — no gates ==="

reset

run_pre_kaizen "npm test"
assert_eq "npm test allowed (no gate)" "" "$HOOK_STDOUT"

run_pre_kaizen "git commit -m 'fix'"
assert_eq "git commit allowed (no gate)" "" "$HOOK_STDOUT"

run_stop
assert_eq "stop allowed (no gate)" "" "$HOOK_STDOUT"

# ================================================================
# Phase 2: gh pr create → kaizen-reflect sets gate
# ================================================================
echo ""
echo "=== Phase 2: gh pr create → gate activates ==="

run_post_reflect \
  "gh pr create --title 'test' --body 'body'" \
  "$PR_URL"

assert_contains "reflect outputs kaizen prompt" "KAIZEN" "$HOOK_STDOUT"

if has_kaizen_state; then
  echo "  PASS: kaizen state file created"
  ((PASS++))
else
  echo "  FAIL: no kaizen state file created"
  ((FAIL++))
fi

# ================================================================
# Phase 3: Gate active — commands blocked, stop blocked
# ================================================================
echo ""
echo "=== Phase 3: Gate active — commands blocked ==="

# Non-kaizen command should be blocked
run_pre_kaizen "npm test"
if validate_deny_output "$HOOK_STDOUT"; then
  echo "  PASS: npm test blocked (gate active)"
  ((PASS++))
else
  echo "  FAIL: npm test NOT blocked (gate active)"
  echo "    stdout: $HOOK_STDOUT"
  ((FAIL++))
fi

run_pre_kaizen "git commit -m 'next fix'"
if validate_deny_output "$HOOK_STDOUT"; then
  echo "  PASS: git commit blocked (gate active)"
  ((PASS++))
else
  echo "  FAIL: git commit NOT blocked"
  ((FAIL++))
fi

# Stop should also be blocked (kaizen #312, #317)
run_stop
if echo "$HOOK_STDOUT" | jq -e '.decision == "block"' >/dev/null 2>&1; then
  echo "  PASS: stop blocked (gate active — exit-before-enforcement prevented)"
  ((PASS++))
else
  echo "  FAIL: stop NOT blocked — exit-before-enforcement vulnerability!"
  echo "    stdout: $HOOK_STDOUT"
  ((FAIL++))
fi
assert_contains "stop mentions PR" "pull/99" "$HOOK_STDOUT"

# ================================================================
# Phase 4: Allowed commands pass through during gate
# ================================================================
echo ""
echo "=== Phase 4: Kaizen-allowed commands pass through ==="

run_pre_kaizen "gh issue create --title 'fix: something' --body 'body'"
assert_eq "gh issue create allowed during gate" "" "$HOOK_STDOUT"

run_pre_kaizen "gh issue list --repo Garsson-io/kaizen"
assert_eq "gh issue list allowed during gate" "" "$HOOK_STDOUT"

run_pre_kaizen "gh pr diff 99"
assert_eq "gh pr diff allowed during gate" "" "$HOOK_STDOUT"

run_pre_kaizen "git diff HEAD~1"
assert_eq "git diff allowed during gate" "" "$HOOK_STDOUT"

run_pre_kaizen "git log --oneline -5"
assert_eq "git log allowed during gate" "" "$HOOK_STDOUT"

# ================================================================
# Phase 5: Valid KAIZEN_IMPEDIMENTS clears the gate
# ================================================================
echo ""
echo "=== Phase 5: KAIZEN_IMPEDIMENTS clears the gate ==="

KAIZEN_OUTPUT='KAIZEN_IMPEDIMENTS:
[{"impediment": "test issue", "disposition": "filed", "ref": "#100"}]'

run_post_clear \
  "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[{\"impediment\": \"test issue\", \"disposition\": \"filed\", \"ref\": \"#100\"}]
IMPEDIMENTS" \
  "$KAIZEN_OUTPUT"

if ! has_kaizen_state; then
  echo "  PASS: kaizen state cleared after valid KAIZEN_IMPEDIMENTS"
  ((PASS++))
else
  echo "  FAIL: kaizen state NOT cleared"
  ((FAIL++))
fi

# ================================================================
# Phase 6: After clearing — commands and stop allowed
# ================================================================
echo ""
echo "=== Phase 6: After clearing — everything allowed ==="

run_pre_kaizen "npm test"
assert_eq "npm test allowed after clearing" "" "$HOOK_STDOUT"

run_pre_kaizen "git commit -m 'next'"
assert_eq "git commit allowed after clearing" "" "$HOOK_STDOUT"

run_stop
assert_eq "stop allowed after clearing" "" "$HOOK_STDOUT"

# ================================================================
# Phase 7: Multiple PRs — partial clearing
# ================================================================
echo ""
echo "=== Phase 7: Multiple PRs — partial clearing ==="

reset

PR_URL_A="https://github.com/Garsson-io/kaizen/pull/10"
PR_URL_B="https://github.com/Garsson-io/kaizen/pull/20"

# Create gates for both PRs
run_post_reflect "gh pr create --title 'A'" "$PR_URL_A"
run_post_reflect "gh pr create --title 'B'" "$PR_URL_B"

STATE_COUNT=$(find "$STATE_DIR" -name "pr-kaizen-*" 2>/dev/null | wc -l | tr -d ' ')
assert_eq "two kaizen state files" "2" "$STATE_COUNT"

# Both PreToolUse gate and Stop should be blocked
run_pre_kaizen "npm test"
if validate_deny_output "$HOOK_STDOUT"; then
  echo "  PASS: blocked with 2 pending gates"
  ((PASS++))
else
  echo "  FAIL: NOT blocked with 2 pending gates"
  ((FAIL++))
fi

run_stop
if echo "$HOOK_STDOUT" | jq -e '.decision == "block"' >/dev/null 2>&1; then
  echo "  PASS: stop blocked with 2 pending gates"
  ((PASS++))
else
  echo "  FAIL: stop NOT blocked with 2 pending gates"
  ((FAIL++))
fi
assert_contains "stop mentions both PRs count" "2 PRs" "$HOOK_STDOUT"

# Clear first PR
CLEAR_OUTPUT_A='KAIZEN_IMPEDIMENTS:
[{"impediment": "issue A", "disposition": "filed", "ref": "#200"}]'

run_post_clear \
  "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[{\"impediment\": \"issue A\", \"disposition\": \"filed\", \"ref\": \"#200\"}]
IMPEDIMENTS" \
  "$CLEAR_OUTPUT_A"

# After clearing one: still blocked (second PR pending)
REMAINING=$(find "$STATE_DIR" -name "pr-kaizen-*" 2>/dev/null | wc -l | tr -d ' ')
assert_eq "one kaizen state remaining" "1" "$REMAINING"

run_pre_kaizen "npm test"
if validate_deny_output "$HOOK_STDOUT"; then
  echo "  PASS: still blocked with 1 pending gate"
  ((PASS++))
else
  echo "  FAIL: NOT blocked with 1 pending gate"
  ((FAIL++))
fi

run_stop
if echo "$HOOK_STDOUT" | jq -e '.decision == "block"' >/dev/null 2>&1; then
  echo "  PASS: stop still blocked with 1 pending gate"
  ((PASS++))
else
  echo "  FAIL: stop NOT blocked with 1 pending gate"
  ((FAIL++))
fi

# Clear second PR
CLEAR_OUTPUT_B='KAIZEN_IMPEDIMENTS:
[{"impediment": "issue B", "disposition": "filed", "ref": "#201"}]'

run_post_clear \
  "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[{\"impediment\": \"issue B\", \"disposition\": \"filed\", \"ref\": \"#201\"}]
IMPEDIMENTS" \
  "$CLEAR_OUTPUT_B"

# After clearing both: everything allowed
REMAINING=$(find "$STATE_DIR" -name "pr-kaizen-*" 2>/dev/null | wc -l | tr -d ' ')
assert_eq "zero kaizen states remaining" "0" "$REMAINING"

run_pre_kaizen "npm test"
assert_eq "npm test allowed after clearing both" "" "$HOOK_STDOUT"

run_stop
assert_eq "stop allowed after clearing both" "" "$HOOK_STDOUT"

# ================================================================
# Phase 8: Failed PR create does NOT set gate
# ================================================================
echo ""
echo "=== Phase 8: Failed PR create does not set gate ==="

reset

run_post_reflect "gh pr create --title 'fail'" "" "1"

if ! has_kaizen_state; then
  echo "  PASS: no state from failed PR create"
  ((PASS++))
else
  echo "  FAIL: state created from failed PR create"
  ((FAIL++))
fi

# ================================================================
# Phase 9: Invalid KAIZEN_IMPEDIMENTS does NOT clear gate
# ================================================================
echo ""
echo "=== Phase 9: Invalid KAIZEN_IMPEDIMENTS does not clear ==="

reset
# Manually create gate state
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
STATE_KEY=$(echo "$PR_URL" | sed 's|https://github\.com/||;s|/pull/|_|;s|/|_|g')
printf 'PR_URL=%s\nSTATUS=%s\nBRANCH=%s\n' \
  "$PR_URL" "needs_pr_kaizen" "$BRANCH" > "$STATE_DIR/pr-kaizen-$STATE_KEY"

# Submit invalid JSON
run_post_clear \
  "echo 'KAIZEN_IMPEDIMENTS: not-json'" \
  "KAIZEN_IMPEDIMENTS: not-json"

if has_kaizen_state; then
  echo "  PASS: gate NOT cleared by invalid JSON"
  ((PASS++))
else
  echo "  FAIL: gate cleared by invalid JSON!"
  ((FAIL++))
fi

# Submit waived disposition (kaizen #198 — should be rejected)
run_post_clear \
  "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[{\"impediment\": \"test\", \"disposition\": \"waived\", \"reason\": \"not important\"}]
IMPEDIMENTS" \
  'KAIZEN_IMPEDIMENTS:
[{"impediment": "test", "disposition": "waived", "reason": "not important"}]'

if has_kaizen_state; then
  echo "  PASS: gate NOT cleared by waived disposition"
  ((PASS++))
else
  echo "  FAIL: gate cleared despite waived disposition!"
  ((FAIL++))
fi
assert_contains "rejection mentions kaizen #198" "198" "$HOOK_STDOUT"

# ================================================================
# Phase 10: Cross-branch isolation
# ================================================================
echo ""
echo "=== Phase 10: Cross-branch isolation ==="

reset
# Create gate on a different branch
printf 'PR_URL=%s\nSTATUS=%s\nBRANCH=%s\n' \
  "$PR_URL" "needs_pr_kaizen" "wt/other-branch" > "$STATE_DIR/pr-kaizen-$STATE_KEY"

# Commands should NOT be blocked (gate is for another branch)
run_pre_kaizen "npm test"
assert_eq "npm test allowed (cross-branch gate)" "" "$HOOK_STDOUT"

# Stop should NOT be blocked
run_stop
assert_eq "stop allowed (cross-branch gate)" "" "$HOOK_STDOUT"

# ================================================================
# Phase 11: KAIZEN_NO_ACTION also clears gate
# ================================================================
echo ""
echo "=== Phase 11: KAIZEN_NO_ACTION clears gate ==="

reset
# Create gate on current branch
printf 'PR_URL=%s\nSTATUS=%s\nBRANCH=%s\n' \
  "$PR_URL" "needs_pr_kaizen" "$BRANCH" > "$STATE_DIR/pr-kaizen-$STATE_KEY"

run_post_clear \
  "echo 'KAIZEN_NO_ACTION [docs-only]: documentation update'" \
  "KAIZEN_NO_ACTION [docs-only]: documentation update"

if ! has_kaizen_state; then
  echo "  PASS: gate cleared by valid KAIZEN_NO_ACTION"
  ((PASS++))
else
  echo "  FAIL: gate NOT cleared by valid KAIZEN_NO_ACTION"
  ((FAIL++))
fi

harness_summary
