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

    local syntax_err
    syntax_err=$(mktemp)
    if ! bash -n "$resolved" 2>"$syntax_err"; then
      echo "::error::[$label] Syntax error in $cmd:"
      cat "$syntax_err"
      rm -f "$syntax_err"
      ((ERRORS++))
      continue
    fi
    rm -f "$syntax_err"

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
echo "--- Lint: heavy subprocesses in accumulating hooks (kaizen #475, #474) ---"
# Stop and PostToolUse hooks run on EVERY tool call. Heavy commands
# (vitest, tsc, npm test) in these positions cause OOM cascades.
# Only check actual hook scripts, not test files.
HOOKS_DIR="$PROJECT_ROOT/.claude/hooks"
if [ -d "$HOOKS_DIR" ]; then
  # Identify Stop and PostToolUse hooks from settings.json
  STOP_AND_POST_HOOKS=""
  if [ -f "$PROJECT_ROOT/.claude/settings.json" ]; then
    STOP_AND_POST_HOOKS=$(jq -r '
      (.hooks.Stop // [])[] | .command // empty,
      (.hooks.PostToolUse // [])[] | (.hooks // [])[] | .command // empty
    ' "$PROJECT_ROOT/.claude/settings.json" 2>/dev/null | sort -u)
  fi

  for cmd in $STOP_AND_POST_HOOKS; do
    local_path="$cmd"
    [[ "$local_path" == ./* ]] && local_path="$PROJECT_ROOT/${local_path#./}"
    [ -f "$local_path" ] || continue

    # Check for heavy subprocess invocations (not in comments)
    HEAVY=$(grep -nE '(vitest|jest|tsc |npm test|npm run test|npx tsx.*\.test\.)' "$local_path" \
      | grep -v '^\s*#' | grep -v 'grep' || true)
    if [ -n "$HEAVY" ]; then
      echo "::error::[lint] Heavy subprocess in accumulating hook $cmd:"
      echo "$HEAVY"
      ((ERRORS++))
    fi
  done
  echo "  Checked Stop/PostToolUse hooks for heavy subprocesses"
fi

echo ""
echo "--- Lint: unparenthesized regex alternation (kaizen #378) ---"
# Bash regex alternation without parens: [[ $x =~ foo|bar ]] matches
# "foo" OR (entire-expression "bar"), not "foo" or "bar".
# Must be: [[ $x =~ (foo|bar) ]]
if [ -d "$HOOKS_DIR" ]; then
  for f in "$HOOKS_DIR"/kaizen-*.sh "$HOOKS_DIR"/pr-*.sh; do
    [ -f "$f" ] || continue
    # Find [[ ... =~ ... | ... ]] without parens around alternation
    UNSAFE_REGEX=$(grep -nE '=~\s+[^(]*\|' "$f" \
      | grep -v '^\s*#' | grep -v '# ' || true)
    if [ -n "$UNSAFE_REGEX" ]; then
      echo "::error::[lint] Unparenthesized regex alternation in $(basename "$f"):"
      echo "$UNSAFE_REGEX"
      ((ERRORS++))
    fi
  done
  echo "  Checked hooks for unparenthesized regex alternation"
fi

echo ""
echo "--- Lint: unguarded source statements (kaizen #386) ---"
# All source calls to lib/ (except scope-guard.sh) must have error guards
# to prevent hook crashes from corrupted libraries (#371).
if [ -d "$HOOKS_DIR" ]; then
  for f in "$HOOKS_DIR"/kaizen-*.sh "$HOOKS_DIR"/pr-*.sh; do
    [ -f "$f" ] || continue
    UNGUARDED=$(grep -nE '^source .*/lib/' "$f" \
      | grep -v 'scope-guard' | grep -v '||' || true)
    if [ -n "$UNGUARDED" ]; then
      echo "::error::[lint] Unguarded source in $(basename "$f") — add '2>/dev/null || { exit 0; }':"
      echo "$UNGUARDED"
      ((ERRORS++))
    fi
  done
  echo "  Checked hooks for unguarded source statements"
fi

echo ""
echo "Checked $CHECKED hook commands, $ERRORS errors."

if [ "$ERRORS" -gt 0 ]; then
  exit 1
fi
exit 0
