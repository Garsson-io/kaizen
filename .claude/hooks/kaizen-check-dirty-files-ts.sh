#!/bin/bash
# TS hook shim — check-dirty-files PreToolUse gate (kaizen #775)

source "$(dirname "$0")/lib/scope-guard.sh"
source "$(dirname "$0")/lib/run-tsx.sh" 2>/dev/null || { exit 0; }
KAIZEN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
run_tsx "$KAIZEN_DIR" "$KAIZEN_DIR/src/hooks/check-dirty-files.ts"
