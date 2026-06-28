#!/bin/bash
# TS hook shim — consolidated PR quality advisory checks (kaizen #800)
# Replaces: kaizen-check-test-coverage.sh, kaizen-check-verification.sh,
#           kaizen-check-practices.sh, kaizen-warn-code-quality.sh

source "$(dirname "$0")/lib/scope-guard.sh"
source "$(dirname "$0")/lib/run-tsx.sh" 2>/dev/null || { exit 0; }
run_tsx "$KAIZEN_DIR" "$KAIZEN_DIR/src/hooks/pr-quality-checks.ts"
