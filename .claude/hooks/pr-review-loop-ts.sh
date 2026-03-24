#!/bin/bash
# TS hook shim — resolves relative to kaizen repo root

source "$(dirname "$0")/lib/scope-guard.sh"
KAIZEN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec npx --prefix "$KAIZEN_DIR" tsx "$KAIZEN_DIR/src/hooks/$(basename "${BASH_SOURCE[0]}" .sh | sed 's/-ts$//' ).ts"
