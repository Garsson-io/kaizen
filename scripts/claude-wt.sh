#!/usr/bin/env bash
# claude-wt — Thin wrapper, delegates to TypeScript implementation.
# Install as alias: alias claude-wt='/path/to/kaizen/scripts/claude-wt.sh'
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/tsx-exec.sh"
tsx_exec claude-wt "$@"
