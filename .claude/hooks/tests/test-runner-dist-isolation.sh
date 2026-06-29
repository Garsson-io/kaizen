#!/bin/bash
# Tests for hook test runner dist isolation.
# SUT: .claude/hooks/tests/runner-dist-isolation.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"
source "$SCRIPT_DIR/runner-dist-isolation.sh"

TMP_ROOT=$(mktemp -d)
trap 'restore_private_dist 2>/dev/null || true; rm -rf "$TMP_ROOT"' EXIT

echo "=== symlinked dist gets private per-run copy ==="

SHARED_DIST="$TMP_ROOT/shared-dist"
WORKTREE="$TMP_ROOT/worktree"
mkdir -p "$SHARED_DIST/hooks" "$WORKTREE"
printf 'shared\n' > "$SHARED_DIST/hooks/tool.js"
ln -s "$SHARED_DIST" "$WORKTREE/dist"

setup_private_dist_if_symlink "$WORKTREE"

PRIVATE_TARGET=$(readlink "$WORKTREE/dist")
assert_not_contains "private dist no longer points at shared target" "$SHARED_DIST" "$PRIVATE_TARGET"
assert_contains "private dist path names hook test isolation" ".kaizen-hook-test-dist-" "$PRIVATE_TARGET"
assert_eq "private dist copied existing artifact" "shared" "$(cat "$WORKTREE/dist/hooks/tool.js")"

printf 'private\n' > "$WORKTREE/dist/hooks/private-only.js"
if [ -f "$SHARED_DIST/hooks/private-only.js" ]; then
  SHARED_MUTATED="yes"
else
  SHARED_MUTATED="no"
fi
assert_eq "writes through isolated dist do not mutate shared dist" "no" "$SHARED_MUTATED"

restore_private_dist

assert_eq "restore returns dist symlink to shared target" "$SHARED_DIST" "$(readlink "$WORKTREE/dist")"

echo ""
echo "=== run-all-tests wires private dist during test execution ==="

RUNNER_ROOT="$TMP_ROOT/runner-root"
RUNNER_TESTS="$RUNNER_ROOT/.claude/hooks/tests"
mkdir -p "$RUNNER_TESTS" "$RUNNER_ROOT/shared-dist/hooks"
printf 'shared\n' > "$RUNNER_ROOT/shared-dist/hooks/tool.js"
ln -s "$RUNNER_ROOT/shared-dist" "$RUNNER_ROOT/dist"
cp "$SCRIPT_DIR/run-all-tests.sh" "$RUNNER_TESTS/run-all-tests.sh"
cp "$SCRIPT_DIR/runner-dist-isolation.sh" "$RUNNER_TESTS/runner-dist-isolation.sh"
cat > "$RUNNER_TESTS/test-dist-visible.sh" <<'TEST'
#!/bin/bash
target=$(readlink dist 2>/dev/null || true)
if echo "$target" | grep -q ".kaizen-hook-test-dist-" && [ -f dist/hooks/tool.js ]; then
  printf 'private\n' > dist/hooks/private-only.js
  echo "  PASS: runner isolated dist during test"
  echo "Results: 1 passed, 0 failed"
  exit 0
fi
echo "  FAIL: runner did not isolate dist during test"
echo "Results: 0 passed, 1 failed"
exit 1
TEST
chmod +x "$RUNNER_TESTS/test-dist-visible.sh"

RUNNER_OUTPUT=$(cd "$RUNNER_ROOT" && bash .claude/hooks/tests/run-all-tests.sh --unit)

assert_contains "runner reports synthetic test pass" "TOTAL: 1 tests, 1 passed, 0 failed" "$RUNNER_OUTPUT"
assert_eq "runner restores original dist symlink" "$RUNNER_ROOT/shared-dist" "$(readlink "$RUNNER_ROOT/dist")"
if [ -f "$RUNNER_ROOT/shared-dist/hooks/private-only.js" ]; then
  RUNNER_SHARED_MUTATED="yes"
else
  RUNNER_SHARED_MUTATED="no"
fi
assert_eq "runner private write does not mutate shared dist" "no" "$RUNNER_SHARED_MUTATED"

echo ""
echo "=== real dist directory keeps fast path ==="

REAL_ROOT="$TMP_ROOT/real-root"
mkdir -p "$REAL_ROOT/dist/hooks"

setup_private_dist_if_symlink "$REAL_ROOT"

if [ -L "$REAL_ROOT/dist" ]; then
  REAL_WAS_SYMLINK="yes"
else
  REAL_WAS_SYMLINK="no"
fi
assert_eq "real dist not replaced" "no" "$REAL_WAS_SYMLINK"
restore_private_dist

echo ""
echo "=== missing dist keeps fast path ==="

NO_DIST_ROOT="$TMP_ROOT/no-dist-root"
mkdir -p "$NO_DIST_ROOT"

setup_private_dist_if_symlink "$NO_DIST_ROOT"

if [ -e "$NO_DIST_ROOT/dist" ] || [ -L "$NO_DIST_ROOT/dist" ]; then
  MISSING_CREATED="yes"
else
  MISSING_CREATED="no"
fi
assert_eq "missing dist not created" "no" "$MISSING_CREATED"
restore_private_dist

print_results
