#!/bin/bash
# Tests for scripts/lib/resolve-cli-kaizen.sh
# Tests the resolve_cli_kaizen and resolve_cli_kaizen_for_worktree functions.

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)"
RESOLVE_SCRIPT="$REPO_ROOT/scripts/lib/resolve-cli-kaizen.sh"
require_file "$RESOLVE_SCRIPT" "resolve-cli-kaizen.sh"

# Source the script so we can call its functions directly
source "$RESOLVE_SCRIPT"

MOCK_ROOT=$(mktemp -d)
trap 'rm -rf "$MOCK_ROOT"' EXIT

echo "=== resolve_cli_kaizen ==="

# Test: prefers tsx + source when both exist
echo "--- strategy 1: tsx from source ---"
mkdir -p "$MOCK_ROOT/strat1/node_modules/.bin" "$MOCK_ROOT/strat1/src"
cat > "$MOCK_ROOT/strat1/node_modules/.bin/tsx" << 'EOF'
#!/bin/bash
echo "tsx"
EOF
chmod +x "$MOCK_ROOT/strat1/node_modules/.bin/tsx"
touch "$MOCK_ROOT/strat1/src/cli-kaizen.ts"

result=$(resolve_cli_kaizen "$MOCK_ROOT/strat1")
exit_code=$?
assert_eq "tsx strategy returns success" "0" "$exit_code"
assert_contains "tsx strategy output includes tsx" "tsx" "$result"
assert_contains "tsx strategy output includes cli-kaizen.ts" "cli-kaizen.ts" "$result"

# Test: falls back to dist/ when tsx not available
echo "--- strategy 2: compiled dist ---"
mkdir -p "$MOCK_ROOT/strat2/dist"
touch "$MOCK_ROOT/strat2/dist/cli-kaizen.js"

result=$(resolve_cli_kaizen "$MOCK_ROOT/strat2")
exit_code=$?
assert_eq "dist strategy returns success" "0" "$exit_code"
assert_contains "dist strategy output includes node" "node" "$result"
assert_contains "dist strategy output includes cli-kaizen.js" "cli-kaizen.js" "$result"

# Test: prefers tsx over dist when both exist
echo "--- strategy priority: tsx over dist ---"
mkdir -p "$MOCK_ROOT/both/node_modules/.bin" "$MOCK_ROOT/both/src" "$MOCK_ROOT/both/dist"
cat > "$MOCK_ROOT/both/node_modules/.bin/tsx" << 'EOF'
#!/bin/bash
echo "tsx"
EOF
chmod +x "$MOCK_ROOT/both/node_modules/.bin/tsx"
touch "$MOCK_ROOT/both/src/cli-kaizen.ts"
touch "$MOCK_ROOT/both/dist/cli-kaizen.js"

result=$(resolve_cli_kaizen "$MOCK_ROOT/both")
assert_contains "prefers tsx over dist" "tsx" "$result"
assert_not_contains "does not use node when tsx available" "^node " "$result"

# Test: returns 1 when nothing found
echo "--- nothing found ---"
mkdir -p "$MOCK_ROOT/empty"
resolve_cli_kaizen "$MOCK_ROOT/empty" > /dev/null 2>&1
exit_code=$?
assert_eq "returns 1 when no cli-kaizen found" "1" "$exit_code"

# Test: tsx binary exists but source doesn't -> falls through to dist
echo "--- tsx binary without source ---"
mkdir -p "$MOCK_ROOT/no-src/node_modules/.bin" "$MOCK_ROOT/no-src/dist"
cat > "$MOCK_ROOT/no-src/node_modules/.bin/tsx" << 'EOF'
#!/bin/bash
echo "tsx"
EOF
chmod +x "$MOCK_ROOT/no-src/node_modules/.bin/tsx"
touch "$MOCK_ROOT/no-src/dist/cli-kaizen.js"

result=$(resolve_cli_kaizen "$MOCK_ROOT/no-src")
assert_contains "falls to dist when source missing" "node" "$result"

# Test: defaults to current dir when no arg
echo "--- default project_root ---"
(resolve_cli_kaizen) >/dev/null 2>&1 || true
assert_eq "no-arg call does not crash" "0" "0"

echo ""
echo "=== executable mode ==="

# Test: executable mode with explicit path
result=$("$RESOLVE_SCRIPT" "$MOCK_ROOT/strat1" 2>&1)
exit_code=$?
assert_eq "executable mode with path returns success" "0" "$exit_code"
assert_contains "executable mode outputs tsx command" "tsx" "$result"

# Test: executable mode with invalid path
result=$("$RESOLVE_SCRIPT" "$MOCK_ROOT/nonexistent" 2>&1)
exit_code=$?
assert_eq "executable mode with invalid path returns 1" "1" "$exit_code"
assert_contains "executable mode shows error" "error" "$result"

print_results
