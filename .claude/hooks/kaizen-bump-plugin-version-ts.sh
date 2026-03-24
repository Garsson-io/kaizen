#!/bin/bash
# TS hook shim — bump-plugin-version PreToolUse hook (kaizen #775)

source "$(dirname "$0")/lib/scope-guard.sh"
KAIZEN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec npx --prefix "$KAIZEN_DIR" tsx "$KAIZEN_DIR/src/hooks/bump-plugin-version.ts"
