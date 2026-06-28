#!/bin/bash
# Tests for .claude/hooks/lib/run-tsx.sh

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)"
RUN_TSX="$REPO_ROOT/.claude/hooks/lib/run-tsx.sh"
RESOLVE_TSX="$REPO_ROOT/.claude/hooks/lib/resolve-tsx-bin.sh"
require_file "$RUN_TSX" "run-tsx.sh"
require_file "$RESOLVE_TSX" "resolve-tsx-bin.sh"

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

echo "=== run-tsx hook wrapper ==="

cat > "$TMP_DIR/mock-tsx" <<'EOF'
#!/bin/bash
echo "override-tsx:$1"
EOF
chmod +x "$TMP_DIR/mock-tsx"

cat > "$TMP_DIR/hook.ts" <<'EOF'
console.log("hook");
EOF

result=$(
  KAIZEN_TSX_BIN="$TMP_DIR/mock-tsx" bash -c "
    source '$RUN_TSX'
    run_tsx '$TMP_DIR/no-node-modules' '$TMP_DIR/hook.ts'
  " 2>&1
)
exit_code=$?

assert_eq "KAIZEN_TSX_BIN override exits 0" "0" "$exit_code"
assert_contains "KAIZEN_TSX_BIN override runs requested source" "override-tsx:$TMP_DIR/hook.ts" "$result"

mkdir -p "$TMP_DIR/parent/node_modules/.bin" "$TMP_DIR/parent/worktree"
cat > "$TMP_DIR/parent/node_modules/.bin/tsx" <<'EOF'
#!/bin/bash
echo "parent-tsx:$1"
EOF
chmod +x "$TMP_DIR/parent/node_modules/.bin/tsx"

resolved=$(
  bash -c "
    source '$RESOLVE_TSX'
    resolve_tsx_bin '$TMP_DIR/parent/worktree'
  "
)
assert_eq "resolve_tsx_bin finds parent worktree tsx" "$TMP_DIR/parent/node_modules/.bin/tsx" "$resolved"

print_results
