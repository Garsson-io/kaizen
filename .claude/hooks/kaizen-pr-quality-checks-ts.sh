#!/bin/bash
# TS hook shim — consolidated PR quality advisory checks (kaizen #800)
# Replaces: kaizen-check-test-coverage.sh, kaizen-check-verification.sh,
#           kaizen-check-practices.sh, kaizen-warn-code-quality.sh

source "$(dirname "$0")/lib/scope-guard.sh"
KAIZEN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec npx --prefix "$KAIZEN_DIR" tsx "$KAIZEN_DIR/src/hooks/pr-quality-checks.ts"
