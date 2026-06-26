#!/bin/bash
# auto-dent — compatibility wrapper for the TypeScript batch runner.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec npx tsx "$SCRIPT_DIR/auto-dent.ts" "$@"
