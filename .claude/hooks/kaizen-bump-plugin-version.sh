#!/bin/bash
# kaizen-bump-plugin-version.sh — Auto-bump plugin version before PR creation
#
# PreToolUse(Bash) hook: detects `gh pr create` commands and bumps the
# patch version in .claude-plugin/plugin.json if it hasn't been bumped
# already in this branch.
#
# If the author already bumped minor/major, this hook skips (respects
# intentional version choices).
#
# Always exits 0 — advisory, never blocks.

source "$(dirname "$0")/lib/parse-command.sh"

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

[ "$TOOL_NAME" = "Bash" ] || exit 0

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
CMD_LINE=$(strip_heredoc_body "$COMMAND")

# Only trigger on gh pr create
is_gh_pr_command "$CMD_LINE" "create" || exit 0

# Resolve project root (works from worktrees and subdirectories)
PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
PLUGIN_JSON="$PROJECT_ROOT/.claude-plugin/plugin.json"
[ -f "$PLUGIN_JSON" ] || exit 0

# Compare version on current branch vs main
MAIN_VERSION=$(git show origin/main:.claude-plugin/plugin.json 2>/dev/null | jq -r '.version // "0.0.0"')
CURRENT_VERSION=$(jq -r '.version' "$PLUGIN_JSON")

if [ "$MAIN_VERSION" != "$CURRENT_VERSION" ]; then
  # Already bumped (author did minor/major, or previous auto-bump) — skip
  exit 0
fi

source "$(dirname "$0")/lib/scope-guard.sh"

# Auto-bump patch
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
NEW_VERSION="$MAJOR.$MINOR.$((PATCH + 1))"

jq --arg v "$NEW_VERSION" '.version = $v' "$PLUGIN_JSON" > "${PLUGIN_JSON}.tmp"
mv "${PLUGIN_JSON}.tmp" "$PLUGIN_JSON"

# Stage and commit
git add "$PLUGIN_JSON"
git commit -m "chore: bump plugin version to $NEW_VERSION

Auto-bumped by kaizen-bump-plugin-version hook." 2>/dev/null

cat <<EOF

Plugin version bumped: $CURRENT_VERSION -> $NEW_VERSION
   (Claude Code requires version bumps to deliver updates to users)

EOF

exit 0
