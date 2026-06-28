#!/bin/bash
# Integration tests for .githooks/pre-push (epic #1059).
#
# Exercises the real shell dispatcher: agent-env gate, fallback to node_modules/.bin/tsx,
# graceful exit when tsx is unavailable.
# INVARIANT UNDER TEST: wrapper short-circuits to exit 0 when no agent env is set;
# dispatches to TS when CLAUDECODE=1.
source "$(dirname "$0")/test-helpers.sh"

WRAPPER="$(cd "$(dirname "$0")/../../.." && pwd)/.githooks/pre-push"
if [ ! -x "$WRAPPER" ]; then
  echo "SKIP: wrapper not found at $WRAPPER"
  exit 0
fi

# The wrapper calls `git rev-parse --show-toplevel` to find the repo root.
# When run outside the kaizen worktree (from a fresh tmp dir), it may fail.
# Run each test from the repo root so rev-parse succeeds.
cd "$(dirname "$WRAPPER")/.." || { echo "cd failed"; exit 1; }

echo "=== Without any agent env var → exits 0 silently (I-A) ==="
OUTPUT=$(env -i HOME="$HOME" PATH="$PATH" bash "$WRAPPER" < /dev/null 2>&1)
EXIT=$?
if [ "$EXIT" = "0" ]; then
  echo "  PASS: wrapper exited 0"
  ((PASS++))
else
  echo "  FAIL: wrapper exited $EXIT"
  echo "  output: $OUTPUT"
  ((FAIL++))
fi
if [ -z "$OUTPUT" ]; then
  echo "  PASS: wrapper produced no output (silent short-circuit)"
  ((PASS++))
else
  echo "  FAIL: wrapper produced output when no agent env set"
  echo "  output: $OUTPUT"
  ((FAIL++))
fi

echo ""
echo "=== With CLAUDECODE=1 → dispatches to TS hook (trace written) ==="
TRACE_FILE="/tmp/.kaizen-pre-push-wrapper-test-$$.jsonl"
rm -f "$TRACE_FILE"
# Send no refs on stdin → no branches being pushed → decision is allow_silent.
# The point of this test is that the wrapper invokes the TS hook and a trace
# entry is written.
CLAUDECODE=1 KAIZEN_HOOK_TRACE="$TRACE_FILE" bash "$WRAPPER" < /dev/null > /dev/null 2>&1
EXIT=$?
if [ "$EXIT" = "0" ]; then
  echo "  PASS: wrapper exited 0 with agent env + no merged blocker"
  ((PASS++))
else
  echo "  FAIL: wrapper exited $EXIT (expected 0 for allow_silent)"
  ((FAIL++))
fi
if [ -f "$TRACE_FILE" ] && grep -q '"hook":"pre-push"' "$TRACE_FILE"; then
  echo "  PASS: trace JSONL emitted (TS hook dispatched)"
  ((PASS++))
else
  echo "  FAIL: no trace entry with agent env — dispatcher did not invoke TS"
  echo "  trace contents:"
  cat "$TRACE_FILE" 2>/dev/null || echo "  (trace file does not exist)"
  ((FAIL++))
fi
rm -f "$TRACE_FILE"

echo ""
echo "=== With CODEX_CI=1 → also dispatches (Codex tool-call env, #1536) ==="
TRACE_FILE="/tmp/.kaizen-pre-push-wrapper-test-$$.jsonl"
rm -f "$TRACE_FILE"
CODEX_CI=1 KAIZEN_HOOK_TRACE="$TRACE_FILE" bash "$WRAPPER" < /dev/null > /dev/null 2>&1
if [ -f "$TRACE_FILE" ] && grep -q '"hook":"pre-push"' "$TRACE_FILE"; then
  echo "  PASS: CODEX_CI triggers TS dispatch"
  ((PASS++))
else
  echo "  FAIL: CODEX_CI did not trigger dispatch"
  ((FAIL++))
fi
rm -f "$TRACE_FILE"

echo ""
echo "=== With CODEX_SESSION=1 → also dispatches (agent env var allowlist) ==="
TRACE_FILE="/tmp/.kaizen-pre-push-wrapper-test-$$.jsonl"
rm -f "$TRACE_FILE"
CODEX_SESSION=1 KAIZEN_HOOK_TRACE="$TRACE_FILE" bash "$WRAPPER" < /dev/null > /dev/null 2>&1
if [ -f "$TRACE_FILE" ] && grep -q '"hook":"pre-push"' "$TRACE_FILE"; then
  echo "  PASS: CODEX_SESSION triggers TS dispatch"
  ((PASS++))
else
  echo "  FAIL: CODEX_SESSION did not trigger dispatch"
  ((FAIL++))
fi
rm -f "$TRACE_FILE"

echo ""
echo "=== Outside a git repo → exits 0 without error ==="
TMPDIR_TEST=$(mktemp -d)
cd "$TMPDIR_TEST" || exit 1
OUTPUT=$(CLAUDECODE=1 bash "$WRAPPER" < /dev/null 2>&1)
EXIT=$?
if [ "$EXIT" = "0" ]; then
  echo "  PASS: wrapper exits 0 outside a git repo (no rev-parse failure)"
  ((PASS++))
else
  echo "  FAIL: wrapper exit $EXIT outside git repo"
  echo "  output: $OUTPUT"
  ((FAIL++))
fi
cd - > /dev/null
rm -rf "$TMPDIR_TEST"

echo ""
echo "Total: PASS=$PASS FAIL=$FAIL"
exit $FAIL
