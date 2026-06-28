#!/bin/bash
# TS hook shim — enforce-plan-stored PreToolUse gate (kaizen #1055)
# Blocks `gh pr create` without stored plan + test plan on the linked issue.
# Enforces I3 (stored test plan) and I8 (plan before implementation).

source "$(dirname "$0")/lib/scope-guard.sh"
source "$(dirname "$0")/lib/run-tsx.sh" 2>/dev/null || { exit 0; }
run_tsx "$KAIZEN_DIR" "$KAIZEN_DIR/src/hooks/enforce-plan-stored.ts"
