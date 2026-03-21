#!/bin/bash
# Tests for kaizen-verify-before-stop.sh — Stop hook that runs tsc and vitest
# before allowing the agent to finish.
#
# INVARIANT UNDER TEST: When TypeScript files are modified, the agent
# cannot stop until type-check and tests pass. When no TS files are
# modified, stop is always allowed.
source "$(dirname "$0")/test-helpers.sh"

HOOK="$(cd "$(dirname "$0")/.." && pwd)/kaizen-verify-before-stop.sh"

# We need mock git, npx commands
MOCK_DIR=$(mktemp -d)
trap 'rm -rf "$MOCK_DIR"' EXIT

# Helper: create mock git that returns specific diff output
setup_git_mock() {
  local diff_head_output="$1"
  local diff_cached_output="${2:-}"
  cat > "$MOCK_DIR/git" << MOCK
#!/bin/bash
if [[ "\$*" == *"diff --name-only HEAD"* ]]; then
  printf '%s' "$diff_head_output"
  exit 0
fi
if [[ "\$*" == *"diff --cached --name-only"* ]]; then
  printf '%s' "$diff_cached_output"
  exit 0
fi
/usr/bin/git "\$@"
MOCK
  chmod +x "$MOCK_DIR/git"
}

# Helper: create mock npx that succeeds or fails
setup_npx_mock() {
  local tsc_exit="${1:-0}"
  local vitest_exit="${2:-0}"
  cat > "$MOCK_DIR/npx" << MOCK
#!/bin/bash
if [[ "\$*" == *"tsc --noEmit"* ]]; then
  if [ "$tsc_exit" -ne 0 ]; then
    echo "error TS2345: Argument of type 'string' is not assignable" >&2
  fi
  exit $tsc_exit
fi
if [[ "\$*" == *"vitest run"* ]]; then
  if [ "$vitest_exit" -ne 0 ]; then
    echo "FAIL src/test.ts > should work" >&2
  fi
  exit $vitest_exit
fi
exit 0
MOCK
  chmod +x "$MOCK_DIR/npx"
}

run_hook() {
  PATH="$MOCK_DIR:$PATH" bash "$HOOK" 2>&1
  return $?
}

echo "=== No TypeScript changes: stop allowed ==="

# INVARIANT: When no .ts files are modified, hook exits 0 immediately
# SUT: kaizen-verify-before-stop.sh early-exit check
setup_git_mock "" ""
setup_npx_mock 0 0
OUTPUT=$(run_hook)
EXIT_CODE=$?
assert_eq "exit code 0 when no TS changes" "0" "$EXIT_CODE"
assert_not_contains "no verification message" "Verifying" "$OUTPUT"

echo ""
echo "=== Non-TS changes only: stop allowed ==="

# INVARIANT: Changes to non-.ts files (e.g., .md, .json) don't trigger verification
# SUT: kaizen-verify-before-stop.sh grep for .ts extension
setup_git_mock "README.md
package.json
.claude/kaizen/hooks/test.sh" ""
setup_npx_mock 0 0
OUTPUT=$(run_hook)
EXIT_CODE=$?
assert_eq "exit code 0 with only non-TS changes" "0" "$EXIT_CODE"

echo ""
echo "=== Harness TS changes, tsc passes, tests pass: stop allowed ==="

# INVARIANT: When harness .ts files are modified and all checks pass, stop is allowed
# SUT: kaizen-verify-before-stop.sh harness verification path
setup_git_mock "src/index.ts
src/cases.ts" ""
setup_npx_mock 0 0
# Need vitest.config.ts to exist for vitest check
VITEST_MARKER=$(mktemp -d)
touch "$VITEST_MARKER/vitest.config.ts"
OUTPUT=$(cd "$VITEST_MARKER" && PATH="$MOCK_DIR:$PATH" bash "$HOOK" 2>&1)
EXIT_CODE=$?
rm -rf "$VITEST_MARKER"
assert_eq "exit code 0 when checks pass" "0" "$EXIT_CODE"
assert_contains "success message shown" "passed" "$OUTPUT"

echo ""
echo "=== Harness TS changes, tsc fails: stop blocked ==="

# INVARIANT: When tsc fails, hook exits 2 to block stop
# SUT: kaizen-verify-before-stop.sh tsc failure path
setup_git_mock "src/index.ts" ""
setup_npx_mock 1 0
OUTPUT=$(run_hook)
EXIT_CODE=$?
assert_eq "exit code 2 when tsc fails" "2" "$EXIT_CODE"
assert_contains "type-check failure message" "type-check failed" "$OUTPUT"

echo ""
echo "=== Harness TS changes, tests fail: stop blocked ==="

# INVARIANT: When vitest fails, hook exits 2 to block stop
# SUT: kaizen-verify-before-stop.sh vitest failure path
setup_git_mock "src/cases.ts" ""
setup_npx_mock 0 1
# Need vitest.config.ts to exist
VITEST_MARKER=$(mktemp -d)
touch "$VITEST_MARKER/vitest.config.ts"
OUTPUT=$(cd "$VITEST_MARKER" && PATH="$MOCK_DIR:$PATH" bash "$HOOK" 2>&1)
EXIT_CODE=$?
rm -rf "$VITEST_MARKER"
assert_eq "exit code 2 when tests fail" "2" "$EXIT_CODE"
assert_contains "test failure message" "tests failed" "$OUTPUT"

echo ""
echo "=== Agent-runner TS changes only: runs agent-runner checks ==="

# INVARIANT: When only agent-runner files change, only agent-runner tsc runs
# SUT: kaizen-verify-before-stop.sh project detection (HARNESS_TS vs AGENT_RUNNER_TS)
setup_git_mock "container/agent-runner/src/tool.ts" ""
# Create mock that tracks which project tsc was called for
cat > "$MOCK_DIR/npx" << 'MOCK'
#!/bin/bash
if [[ "$*" == *"tsc --noEmit"* ]]; then
  echo "tsc-called" >&2
  exit 0
fi
if [[ "$*" == *"vitest run"* ]]; then
  exit 0
fi
exit 0
MOCK
chmod +x "$MOCK_DIR/npx"

# We need to run from a dir that has container/agent-runner/tsconfig.json
AGENT_MARKER=$(mktemp -d)
mkdir -p "$AGENT_MARKER/container/agent-runner"
touch "$AGENT_MARKER/container/agent-runner/tsconfig.json"
touch "$AGENT_MARKER/container/agent-runner/vitest.config.ts"
OUTPUT=$(cd "$AGENT_MARKER" && PATH="$MOCK_DIR:$PATH" bash "$HOOK" 2>&1)
EXIT_CODE=$?
rm -rf "$AGENT_MARKER"
assert_eq "exit code 0 for agent-runner check" "0" "$EXIT_CODE"

echo ""
echo "=== Agent-runner tsc fails: stop blocked ==="

# INVARIANT: Agent-runner tsc failure also blocks stop
# SUT: kaizen-verify-before-stop.sh agent-runner failure path
setup_git_mock "container/agent-runner/src/mcp.ts" ""
cat > "$MOCK_DIR/npx" << 'MOCK'
#!/bin/bash
if [[ "$*" == *"tsc --noEmit"* ]]; then
  echo "error TS2345: type mismatch" >&2
  exit 1
fi
exit 0
MOCK
chmod +x "$MOCK_DIR/npx"

AGENT_MARKER=$(mktemp -d)
mkdir -p "$AGENT_MARKER/container/agent-runner"
touch "$AGENT_MARKER/container/agent-runner/tsconfig.json"
OUTPUT=$(cd "$AGENT_MARKER" && PATH="$MOCK_DIR:$PATH" bash "$HOOK" 2>&1)
EXIT_CODE=$?
rm -rf "$AGENT_MARKER"
assert_eq "exit code 2 when agent-runner tsc fails" "2" "$EXIT_CODE"
assert_contains "agent-runner failure message" "Agent-runner" "$OUTPUT"

echo ""
echo "=== Mixed changes (harness + agent-runner): both checked ==="

# INVARIANT: When both harness and agent-runner files change, both are type-checked
# SUT: kaizen-verify-before-stop.sh project detection with mixed changes
setup_git_mock "src/index.ts
container/agent-runner/src/tool.ts" ""
TSC_CALLS=0
cat > "$MOCK_DIR/npx" << 'MOCK'
#!/bin/bash
if [[ "$*" == *"tsc --noEmit"* ]]; then
  exit 0
fi
if [[ "$*" == *"vitest run"* ]]; then
  exit 0
fi
exit 0
MOCK
chmod +x "$MOCK_DIR/npx"

MIXED_MARKER=$(mktemp -d)
mkdir -p "$MIXED_MARKER/container/agent-runner"
touch "$MIXED_MARKER/container/agent-runner/tsconfig.json"
touch "$MIXED_MARKER/container/agent-runner/vitest.config.ts"
touch "$MIXED_MARKER/vitest.config.ts"
OUTPUT=$(cd "$MIXED_MARKER" && PATH="$MOCK_DIR:$PATH" bash "$HOOK" 2>&1)
EXIT_CODE=$?
rm -rf "$MIXED_MARKER"
assert_eq "exit code 0 with mixed changes all passing" "0" "$EXIT_CODE"

echo ""
echo "=== Staged-only TS changes: still triggers verification ==="

# INVARIANT: Staged (cached) TS changes also trigger verification
# SUT: kaizen-verify-before-stop.sh combines diff HEAD and diff --cached
setup_git_mock "" "src/new-file.ts"
setup_npx_mock 0 0
VITEST_MARKER=$(mktemp -d)
touch "$VITEST_MARKER/vitest.config.ts"
OUTPUT=$(cd "$VITEST_MARKER" && PATH="$MOCK_DIR:$PATH" bash "$HOOK" 2>&1)
EXIT_CODE=$?
rm -rf "$VITEST_MARKER"
assert_eq "exit code 0 with staged-only changes" "0" "$EXIT_CODE"
assert_contains "verification triggered for staged changes" "Verifying" "$OUTPUT"

echo ""
echo "=== No vitest.config.ts: skips test run ==="

# INVARIANT: If vitest.config.ts doesn't exist, tests are skipped (tsc still runs)
# SUT: kaizen-verify-before-stop.sh vitest config file check
setup_git_mock "src/index.ts" ""
setup_npx_mock 0 99  # vitest would fail if called
NO_VITEST_DIR=$(mktemp -d)
# Intentionally no vitest.config.ts
OUTPUT=$(cd "$NO_VITEST_DIR" && PATH="$MOCK_DIR:$PATH" bash "$HOOK" 2>&1)
EXIT_CODE=$?
rm -rf "$NO_VITEST_DIR"
assert_eq "exit code 0 when no vitest config (skips tests)" "0" "$EXIT_CODE"

print_results
