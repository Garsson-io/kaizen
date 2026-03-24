#!/bin/bash
# TS hook shim — session-cleanup SessionStart (kaizen #786)

source "$(dirname "$0")/lib/scope-guard.sh"
KAIZEN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec npx --prefix "$KAIZEN_DIR" tsx "$KAIZEN_DIR/src/hooks/session-cleanup.ts" 2>/dev/null
