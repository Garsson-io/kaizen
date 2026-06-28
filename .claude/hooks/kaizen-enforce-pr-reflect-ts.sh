#!/bin/bash
# TS hook shim — enforce-pr-reflect PreToolUse gate (kaizen #775)

source "$(dirname "$0")/lib/scope-guard.sh"
source "$(dirname "$0")/lib/run-tsx.sh" 2>/dev/null || { exit 0; }
run_tsx "$KAIZEN_DIR" "$KAIZEN_DIR/src/hooks/enforce-pr-reflect.ts"
