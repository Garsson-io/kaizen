#!/bin/bash
# Writes the freshness marker that allows TS hook shims to use dist/.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MARKER="$REPO_ROOT/dist/.kaizen-hook-build"

mkdir -p "$(dirname "$MARKER")"

{
  echo "# kaizen hook build freshness marker"
  echo "built_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "source_root=$REPO_ROOT/src"
} > "$MARKER"
