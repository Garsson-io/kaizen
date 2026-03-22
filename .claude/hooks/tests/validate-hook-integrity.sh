#!/bin/bash
# validate-hook-integrity.sh — Validate hook file integrity
#
# Extracts all hook `command` paths from settings.json and plugin.json,
# verifies each file exists and has valid bash syntax.
#
# Usage:
#   bash validate-hook-integrity.sh [project-root]
#
# Exit 0 = all valid, 1 = errors found

set -u

PROJECT_ROOT="${1:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

ERRORS=0
CHECKED=0

validate_file() {
  local json_file="$1"
  local label="$2"
  local prefix="${3:-}"

  if [ ! -f "$json_file" ]; then
    return 0
  fi

  local commands
  commands=$(jq -r '.. | .command? // empty' "$json_file" | sort -u)

  while IFS= read -r cmd; do
    [ -z "$cmd" ] && continue

    # Resolve ${CLAUDE_PLUGIN_ROOT} to project root for plugin.json
    local resolved="${cmd//\$\{CLAUDE_PLUGIN_ROOT\}/${prefix}}"

    # Make relative paths absolute
    if [[ "$resolved" == ./* ]]; then
      resolved="$PROJECT_ROOT/${resolved#./}"
    fi

    ((CHECKED++))

    if [ ! -f "$resolved" ]; then
      echo "::error::[$label] Missing hook file: $cmd (resolved: $resolved)"
      ((ERRORS++))
      continue
    fi

    if ! bash -n "$resolved" 2>/tmp/hook-syntax-err; then
      echo "::error::[$label] Syntax error in $cmd:"
      cat /tmp/hook-syntax-err
      ((ERRORS++))
      continue
    fi

    echo "  OK: $cmd"
  done <<< "$commands"
}

echo "Validating hook integrity in $PROJECT_ROOT"
echo ""

echo "--- settings.json ---"
validate_file "$PROJECT_ROOT/.claude/settings.json" "settings.json"

echo ""
echo "--- plugin.json ---"
validate_file "$PROJECT_ROOT/.claude-plugin/plugin.json" "plugin.json" "."

echo ""
echo "Checked $CHECKED hook commands, $ERRORS errors."

if [ "$ERRORS" -gt 0 ]; then
  exit 1
fi
exit 0
