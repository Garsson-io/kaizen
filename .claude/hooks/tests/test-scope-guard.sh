#!/bin/bash
# Tests for lib/scope-guard.sh (#758)
#
# INVARIANTS UNDER TEST:
#   1. Clean install → scope-guard is a no-op (exit 0, no output)
#   2. Double-install detected → settings auto-fixed, warning on stderr, exit 0
#      (NEVER blocks — blocking all tools creates an unescapable deadlock)
#   3. After auto-fix → kaizen@kaizen is gone from enabledPlugins
#   4. Retry cap → after 3 failed attempts, warning only, still exit 0

source "$(dirname "$0")/test-helpers.sh"

SCOPE_GUARD="$(dirname "$0")/../lib/scope-guard.sh"

# Isolated temp home so tests never touch the real ~/.claude/settings.json
FAKE_HOME=$(mktemp -d)
FAKE_SETTINGS="$FAKE_HOME/.claude/settings.json"
mkdir -p "$FAKE_HOME/.claude"
trap 'rm -rf "$FAKE_HOME"; rm -f /tmp/.kaizen-scope-guard-fix-attempts' EXIT

# Helper: run scope-guard with a given settings file content
run_scope_guard() {
  local settings_json="$1"
  echo "$settings_json" > "$FAKE_SETTINGS"
  HOME="$FAKE_HOME" bash -c "source '$SCOPE_GUARD'" 2>&1
  echo "EXIT:$?"
}

# Helper: run scope-guard and return exit code only
scope_guard_exit() {
  local settings_json="$1"
  echo "$settings_json" > "$FAKE_SETTINGS"
  HOME="$FAKE_HOME" bash -c "source '$SCOPE_GUARD'" >/dev/null 2>&1
  echo $?
}

echo "=== No double-install → no-op ==="

OUTPUT=$(run_scope_guard '{"enabledPlugins":{"slack@claude-plugins-official":true}}')
assert_eq "clean install: exit 0" "EXIT:0" "$(echo "$OUTPUT" | tail -1)"
assert_not_contains "clean install: no warning" "WARNING" "$OUTPUT"
assert_not_contains "clean install: no blocked message" "BLOCKED" "$OUTPUT"

echo ""
echo "=== No settings file → no-op ==="

rm -f "$FAKE_SETTINGS"
OUTPUT=$(HOME="$FAKE_HOME" bash -c "source '$SCOPE_GUARD'" 2>&1; echo "EXIT:$?")
assert_eq "missing settings: exit 0" "EXIT:0" "$(echo "$OUTPUT" | tail -1)"
echo "$FAKE_SETTINGS" > /dev/null  # restore for next tests

echo ""
echo "=== Double-install → auto-fixed, warning, exit 0 ==="

DOUBLE_INSTALL='{"enabledPlugins":{"slack@claude-plugins-official":true,"kaizen@kaizen":true}}'
rm -f /tmp/.kaizen-scope-guard-fix-attempts

OUTPUT=$(run_scope_guard "$DOUBLE_INSTALL")
assert_eq "double-install: exit 0 (never blocks)" "EXIT:0" "$(echo "$OUTPUT" | tail -1)"
assert_contains "double-install: warning emitted" "WARNING" "$OUTPUT"
assert_not_contains "double-install: no BLOCKED message" "BLOCKED" "$OUTPUT"

echo ""
echo "=== After auto-fix → kaizen@kaizen removed from settings ==="

run_scope_guard "$DOUBLE_INSTALL" >/dev/null 2>&1
REMAINING=$(node -e "
const d = JSON.parse(require('fs').readFileSync('$FAKE_SETTINGS', 'utf8'));
console.log(d.enabledPlugins['kaizen@kaizen'] === undefined ? 'removed' : 'still-present');
" 2>/dev/null)
assert_eq "auto-fix: kaizen@kaizen removed" "removed" "$REMAINING"

echo ""
echo "=== After auto-fix → other enabledPlugins preserved ==="

REMAINING_SLACK=$(node -e "
const d = JSON.parse(require('fs').readFileSync('$FAKE_SETTINGS', 'utf8'));
console.log(d.enabledPlugins['slack@claude-plugins-official'] === true ? 'present' : 'missing');
" 2>/dev/null)
assert_eq "auto-fix: slack plugin preserved" "present" "$REMAINING_SLACK"

echo ""
echo "=== Retry cap: after 3 attempts, still exit 0 (not blocked) ==="

echo "3" > /tmp/.kaizen-scope-guard-fix-attempts
OUTPUT=$(run_scope_guard "$DOUBLE_INSTALL")
assert_eq "retry cap: exit 0" "EXIT:0" "$(echo "$OUTPUT" | tail -1)"
assert_contains "retry cap: warning with manual fix" "WARNING" "$OUTPUT"
assert_not_contains "retry cap: no BLOCKED message" "BLOCKED" "$OUTPUT"
rm -f /tmp/.kaizen-scope-guard-fix-attempts

echo ""
echo "=== Second invocation after successful fix → no-op ==="

# After fix the grep fast-check should find no 'kaizen@kaizen' and return early
FIXED_SETTINGS='{"enabledPlugins":{"slack@claude-plugins-official":true}}'
OUTPUT=$(run_scope_guard "$FIXED_SETTINGS")
assert_eq "post-fix: exit 0" "EXIT:0" "$(echo "$OUTPUT" | tail -1)"
assert_not_contains "post-fix: no warning" "WARNING" "$OUTPUT"

print_results
