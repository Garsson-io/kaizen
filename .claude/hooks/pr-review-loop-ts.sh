#!/bin/bash
# TS hook shim — resolves relative to kaizen repo root

source "$(dirname "$0")/lib/scope-guard.sh"
source "$(dirname "$0")/lib/run-tsx.sh" 2>/dev/null || { exit 0; }
run_tsx "$KAIZEN_DIR" "$KAIZEN_DIR/src/hooks/$(basename "${BASH_SOURCE[0]}" .sh | sed 's/-ts$//').ts"
