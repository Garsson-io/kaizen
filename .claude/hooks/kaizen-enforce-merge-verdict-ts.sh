#!/bin/bash
# TS hook shim — enforce direct merge verdict binding (#1220).

source "$(dirname "$0")/lib/scope-guard.sh"
source "$(dirname "$0")/lib/run-tsx.sh" 2>/dev/null || { exit 0; }
run_tsx "$KAIZEN_DIR" "$KAIZEN_DIR/src/hooks/enforce-merge-verdict.ts"
