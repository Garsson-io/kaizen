#!/bin/bash
# TS hook shim — session-cleanup SessionStart (kaizen #786)

source "$(dirname "$0")/lib/scope-guard.sh"
source "$(dirname "$0")/lib/run-tsx.sh" 2>/dev/null || { exit 0; }
run_tsx "$KAIZEN_DIR" "$KAIZEN_DIR/src/hooks/session-cleanup.ts"
