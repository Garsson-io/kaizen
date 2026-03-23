#!/bin/bash
# Part of kAIzen Agent Control Flow
# scope-guard.sh — Auto-fixes computer-level kaizen install (warns, never blocks)
#
# Computer-level installation (kaizen@kaizen in ~/.claude/settings.json enabledPlugins)
# causes all hooks to fire TWICE — once from the plugin registry, once from the project.
# This doubles vitest/tsc processes and causes WSL OOM crashes.
#
# Design: auto-remove the bad setting and emit a warning to stderr (exit 0).
# Never block — blocking ALL tools creates an unescapable deadlock (#758).
#
# Usage (add to every hook, after fast-exit checks):
#   source "$(dirname "$0")/lib/scope-guard.sh"

_kaizen_scope_guard() {
  local user_settings="$HOME/.claude/settings.json"
  [ -f "$user_settings" ] || return 0

  # Fast check: skip python if kaizen isn't even in the file
  grep -q '"kaizen@kaizen"' "$user_settings" 2>/dev/null || return 0

  local is_user_level
  is_user_level=$(python3 -c "
import json, sys
try:
    d = json.load(open('$user_settings'))
    if d.get('enabledPlugins', {}).get('kaizen@kaizen') is True:
        print('yes')
except Exception:
    pass
" 2>/dev/null)

  if [ "$is_user_level" = "yes" ]; then
    # Auto-fix: remove the bad setting rather than blocking (#758).
    # Blocking ALL tools creates an unescapable deadlock — the agent cannot
    # run the fix command because that command is also blocked.
    python3 -c "
import json, pathlib
p = pathlib.Path.home() / '.claude' / 'settings.json'
d = json.loads(p.read_text())
d.get('enabledPlugins', {}).pop('kaizen@kaizen', None)
p.write_text(json.dumps(d, indent=2))
" 2>/dev/null

    cat >&2 <<'ERRMSG'
[kaizen] WARNING: computer-level kaizen install detected and auto-removed.

kaizen@kaizen was in ~/.claude/settings.json enabledPlugins, which causes
every hook to fire twice and can crash WSL with OOM.

Auto-fixed: removed kaizen@kaizen from ~/.claude/settings.json.
Kaizen hooks are provided per-project via .claude-plugin/plugin.json.
ERRMSG
    # Return 0 — allow the tool call through. The bad setting is now gone.
    return 0
  fi
}

# Run the guard on source — no explicit call needed
_kaizen_scope_guard
