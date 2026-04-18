#!/bin/bash
# kaizen-block-self-plugin-enable — PreToolUse Bash gate.
#
# Blocks `git commit` when .claude/settings.json is staged and contains
# enabledPlugins["kaizen@kaizen"]. Rationale (#1061): kaizen is its own
# plugin AND its own project; shipping the self-enable flag causes the
# same hooks to register twice, and on every tool call hook errors flood
# the harness with "No stderr output" messages.
#
# Narrow by design — only this exact key in this exact file.

source "$(dirname "$0")/lib/parse-command.sh" 2>/dev/null || { exit 0; }
source "$(dirname "$0")/lib/input-utils.sh" 2>/dev/null || { exit 0; }
source "$(dirname "$0")/lib/hook-output.sh" 2>/dev/null || { exit 0; }

read_hook_input
get_command

# Only gate on `git commit` commands. Split by pipe/chain operators so
# phrases like `echo "not a git commit"` don't false-positive.
CMD_LINE=$(strip_heredoc_body "$COMMAND")
if ! printf '%s\n' "$CMD_LINE" | sed 's/[|;&]\{1,\}/\n/g' | sed 's/^[[:space:]]*//' | \
     grep -qE '^git[[:space:]]+(-[A-Za-z][^[:space:]]*[[:space:]]+)*commit([[:space:]]|$)'; then
  exit 0
fi

# Find repo root of current cwd.
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
SETTINGS="${REPO_ROOT}/.claude/settings.json"
[ -f "$SETTINGS" ] || exit 0

# Check staged content of .claude/settings.json (fall back to working-tree copy).
STAGED=$(git show ":.claude/settings.json" 2>/dev/null) || STAGED=$(cat "$SETTINGS" 2>/dev/null)
[ -z "$STAGED" ] && exit 0

# Narrow match — enabledPlugins block with kaizen@kaizen key. Tolerate
# surrounding whitespace and trailing comma/boolean variations.
if printf '%s\n' "$STAGED" | grep -q '"enabledPlugins"' && \
   printf '%s\n' "$STAGED" | grep -qE '"kaizen@kaizen"[[:space:]]*:[[:space:]]*true'; then
  emit_deny "BLOCKED: .claude/settings.json contains enabledPlugins[\"kaizen@kaizen\"] = true.

This is the #1061 self-dogfood footgun. kaizen is both a plugin and its own
project — enabling itself as a plugin causes every hook to register twice
(once from plugin.json, once from the project's own settings.json hooks),
and the plugin-cache copies fail silently with 'No stderr output' errors
that flood every tool call.

Fix:
  scripts/kaizen-uninstall-plugin.sh   # removes enabledPlugins + cache
  git add .claude/settings.json
  git commit ...                        # retry

Then RESTART Claude Code (the in-memory hook registry needs a fresh session)."
fi

exit 0
