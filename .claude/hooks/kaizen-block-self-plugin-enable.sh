#!/bin/bash
# kaizen-block-self-plugin-enable — PreToolUse Bash gate.
#
# Blocks `git commit` when the project's `.claude/settings.json` is
# staged with BOTH:
#   - `enabledPlugins["kaizen@kaizen"] = true`
#   - a `hooks` block (any hook entries)
#
# That's the #1061 dual-load state: plugin-system registers kaizen's
# hooks AND settings.json registers them directly → every hook fires
# twice, and if one source's files disappear mid-session the harness
# floods with "No stderr output" errors.
#
# Neither side alone is blocked — #1063's model explicitly wants
# `enabledPlugins["kaizen@kaizen"]` in the kaizen repo's own settings
# (it's the activation switch). What we guard is the *combination*
# that makes both registration paths active for the same hooks.

source "$(dirname "$0")/lib/parse-command.sh" 2>/dev/null || { exit 0; }
source "$(dirname "$0")/lib/input-utils.sh" 2>/dev/null || { exit 0; }
source "$(dirname "$0")/lib/hook-output.sh" 2>/dev/null || { exit 0; }
source "$(dirname "$0")/lib/hook-telemetry.sh" 2>/dev/null || true

read_hook_input
get_command

CMD_LINE=$(strip_heredoc_body "$COMMAND")
if ! split_command_segments "$CMD_LINE" | grep -qE '^git[[:space:]]+(-[A-Za-z][^[:space:]]*[[:space:]]+)*commit([[:space:]]|$)'; then
  exit 0
fi

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
SETTINGS="${REPO_ROOT}/.claude/settings.json"
[ -f "$SETTINGS" ] || exit 0

# Prefer staged content over working-tree.
STAGED=$(git show ":.claude/settings.json" 2>/dev/null) || STAGED=$(cat "$SETTINGS" 2>/dev/null)
[ -z "$STAGED" ] && exit 0

# Fast prefilter — enabledPlugins[kaizen@kaizen] must be present-and-true.
printf '%s\n' "$STAGED" | grep -q '"enabledPlugins"' || exit 0
printf '%s\n' "$STAGED" | grep -qE '"kaizen@kaizen"[[:space:]]*:[[:space:]]*true' || exit 0

# Must ALSO have a `hooks` block with at least one command entry. Parse with
# node so nested matcher arrays aren't mis-counted by grep.
HAS_HOOKS=$(node -e '
try {
  const d = JSON.parse(require("fs").readFileSync("/dev/stdin", "utf-8"));
  let n = 0;
  const walk = (x) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") {
      if (x.type === "command" && typeof x.command === "string") n++;
      for (const v of Object.values(x)) walk(v);
    }
  };
  walk(d.hooks ?? {});
  process.stdout.write(n > 0 ? "yes" : "no");
} catch { process.stdout.write("no"); }
' <<<"$STAGED" 2>/dev/null)

if [ "$HAS_HOOKS" = "yes" ]; then
  emit_deny "BLOCKED: .claude/settings.json contains BOTH enabledPlugins[\"kaizen@kaizen\"]=true AND a hooks block.

This is the #1061 dual-load footgun. The kaizen plugin will register every hook once,
and .claude/settings.json will register the same hooks again — every tool call fires
them twice, and any mid-session change to plugin state (uninstall, cache delete)
floods the harness with 'No stderr output' errors (#1063 is the structural fix).

Pick one:
  - enabledPlugins + NO hooks block   (recommended — what #1063 lands, single-source)
  - hooks block + NO enabledPlugins   (bypasses the plugin system, breaks dogfooding)

Then retry the commit.

Canonical source-of-truth rule: https://github.com/Garsson-io/kaizen/issues/1063"
fi

exit 0
