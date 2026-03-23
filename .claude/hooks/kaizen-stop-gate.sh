#!/bin/bash
# Unified stop gate — thin wrapper around TypeScript (kaizen #775)
# Replaces: kaizen-enforce-pr-review-stop.sh, kaizen-enforce-reflect-stop.sh, kaizen-enforce-post-merge-stop.sh

source "$(dirname "$0")/lib/scope-guard.sh"
KAIZEN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec npx --prefix "$KAIZEN_DIR" tsx "$KAIZEN_DIR/src/hooks/stop-gate.ts" 2>/dev/null
