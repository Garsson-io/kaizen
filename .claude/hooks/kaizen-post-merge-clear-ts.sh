#!/bin/bash
# TS hook shim — post-merge-clear PostToolUse (kaizen #786)

source "$(dirname "$0")/lib/scope-guard.sh"
KAIZEN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec npx --prefix "$KAIZEN_DIR" tsx "$KAIZEN_DIR/src/hooks/post-merge-clear.ts" 2>/dev/null
