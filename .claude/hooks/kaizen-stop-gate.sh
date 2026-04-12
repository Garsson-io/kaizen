#!/bin/bash
# Unified stop gate — thin wrapper around TypeScript (kaizen #775)
# Replaces: kaizen-enforce-pr-review-stop.sh, kaizen-enforce-reflect-stop.sh, kaizen-enforce-post-merge-stop.sh

source "$(dirname "$0")/lib/scope-guard.sh"
source "$(dirname "$0")/lib/run-tsx.sh"
KAIZEN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
run_tsx "$KAIZEN_DIR" "$KAIZEN_DIR/src/hooks/stop-gate.ts"
