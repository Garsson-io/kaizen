#!/bin/bash
# auto-dent-run — Thin wrapper for trampoline compatibility.
#
# The trampoline (auto-dent.sh) calls this script by path.
# This delegates to the TypeScript runner which has real-time
# stream-json observability.
#
# Usage: auto-dent-run.sh <state-file>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec npx tsx "$SCRIPT_DIR/auto-dent-run.ts" "$@"
