#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# search-before-file.sh — PreToolUse advisory hook (Issue #704)
#
# When an agent runs `gh issue create`, this hook automatically searches
# for similar open issues and shows matches. Advisory only (does not block).
#
# The agent sees potential duplicates BEFORE the issue is created, giving it
# a chance to abort and add a comment to an existing issue instead.
#
# Design decision: advisory (exit 0 with output) rather than blocking.
# Blocking would require an override mechanism and creates false positives.
# Advisory gives the agent information to make a good decision.

source "$(dirname "$0")/lib/parse-command.sh" 2>/dev/null || { exit 0; }

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if [ -z "$COMMAND" ]; then
  exit 0
fi

source "$(dirname "$0")/lib/scope-guard.sh"

CMD_LINE=$(strip_heredoc_body "$COMMAND")

# Only trigger on `gh issue create` commands
# Use segment splitting to avoid matching gh issue create inside strings
is_issue_create() {
  local cmd="$1"
  echo "$cmd" | sed 's/[|;&]\{1,\}/\n/g' | sed 's/^[[:space:]]*//' | \
    grep -qE '^gh[[:space:]]+issue[[:space:]]+create'
}

if ! is_issue_create "$CMD_LINE"; then
  exit 0
fi

# Extract --title value from the command
# Handles: --title "foo bar", --title 'foo bar', -t "foo bar"
extract_title() {
  local cmd="$1"
  local title=""
  # Try --title "..." or --title '...'
  title=$(echo "$cmd" | sed -n "s/.*--title[[:space:]]\{1,\}[\"']\([^\"']*\)[\"'].*/\1/p" | head -1)
  if [ -n "$title" ]; then
    echo "$title"
    return
  fi
  # Try -t "..." or -t '...'
  title=$(echo "$cmd" | sed -n "s/.*-t[[:space:]]\{1,\}[\"']\([^\"']*\)[\"'].*/\1/p" | head -1)
  if [ -n "$title" ]; then
    echo "$title"
    return
  fi
  # Try --title without quotes (single word)
  title=$(echo "$cmd" | sed -n 's/.*--title[[:space:]]\{1,\}\([^[:space:]-][^[:space:]]*\).*/\1/p' | head -1)
  echo "$title"
}

# Extract --repo value from the command
extract_repo() {
  local cmd="$1"
  echo "$cmd" | sed -n 's/.*--repo[[:space:]]\{1,\}\([^[:space:]]\{1,\}\).*/\1/p' | head -1
}

TITLE=$(extract_title "$CMD_LINE")
REPO=$(extract_repo "$CMD_LINE")

# If no title found, can't search — allow silently
if [ -z "$TITLE" ]; then
  exit 0
fi

# If no repo specified, try to detect from git remote
if [ -z "$REPO" ]; then
  REPO=$(git remote get-url origin 2>/dev/null | sed -n 's|.*github\.com[:/]\([^/]*/[^/.]*\).*|\1|p' | head -1)
fi

if [ -z "$REPO" ]; then
  exit 0
fi

# Search for similar open issues
# Strip common prefixes like "fix:", "feat:", "[L2]", "incident:", etc.
SEARCH_TERMS=$(echo "$TITLE" | \
  sed 's/^\[L[0-9]*\][[:space:]]*//' | \
  sed 's/^[a-z]*([^)]*)[[:space:]]*//' | \
  sed 's/^\(fix\|feat\|chore\|bug\|incident\|refactor\):[[:space:]]*//' | \
  sed 's/[^a-zA-Z0-9 ]/ /g' | \
  tr -s ' ' | \
  head -c 80)

if [ -z "$SEARCH_TERMS" ]; then
  exit 0
fi

# Run the search with a short timeout to avoid slowing down the hook
MATCHES=$(timeout 8 gh issue list --repo "$REPO" --state open \
  --search "$SEARCH_TERMS" \
  --json number,title,url \
  --jq '.[:5] | .[] | "#\(.number) \(.title)\n  \(.url)"' 2>/dev/null)

if [ -z "$MATCHES" ]; then
  # No matches — allow silently
  exit 0
fi

# Show matches as advisory output
cat <<EOF
DUPLICATE CHECK: Similar open issues found for "$TITLE":

$MATCHES

If any of these match your intent, consider:
  - Adding a comment to the existing issue instead of creating a new one
  - Linking this new issue to the existing one if they're related but distinct
EOF

# Advisory only — allow the command to proceed
exit 0
