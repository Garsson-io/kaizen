#!/bin/bash
# Tests for lib/resolve-main-checkout.sh (kaizen #219)
# Verifies dynamic main checkout path resolution.

source "$(dirname "$0")/test-helpers.sh"

HOOK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LIB="$HOOK_DIR/lib/resolve-main-checkout.sh"

echo "=== test-resolve-main-checkout.sh ==="

# Test 1: MAIN_CHECKOUT is set after sourcing
unset MAIN_CHECKOUT
source "$LIB"
assert_eq "MAIN_CHECKOUT is set" "true" "$([ -n "$MAIN_CHECKOUT" ] && echo true || echo false)"

# Test 2: MAIN_CHECKOUT is an absolute path
assert_eq "MAIN_CHECKOUT is absolute" "/" "${MAIN_CHECKOUT:0:1}"

# Test 3: MAIN_CHECKOUT points to a valid directory
assert_eq "MAIN_CHECKOUT is a directory" "true" "$([ -d "$MAIN_CHECKOUT" ] && echo true || echo false)"

# Test 4: MAIN_CHECKOUT contains a .git directory (it's the main checkout)
assert_eq "MAIN_CHECKOUT has .git" "true" "$([ -d "$MAIN_CHECKOUT/.git" ] && echo true || echo false)"

# Test 5: MAIN_CHECKOUT does NOT contain hardcoded username
assert_not_contains "no hardcoded aviadr1" "aviadr1" "$MAIN_CHECKOUT"

# Test 6: MAIN_CHECKOUT matches git worktree list first entry
EXPECTED="$(git worktree list --porcelain | head -1 | sed 's/^worktree //')"
assert_eq "matches git worktree list" "$EXPECTED" "$MAIN_CHECKOUT"

# Test 7: No hardcoded paths remain in hook scripts
echo ""
echo "--- Checking for hardcoded paths in hooks ---"
HARDCODED=$(grep -r '/home/aviadr1/projects/nanoclaw' "$HOOK_DIR" --include='*.sh' \
  | grep -v 'resolve-main-checkout.sh' \
  | grep -v '/tests/' \
  | grep -v '# .*Never hardcode' || true)
assert_eq "no hardcoded paths in hooks" "" "$HARDCODED"

print_results
