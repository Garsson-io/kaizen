#!/bin/bash
# Thin shim for contributor local hook development. Real logic lives in
# kaizen-dev-link.ts so path safety and state transitions are testable.
set -eu
DIR="$(cd "$(dirname "$0")" && pwd)"
exec npx tsx "${DIR}/kaizen-dev-link.ts" "$@"
