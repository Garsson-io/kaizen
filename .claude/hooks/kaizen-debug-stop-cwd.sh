#!/bin/bash
# Temporary diagnostic hook — captures CWD during stop events.
# Remove after debugging stop hook "not found" errors.
LOG="/tmp/kaizen-stop-hook-debug.log"
{
  echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
  echo "CWD: $(pwd)"
  echo "DOLLAR_0: $0"
  echo "GIT_TOPLEVEL: $(git rev-parse --show-toplevel 2>/dev/null || echo NONE)"
  echo "HOOKS_DIR_EXISTS: $(test -d ./.claude/hooks && echo YES || echo NO)"
  echo "LS_CLAUDE: $(ls -d .claude 2>/dev/null || echo MISSING)"
  echo "---"
} >> "$LOG" 2>&1
exit 0
