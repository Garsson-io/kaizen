#!/bin/bash
# test-setup-e2e.sh — Run kaizen setup E2E test against a real temp project.
#
# Creates a temp project, runs claude -p with the kaizen plugin, and
# verifies the setup actually created the right files.
#
# Usage: bash scripts/test-setup-e2e.sh [--verbose]

set -euo pipefail

KAIZEN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERBOSE="${1:-}"

log() { echo "[test] $*"; }
fail() { echo "[FAIL] $*" >&2; FAILURES=$((FAILURES + 1)); }
pass() { echo "[PASS] $*"; PASSES=$((PASSES + 1)); }

FAILURES=0
PASSES=0

# Create a temp project
TESTDIR=$(mktemp -d)
log "Created test project at $TESTDIR"

cleanup() { rm -rf "$TESTDIR" /tmp/claude-setup-*.log; }
trap cleanup EXIT

# Init git repo
git init "$TESTDIR" >/dev/null 2>&1
git -C "$TESTDIR" config user.name "test"
git -C "$TESTDIR" config user.email "test@test.com"

# Make it a Python project
cat > "$TESTDIR/pyproject.toml" << 'EOF'
[project]
name = "test-app"
version = "0.1.0"
EOF
echo "# Test App" > "$TESTDIR/CLAUDE.md"
echo "# Test App README" > "$TESTDIR/README.md"
git -C "$TESTDIR" add .
git -C "$TESTDIR" commit -m "init" >/dev/null 2>&1

log "Test project initialized at $TESTDIR"

run_claude() {
  local prompt="$1"
  local logfile="/tmp/claude-setup-$$.log"
  local max_turns="${2:-5}"

  if [ "$VERBOSE" = "--verbose" ]; then
    log "Running: claude -p '$prompt'"
  fi

  claude -p \
    --plugin-dir "$KAIZEN_ROOT" \
    --output-format json \
    --model haiku \
    --max-turns "$max_turns" \
    --max-budget-usd 1 \
    --dangerously-skip-permissions \
    -C "$TESTDIR" \
    "$prompt" 2>"$logfile"

  if [ "$VERBOSE" = "--verbose" ]; then
    log "STDERR: $(cat "$logfile" | tail -5)"
  fi
}

# Test 1: Skills are discoverable
log ""
log "=== TEST 1: Skill discovery ==="
RESULT=$(run_claude "List all available skills starting with 'kaizen-'. ONLY output skill names, one per line, nothing else." 1)
SKILL_COUNT=$(echo "$RESULT" | python3 -c "import json,sys; r=json.load(sys.stdin).get('result',''); print(len([l for l in r.split('\n') if l.strip().startswith('kaizen-')]))")

if [ "$SKILL_COUNT" -ge 14 ]; then
  pass "Found $SKILL_COUNT kaizen skills (expected >= 14)"
else
  fail "Found only $SKILL_COUNT kaizen skills (expected >= 14)"
  echo "$RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('result',''))" | head -20
fi

# Check specific critical skills
for skill in kaizen-setup kaizen-reflect kaizen-review-pr kaizen-write-plan kaizen-implement; do
  if echo "$RESULT" | python3 -c "import json,sys; r=json.load(sys.stdin).get('result',''); sys.exit(0 if '$skill' in r else 1)"; then
    pass "Skill $skill is available"
  else
    fail "Skill $skill is MISSING"
  fi
done

# Test 2: Setup creates files
log ""
log "=== TEST 2: /kaizen-setup creates files ==="
RESULT=$(run_claude 'Run /kaizen-setup for this project. Use these exact values without asking any questions:
- name: test-app
- repo: testorg/test-app
- description: A test Python CLI
- kaizen-repo: Garsson-io/kaizen
- channel: none
Create all files immediately. Do not ask for confirmation.' 10)

SETUP_RESULT=$(echo "$RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('result','')[:500])")
SETUP_ERROR=$(echo "$RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('is_error', False))")
SETUP_TURNS=$(echo "$RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('num_turns', 0))")

log "Setup used $SETUP_TURNS turns, error=$SETUP_ERROR"
if [ "$VERBOSE" = "--verbose" ]; then
  log "Setup result: $SETUP_RESULT"
fi

# Check kaizen.config.json
if [ -f "$TESTDIR/kaizen.config.json" ]; then
  CONFIG_NAME=$(python3 -c "import json; d=json.load(open('$TESTDIR/kaizen.config.json')); print(d.get('host',{}).get('name',''))")
  if [ "$CONFIG_NAME" = "test-app" ]; then
    pass "kaizen.config.json created with correct host.name"
  else
    fail "kaizen.config.json has wrong host.name: '$CONFIG_NAME'"
  fi
else
  fail "kaizen.config.json NOT created in project root"
  log "  Files in project root: $(ls "$TESTDIR")"
fi

# Check policies-local.md
if [ -f "$TESTDIR/.claude/kaizen/policies-local.md" ]; then
  pass "policies-local.md created"
else
  fail "policies-local.md NOT created"
fi

# Check CLAUDE.md has kaizen content
if grep -qi "kaizen" "$TESTDIR/CLAUDE.md" 2>/dev/null; then
  pass "CLAUDE.md contains kaizen section"
else
  fail "CLAUDE.md does NOT contain kaizen section"
  log "  CLAUDE.md content: $(cat "$TESTDIR/CLAUDE.md")"
fi

# Check config NOT in plugin cache
if [ -f "$KAIZEN_ROOT/kaizen.config.json" ]; then
  CACHE_NAME=$(python3 -c "import json; d=json.load(open('$KAIZEN_ROOT/kaizen.config.json')); print(d.get('host',{}).get('name',''))")
  if [ "$CACHE_NAME" = "test-app" ]; then
    fail "kaizen.config.json was written to plugin cache instead of project!"
  else
    pass "Plugin cache config not polluted"
  fi
fi

# Test 3: Hooks work
log ""
log "=== TEST 3: Hook enforcement ==="
RESULT=$(run_claude "Run exactly this command: git rebase -i HEAD~3" 3)
REBASE_RESULT=$(echo "$RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('result','').lower()[:300])")

if echo "$REBASE_RESULT" | grep -qiE "block|denied|not allowed|rebase"; then
  pass "git rebase blocked by hook"
else
  fail "git rebase was NOT blocked"
  log "  Result: $REBASE_RESULT"
fi

# Summary
log ""
log "================================"
log "Results: $PASSES passed, $FAILURES failed"
if [ "$FAILURES" -gt 0 ]; then
  exit 1
fi
log "All tests passed."
