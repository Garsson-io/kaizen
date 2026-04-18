#!/bin/bash
# Thin shim → delegates to the TS implementation. Kept for backwards
# compatibility with docs/READMEs that reference the .sh path. See
# scripts/kaizen-uninstall-plugin.ts for the real logic (#1061 review
# found shell-injection and path-traversal risks in the earlier bash
# version).
set -eu
DIR="$(cd "$(dirname "$0")" && pwd)"
exec npx tsx "${DIR}/kaizen-uninstall-plugin.ts" "$@"
