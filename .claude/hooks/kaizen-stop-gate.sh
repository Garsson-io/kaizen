#!/bin/bash
# Unified stop gate — thin wrapper around TypeScript (kaizen #775)
# Replaces: kaizen-enforce-pr-review-stop.sh, kaizen-enforce-reflect-stop.sh, kaizen-enforce-post-merge-stop.sh

source "$(dirname "$0")/lib/scope-guard.sh"
source "$(dirname "$0")/lib/run-tsx.sh" 2>/dev/null || { exit 0; }
run_tsx "$KAIZEN_DIR" "$KAIZEN_DIR/src/hooks/stop-gate.ts"
