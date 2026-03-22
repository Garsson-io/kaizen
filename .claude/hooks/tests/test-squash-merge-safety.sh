#!/bin/bash
# Tests for kaizen-squash-merge-safety.sh (kaizen #289)
#
# INVARIANT UNDER TEST: Before squash merge, compare branch files changed
# vs what will land in the squash. Warn if files in the branch diff are
# missing from the squash preview, indicating potential silent file loss.
source "$(dirname "$0")/test-helpers.sh"

HOOK="$(dirname "$0")/../kaizen-squash-merge-safety.sh"
setup_mock_dir
trap 'rm -rf "$MOCK_DIR"' EXIT

# ============================================================
# Helper: run hook as PostToolUse with gh pr merge command
# ============================================================
run_pretool_bash() {
  local command="$1"
  local input
  input=$(jq -n --arg cmd "$command" '{"tool_input":{"command":$cmd}}')
  echo "$input" | PATH="$MOCK_DIR:$PATH" bash "$HOOK" 2>/dev/null
}

# Helper to create gh mock that returns specific diff outputs
setup_squash_mocks() {
  local branch_files="$1"     # files in PR (gh pr view --json files)
  local squash_files="$2"     # files in squash diff (gh pr diff --name-only)
  local pr_state="${3:-OPEN}"

  cat > "$MOCK_DIR/gh" << MOCK
#!/bin/bash
if echo "\$@" | grep -q "pr diff.*--name-only"; then
  printf '%s\n' $squash_files
  exit 0
fi
if echo "\$@" | grep -q "pr view.*--json"; then
  if echo "\$@" | grep -q "files"; then
    # Return file paths for --json files --jq '.files[].path'
    printf '%s\n' $branch_files
    exit 0
  fi
  if echo "\$@" | grep -q -- "--jq"; then
    echo "3"
  else
    echo '{"state":"$pr_state","commits":{"totalCount":3}}'
  fi
  exit 0
fi
echo "OPEN"
exit 0
MOCK
  chmod +x "$MOCK_DIR/gh"
}

# ============================================================
# Non-squash merge is NOT checked
# ============================================================

echo "=== Non-squash merge is ignored ==="

OUTPUT=$(run_pretool_bash "gh pr merge 42 --merge --delete-branch")
if ! is_denied "$OUTPUT"; then
  echo "  PASS: non-squash merge not checked"
  ((PASS++))
else
  echo "  FAIL: non-squash merge incorrectly blocked"
  ((FAIL++))
fi

echo ""
echo "=== Non-gh command is ignored ==="

OUTPUT=$(run_pretool_bash "npm run build")
if ! is_denied "$OUTPUT"; then
  echo "  PASS: non-gh command ignored"
  ((PASS++))
else
  echo "  FAIL: non-gh command incorrectly blocked"
  ((FAIL++))
fi

# ============================================================
# Squash merge with matching files PASSES
# ============================================================

echo ""
echo "=== Squash merge with all files matching PASSES ==="

setup_squash_mocks "src/a.ts src/b.ts" "src/a.ts src/b.ts"

OUTPUT=$(run_pretool_bash "gh pr merge 42 --squash --delete-branch")
if ! is_denied "$OUTPUT"; then
  echo "  PASS: matching files not blocked"
  ((PASS++))
else
  echo "  FAIL: matching files incorrectly blocked"
  ((FAIL++))
fi

# ============================================================
# Squash merge with missing files WARNS
# ============================================================

echo ""
echo "=== Squash merge with missing file triggers WARNING ==="

setup_squash_mocks "src/a.ts src/b.ts src/new-file.ts" "src/a.ts src/b.ts"

OUTPUT=$(run_pretool_bash "gh pr merge 42 --squash --delete-branch --repo Garsson-io/kaizen")
if is_denied "$OUTPUT"; then
  echo "  PASS: missing file triggers deny"
  ((PASS++))
else
  echo "  FAIL: missing file did not trigger deny"
  echo "    output: $OUTPUT"
  ((FAIL++))
fi
assert_contains "mentions missing file" "new-file.ts" "$OUTPUT"

# ============================================================
# Squash merge with only deletions is fine (files removed in later commits)
# ============================================================

echo ""
echo "=== Squash with extra files in squash (deletions in branch) is OK ==="

setup_squash_mocks "src/a.ts" "src/a.ts src/deleted.ts"

OUTPUT=$(run_pretool_bash "gh pr merge 42 --squash")
if ! is_denied "$OUTPUT"; then
  echo "  PASS: extra squash files allowed (deletions)"
  ((PASS++))
else
  echo "  FAIL: extra squash files incorrectly blocked"
  ((FAIL++))
fi

# ============================================================
# Single-commit PRs are skipped (no squash risk)
# ============================================================

echo ""
echo "=== Single-commit PR is not checked ==="

cat > "$MOCK_DIR/gh" << 'MOCK'
#!/bin/bash
if echo "$@" | grep -q "pr view.*--json"; then
  if echo "$@" | grep -q -- "--jq"; then
    echo "1"
  else
    echo '{"state":"OPEN","commits":{"totalCount":1}}'
  fi
  exit 0
fi
echo "OPEN"
exit 0
MOCK
chmod +x "$MOCK_DIR/gh"

OUTPUT=$(run_pretool_bash "gh pr merge 42 --squash")
if ! is_denied "$OUTPUT"; then
  echo "  PASS: single-commit PR skipped"
  ((PASS++))
else
  echo "  FAIL: single-commit PR incorrectly checked"
  ((FAIL++))
fi

# ============================================================
# Done
# ============================================================

print_results
