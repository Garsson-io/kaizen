#!/bin/bash
# Tests for .claude/hooks/lib/run-tsx.sh

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)"
RUN_TSX="$REPO_ROOT/.claude/hooks/lib/run-tsx.sh"
require_file "$RUN_TSX" "run-tsx.sh"

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

print_results
