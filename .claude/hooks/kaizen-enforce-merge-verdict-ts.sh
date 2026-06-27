#!/bin/bash
# TS hook shim — enforce-merge-verdict PreToolUse gate (#1220 / #1227)
# Blocks `gh pr merge` when the PR's latest review round derived a FAIL verdict.

source "$(dirname "$0")/lib/scope-guard.sh"
source "$(dirname "$0")/lib/run-tsx.sh" 2>/dev/null || { exit 0; }
KAIZEN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
run_tsx "$KAIZEN_DIR" "$KAIZEN_DIR/src/hooks/enforce-merge-verdict.ts"
