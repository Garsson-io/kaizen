#!/bin/bash
# test-issue-repo-routing.sh — Verify skill files route issue operations to $ISSUES_REPO
#
# Two test categories:
#   1. Lint: no SKILL.md uses $KAIZEN_REPO in gh issue commands (except routing table)
#   2. Logic: the routing derivation in skill-config-header.md produces correct values

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

SKILLS_DIR="$SCRIPT_DIR/../../skills"
CONFIG_HEADER="$SCRIPT_DIR/../../kaizen/skill-config-header.md"

echo "=== Issue Repo Routing Tests ==="

# Test 1: No skill uses $KAIZEN_REPO in gh issue commands
echo "--- Lint: \$KAIZEN_REPO not used in gh issue commands ---"

violations=""
while IFS= read -r -d '' skill_file; do
  while IFS=: read -r lineno line; do
    # Skip markdown table rows (routing table in kaizen-file-issue)
    if [[ "$line" == *"|"*'$KAIZEN_REPO'*"|"* ]]; then
      continue
    fi
    # Flag actual gh issue commands using $KAIZEN_REPO
    if echo "$line" | grep -qE 'gh issue.*\$KAIZEN_REPO|gh issue.*"\$KAIZEN_REPO"'; then
      rel_path="${skill_file#$SKILLS_DIR/}"
      violations="${violations}${rel_path}:${lineno}: ${line}\n"
    fi
  done < <(grep -n 'KAIZEN_REPO' "$skill_file" 2>/dev/null || true)
done < <(find "$SKILLS_DIR" -name "SKILL.md" -print0)

assert_eq "No \$KAIZEN_REPO in gh issue commands" "" "$violations"

# Test 2: All skills with gh issue commands reference $ISSUES_REPO
echo "--- Lint: skills with gh issue use \$ISSUES_REPO ---"

missing=""
while IFS= read -r -d '' skill_file; do
  if grep -q 'gh issue' "$skill_file" 2>/dev/null; then
    rel_path="${skill_file#$SKILLS_DIR/}"
    if ! grep -q 'ISSUES_REPO' "$skill_file" 2>/dev/null; then
      missing="${missing}${rel_path} "
    fi
  fi
done < <(find "$SKILLS_DIR" -name "SKILL.md" -print0)

assert_eq "All gh-issue skills reference \$ISSUES_REPO" "" "$missing"

# Test 3: Routing logic — self-dogfood mode
echo "--- Logic: self-dogfood routing ---"

KAIZEN_REPO="Garsson-io/kaizen"
HOST_REPO="Garsson-io/kaizen"
if [ "$KAIZEN_REPO" = "$HOST_REPO" ]; then
  ISSUES_REPO="$KAIZEN_REPO"
  ISSUES_LABEL=""
else
  ISSUES_REPO="$HOST_REPO"
  ISSUES_LABEL="--label kaizen"
fi

assert_eq "Self-dogfood: ISSUES_REPO" "Garsson-io/kaizen" "$ISSUES_REPO"
assert_eq "Self-dogfood: ISSUES_LABEL empty" "" "$ISSUES_LABEL"

# Test 4: Routing logic — host project mode
echo "--- Logic: host project routing ---"

KAIZEN_REPO="Garsson-io/kaizen"
HOST_REPO="gigaverse-app/langsmith-cli"
if [ "$KAIZEN_REPO" = "$HOST_REPO" ]; then
  ISSUES_REPO="$KAIZEN_REPO"
  ISSUES_LABEL=""
else
  ISSUES_REPO="$HOST_REPO"
  ISSUES_LABEL="--label kaizen"
fi

assert_eq "Host project: ISSUES_REPO" "gigaverse-app/langsmith-cli" "$ISSUES_REPO"
assert_eq "Host project: ISSUES_LABEL" "--label kaizen" "$ISSUES_LABEL"

# Test 5: skill-config-header.md contains routing elements
echo "--- Config: header has routing docs ---"

assert_contains "Config header has ISSUES_REPO" "ISSUES_REPO" "$(cat "$CONFIG_HEADER")"
assert_contains "Config header has ISSUES_LABEL" "ISSUES_LABEL" "$(cat "$CONFIG_HEADER")"
assert_contains "Config header compares repos" "KAIZEN_REPO.*HOST_REPO" "$(cat "$CONFIG_HEADER")"

# Test 6: No hardcoded repo names in gh issue commands
echo "--- Lint: no hardcoded repo names in gh issue commands ---"

hardcoded=""
while IFS= read -r -d '' skill_file; do
  while IFS=: read -r lineno line; do
    if echo "$line" | grep -qE 'gh issue.*(Garsson-io|gigaverse)'; then
      rel_path="${skill_file#$SKILLS_DIR/}"
      hardcoded="${hardcoded}${rel_path}:${lineno} "
    fi
  done < <(grep -n 'gh issue' "$skill_file" 2>/dev/null || true)
done < <(find "$SKILLS_DIR" -name "SKILL.md" -print0)

assert_eq "No hardcoded repo names in gh issue commands" "" "$hardcoded"

# Summary
echo ""
echo "Results: $PASS passed, $FAIL failed"
if [ ${#FAILED_NAMES[@]} -gt 0 ]; then
  echo "Failed tests:"
  for name in "${FAILED_NAMES[@]}"; do
    echo "  - $name"
  done
  exit 1
fi
