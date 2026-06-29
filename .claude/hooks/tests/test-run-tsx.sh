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

mkdir -p "$TMP_DIR/bin"
cat > "$TMP_DIR/bin/node" <<'EOF'
#!/bin/bash
echo "node-dist:$1"
EOF
chmod +x "$TMP_DIR/bin/node"

echo ""
echo "=== precompiled dist runtime ==="

FRESH_ROOT="$TMP_DIR/fresh-root"
mkdir -p "$FRESH_ROOT/src/hooks" "$FRESH_ROOT/dist/hooks" "$FRESH_ROOT/node_modules/.bin"
printf 'source\n' > "$FRESH_ROOT/src/hooks/fresh-hook.ts"
printf 'compiled\n' > "$FRESH_ROOT/dist/hooks/fresh-hook.js"
cat > "$FRESH_ROOT/node_modules/.bin/tsx" <<'EOF'
#!/bin/bash
echo "fallback-tsx:$1"
EOF
chmod +x "$FRESH_ROOT/node_modules/.bin/tsx"
touch "$FRESH_ROOT/src/hooks/fresh-hook.ts"
sleep 1
touch "$FRESH_ROOT/dist/.kaizen-hook-build"

result=$(
  PATH="$TMP_DIR/bin:$PATH" bash -c "
    source '$RUN_TSX'
    run_tsx '$FRESH_ROOT' '$FRESH_ROOT/src/hooks/fresh-hook.ts'
  " 2>&1
)
exit_code=$?

assert_eq "fresh dist exits 0" "0" "$exit_code"
assert_contains "fresh dist runs compiled hook through node" "node-dist:$FRESH_ROOT/dist/hooks/fresh-hook.js" "$result"
assert_not_contains "fresh dist does not fall back to tsx" "fallback-tsx:" "$result"

STALE_ROOT="$TMP_DIR/stale-root"
mkdir -p "$STALE_ROOT/src/hooks" "$STALE_ROOT/dist/hooks" "$STALE_ROOT/node_modules/.bin"
printf 'compiled\n' > "$STALE_ROOT/dist/hooks/stale-hook.js"
touch "$STALE_ROOT/dist/.kaizen-hook-build"
sleep 1
printf 'new source\n' > "$STALE_ROOT/src/hooks/stale-hook.ts"
cat > "$STALE_ROOT/node_modules/.bin/tsx" <<'EOF'
#!/bin/bash
echo "fallback-tsx:$1"
EOF
chmod +x "$STALE_ROOT/node_modules/.bin/tsx"

result=$(
  PATH="$TMP_DIR/bin:$PATH" bash -c "
    source '$RUN_TSX'
    run_tsx '$STALE_ROOT' '$STALE_ROOT/src/hooks/stale-hook.ts'
  " 2>&1
)
exit_code=$?

assert_eq "stale dist exits 0 through fallback" "0" "$exit_code"
assert_contains "stale source falls back to tsx" "fallback-tsx:$STALE_ROOT/src/hooks/stale-hook.ts" "$result"
assert_not_contains "stale dist is not executed" "node-dist:" "$result"

MISSING_MARKER_ROOT="$TMP_DIR/missing-marker-root"
mkdir -p "$MISSING_MARKER_ROOT/src/hooks" "$MISSING_MARKER_ROOT/dist/hooks" "$MISSING_MARKER_ROOT/node_modules/.bin"
printf 'source\n' > "$MISSING_MARKER_ROOT/src/hooks/no-marker-hook.ts"
printf 'compiled\n' > "$MISSING_MARKER_ROOT/dist/hooks/no-marker-hook.js"
cat > "$MISSING_MARKER_ROOT/node_modules/.bin/tsx" <<'EOF'
#!/bin/bash
echo "fallback-tsx:$1"
EOF
chmod +x "$MISSING_MARKER_ROOT/node_modules/.bin/tsx"

result=$(
  PATH="$TMP_DIR/bin:$PATH" bash -c "
    source '$RUN_TSX'
    run_tsx '$MISSING_MARKER_ROOT' '$MISSING_MARKER_ROOT/src/hooks/no-marker-hook.ts'
  " 2>&1
)
exit_code=$?

assert_eq "missing build marker exits 0 through fallback" "0" "$exit_code"
assert_contains "missing build marker falls back to tsx" "fallback-tsx:$MISSING_MARKER_ROOT/src/hooks/no-marker-hook.ts" "$result"
assert_not_contains "missing build marker does not run dist" "node-dist:" "$result"

echo ""
echo "=== test harness override ==="

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

mkdir -p "$TMP_DIR/missing-deps-root"
cat > "$TMP_DIR/npx" <<'EOF'
#!/bin/bash
exit 1
EOF
chmod +x "$TMP_DIR/npx"

result=$(
  PATH="$TMP_DIR:$PATH" bash -c "
    source '$RUN_TSX'
    run_tsx '$TMP_DIR/missing-deps-root' '$TMP_DIR/hook.ts'
  " 2>&1
)
exit_code=$?

assert_eq "missing tsx exits 0 instead of opaque non-blocking failure" "0" "$exit_code"
assert_contains "missing tsx emits actionable diagnostic" "kaizen hook: tsx not found" "$result"
assert_contains "missing tsx diagnostic names root" "$TMP_DIR/missing-deps-root" "$result"

legacy_fallbacks=$(grep -R -nE 'npx --prefix .+tsx.+2>/dev/null' "$REPO_ROOT/.claude/hooks" --exclude-dir=tests || true)
assert_eq "runtime hooks avoid silent npx tsx fallbacks" "" "$legacy_fallbacks"

print_results
