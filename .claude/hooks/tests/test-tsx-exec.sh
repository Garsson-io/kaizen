#!/bin/bash
# Tests for scripts/lib/tsx-exec.sh
# Tests the tsx_exec function's resolution strategy.

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)"
TSX_EXEC_SCRIPT="$REPO_ROOT/scripts/lib/tsx-exec.sh"
require_file "$TSX_EXEC_SCRIPT" "tsx-exec.sh"

MOCK_ROOT=$(mktemp -d)
MOCK_BIN=$(mktemp -d)
trap 'rm -rf "$MOCK_ROOT" "$MOCK_BIN"' EXIT

echo "=== tsx_exec resolution ==="

# We can't fully test tsx_exec because it uses `exec` which replaces the process.
# Instead, we test the resolution logic by examining the script's behavior
# with mock git that controls what rev-parse returns.

# Test: script is sourceable without error
echo "--- sourceable ---"
(source "$TSX_EXEC_SCRIPT" 2>&1)
exit_code=$?
assert_eq "tsx-exec.sh sources without error" "0" "$exit_code"

# Test: tsx_exec fails gracefully when no binary found
echo "--- no binary found ---"
# Create a mock git that returns our mock root
cat > "$MOCK_BIN/git" << MOCK
#!/bin/bash
if echo "\$@" | grep -q "show-toplevel"; then
  echo "$MOCK_ROOT/project"
  exit 0
fi
if echo "\$@" | grep -q "git-common-dir"; then
  echo ".git"
  exit 0
fi
/usr/bin/git "\$@" 2>/dev/null
MOCK
chmod +x "$MOCK_BIN/git"

mkdir -p "$MOCK_ROOT/project"

# tsx_exec calls exec, so we run it in a subshell to catch the error exit
result=$(PATH="$MOCK_BIN:$PATH" CLAUDE_PLUGIN_ROOT="" bash -c "
  source '$TSX_EXEC_SCRIPT'
  tsx_exec nonexistent-tool 2>&1
")
exit_code=$?
assert_eq "tsx_exec exits 1 when no binary found" "1" "$exit_code"
assert_contains "tsx_exec shows error message" "cannot find" "$result"

# Test: tsx_exec finds tsx + source in project root
echo "--- tsx from project root ---"
mkdir -p "$MOCK_ROOT/project/node_modules/.bin" "$MOCK_ROOT/project/src"

# Create a mock tsx that echoes instead of running
cat > "$MOCK_ROOT/project/node_modules/.bin/tsx" << 'EOF'
#!/bin/bash
echo "tsx-ran: $@"
EOF
chmod +x "$MOCK_ROOT/project/node_modules/.bin/tsx"

cat > "$MOCK_ROOT/project/src/worktree-du.ts" << 'EOF'
console.log("hello");
EOF

# tsx_exec uses exec, so we can test it finds the right binary
# by checking it doesn't fall through to the error case
result=$(PATH="$MOCK_BIN:$PATH" CLAUDE_PLUGIN_ROOT="" bash -c "
  source '$TSX_EXEC_SCRIPT'
  tsx_exec worktree-du --help 2>&1
")
exit_code=$?
assert_eq "tsx_exec with valid source exits 0" "0" "$exit_code"
assert_contains "tsx_exec runs with arguments" "help" "$result"

# Test: tsx_exec uses CLAUDE_PLUGIN_ROOT fallback
echo "--- CLAUDE_PLUGIN_ROOT fallback ---"
mkdir -p "$MOCK_ROOT/plugin/node_modules/.bin" "$MOCK_ROOT/plugin/src"

cat > "$MOCK_ROOT/plugin/node_modules/.bin/tsx" << 'EOF'
#!/bin/bash
echo "plugin-tsx: $@"
EOF
chmod +x "$MOCK_ROOT/plugin/node_modules/.bin/tsx"

cat > "$MOCK_ROOT/plugin/src/my-tool.ts" << 'EOF'
console.log("plugin tool");
EOF

# Empty project root, but CLAUDE_PLUGIN_ROOT has the files
mkdir -p "$MOCK_ROOT/empty-project"
cat > "$MOCK_BIN/git2" << MOCK
#!/bin/bash
if echo "\$@" | grep -q "show-toplevel"; then
  echo "$MOCK_ROOT/empty-project"
  exit 0
fi
if echo "\$@" | grep -q "git-common-dir"; then
  echo ".git"
  exit 0
fi
/usr/bin/git "\$@" 2>/dev/null
MOCK
chmod +x "$MOCK_BIN/git2"
cp "$MOCK_BIN/git2" "$MOCK_BIN/git"

result=$(PATH="$MOCK_BIN:$PATH" CLAUDE_PLUGIN_ROOT="$MOCK_ROOT/plugin" bash -c "
  source '$TSX_EXEC_SCRIPT'
  tsx_exec my-tool 2>&1
")
exit_code=$?
assert_eq "plugin root fallback exits 0" "0" "$exit_code"
assert_contains "plugin root fallback uses plugin tsx" "plugin-tsx" "$result"

# Test: tsx_exec uses compiled dist/ fallback
echo "--- dist fallback ---"
mkdir -p "$MOCK_ROOT/dist-project/dist"

cat > "$MOCK_ROOT/dist-project/dist/my-tool.js" << 'EOF'
console.log("dist-tool");
EOF

cat > "$MOCK_BIN/git" << MOCK
#!/bin/bash
if echo "\$@" | grep -q "show-toplevel"; then
  echo "$MOCK_ROOT/dist-project"
  exit 0
fi
if echo "\$@" | grep -q "git-common-dir"; then
  echo ".git"
  exit 0
fi
/usr/bin/git "\$@" 2>/dev/null
MOCK
chmod +x "$MOCK_BIN/git"

result=$(PATH="$MOCK_BIN:$PATH" CLAUDE_PLUGIN_ROOT="" bash -c "
  source '$TSX_EXEC_SCRIPT'
  tsx_exec my-tool 2>&1
")
exit_code=$?
assert_eq "dist fallback exits 0" "0" "$exit_code"
assert_contains "dist fallback outputs tool content" "dist-tool" "$result"

print_results
