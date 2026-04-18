#!/bin/bash
# TS hook shim — PreToolUse --no-verify blocker (epic #1059).
# Denies `git push --no-verify` to prevent agents from bypassing kaizen hooks.

source "$(dirname "$0")/lib/scope-guard.sh"
source "$(dirname "$0")/lib/run-tsx.sh" 2>/dev/null || { exit 0; }
KAIZEN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
run_tsx "$KAIZEN_DIR" "$KAIZEN_DIR/src/hooks/prehook-no-verify.ts"
