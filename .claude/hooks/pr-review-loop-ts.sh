#!/bin/bash
# TS hook shim — resolves relative to kaizen repo root
# Trace: log hook invocation for debugging (kaizen #909)
echo "HOOK_FIRED pr-review-loop $(date +%s) cmd=${1:0:80}" >> /tmp/.pr-review-hook-trace.log 2>/dev/null

source "$(dirname "$0")/lib/scope-guard.sh"
KAIZEN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec npx --prefix "$KAIZEN_DIR" tsx "$KAIZEN_DIR/src/hooks/$(basename "${BASH_SOURCE[0]}" .sh | sed 's/-ts$//' ).ts"
