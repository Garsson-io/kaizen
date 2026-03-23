#!/bin/bash
# Tests for kaizen-lint-kernel-paths.sh hook (kaizen #685)
source "$(dirname "$0")/test-helpers.sh"

HOOK="$(cd "$(dirname "$0")/.." && pwd)/kaizen-lint-kernel-paths.sh"

# Helper: run the hook with a Write tool_input
run_write_hook() {
  local file_path="$1"
  local content="$2"
  local input
  input=$(jq -n --arg fp "$file_path" --arg c "$content" \
    '{"tool_input":{"file_path":$fp,"content":$c}}')
  echo "$input" | bash "$HOOK" 2>/dev/null
}

# Helper: run the hook with an Edit tool_input
run_edit_hook() {
  local file_path="$1"
  local new_string="$2"
  local input
  input=$(jq -n --arg fp "$file_path" --arg ns "$new_string" \
    '{"tool_input":{"file_path":$fp,"old_string":"old","new_string":$ns}}')
  echo "$input" | bash "$HOOK" 2>/dev/null
}

echo "Testing kaizen-lint-kernel-paths.sh"
echo ""

echo "=== Non-test files pass through ==="

# Test 1: Non-test file is allowed
echo "1. Non-test .ts file is allowed"
OUTPUT=$(run_write_hook "src/index.ts" "import fs from 'fs'; fs.mkdirSync('/proc/test');")
assert_eq "non-test file allowed" "" "$OUTPUT"

# Test 2: Non-test .js file is allowed
echo "2. Non-test .js file is allowed"
OUTPUT=$(run_write_hook "src/utils.js" "const p = '/proc/cpuinfo';")
assert_eq "non-test js file allowed" "" "$OUTPUT"

echo ""
echo "=== /proc/ detection ==="

# Test 3: /proc/ in test file is blocked
echo "3. /proc/ in test file is blocked"
OUTPUT=$(run_write_hook "src/foo.test.ts" "mkdirSync('/proc/invalid/path', { recursive: true });")
assert_contains "blocks /proc/" "deny" "$OUTPUT"
assert_contains "mentions /proc/" "/proc/" "$OUTPUT"

# Test 4: /proc/ in spec file is blocked
echo "4. /proc/ in spec file is blocked"
OUTPUT=$(run_write_hook "src/bar.spec.tsx" "const path = '/proc/cpuinfo';")
assert_contains "blocks /proc/ in spec" "deny" "$OUTPUT"

echo ""
echo "=== /sys/ detection ==="

# Test 5: /sys/ in test file is blocked
echo "5. /sys/ in test file is blocked"
OUTPUT=$(run_write_hook "src/foo.test.ts" "readFileSync('/sys/class/net/eth0/address');")
assert_contains "blocks /sys/" "deny" "$OUTPUT"
assert_contains "mentions /sys/" "/sys/" "$OUTPUT"

echo ""
echo "=== /dev/ detection ==="

# Test 6: /dev/sda in test file is blocked
echo "6. /dev/sda in test file is blocked"
OUTPUT=$(run_write_hook "src/foo.test.ts" "openSync('/dev/sda', 'r');")
assert_contains "blocks /dev/sda" "deny" "$OUTPUT"

# Test 7: /dev/null is allowed
echo "7. /dev/null is allowed (safe)"
OUTPUT=$(run_write_hook "src/foo.test.ts" "const sink = '/dev/null';")
assert_eq "allows /dev/null" "" "$OUTPUT"

# Test 8: /dev/null alongside other /dev/ is blocked
echo "8. /dev/null with other /dev/ paths is blocked"
OUTPUT=$(run_write_hook "src/foo.test.ts" "const a = '/dev/null'; const b = '/dev/sda';")
assert_contains "blocks mixed /dev/" "deny" "$OUTPUT"

echo ""
echo "=== process.kill / process.exit detection ==="

# Test 9: process.kill in test file is blocked
echo "9. process.kill in test file is blocked"
OUTPUT=$(run_write_hook "src/foo.test.ts" "process.kill(pid, 'SIGTERM');")
assert_contains "blocks process.kill" "deny" "$OUTPUT"
assert_contains "mentions process.kill" "process.kill" "$OUTPUT"

# Test 10: process.exit in test file is blocked
echo "10. process.exit in test file is blocked"
OUTPUT=$(run_write_hook "src/foo.test.ts" "process.exit(1);")
assert_contains "blocks process.exit" "deny" "$OUTPUT"
assert_contains "mentions process.exit" "process.exit" "$OUTPUT"

echo ""
echo "=== Clean test files pass through ==="

# Test 11: Normal test file content is allowed
echo "11. Normal test content is allowed"
OUTPUT=$(run_write_hook "src/foo.test.ts" "describe('foo', () => { it('works', () => { expect(1).toBe(1); }); });")
assert_eq "clean test allowed" "" "$OUTPUT"

# Test 12: Edit tool also works
echo "12. Edit tool with /proc/ is also blocked"
OUTPUT=$(run_edit_hook "src/foo.test.ts" "mkdirSync('/proc/invalid');")
assert_contains "edit tool blocked" "deny" "$OUTPUT"

echo ""
echo "=== Multiple violations ==="

# Test 13: Multiple violations reported together
echo "13. Multiple violations in one file"
CONTENT="import fs from 'fs';
fs.mkdirSync('/proc/test');
fs.readFileSync('/sys/class/net');
process.exit(1);"
OUTPUT=$(run_write_hook "src/multi.test.ts" "$CONTENT")
assert_contains "mentions /proc/" "/proc/" "$OUTPUT"
assert_contains "mentions /sys/" "/sys/" "$OUTPUT"
assert_contains "mentions process.exit" "process.exit" "$OUTPUT"

echo ""
echo "=== Exit code ==="

# Test 14: Always exits 0 (even on deny — JSON output handles blocking)
echo "14. Exit code is always 0"
INPUT=$(jq -n '{"tool_input":{"file_path":"src/x.test.ts","content":"process.exit(1);"}}')
echo "$INPUT" | bash "$HOOK" >/dev/null 2>&1
assert_eq "exit code 0" "0" "$?"

# Test 15: .test.js files also checked
echo "15. .test.js files are checked"
OUTPUT=$(run_write_hook "src/foo.test.js" "const p = '/proc/stat';")
assert_contains "blocks .test.js" "deny" "$OUTPUT"

# Test 16: .spec.jsx files also checked
echo "16. .spec.jsx files are checked"
OUTPUT=$(run_write_hook "src/foo.spec.jsx" "process.kill(1);")
assert_contains "blocks .spec.jsx" "deny" "$OUTPUT"

print_results
