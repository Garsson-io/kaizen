#!/bin/bash
# TS hook shim — enforce-pr-reflect PreToolUse gate (kaizen #775)

source "$(dirname "$0")/lib/scope-guard.sh"
source "$(dirname "$0")/lib/run-tsx.sh"
KAIZEN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
run_tsx "$KAIZEN_DIR" "$KAIZEN_DIR/src/hooks/enforce-pr-reflect.ts"
