#!/bin/bash
# Part of kAIzen Agent Control Flow
# scope-guard.sh — Blocks hooks when kaizen is installed at computer level
#
# Computer-level installation (kaizen@kaizen in ~/.claude/settings.json enabledPlugins)
# causes all hooks to fire TWICE — once from the plugin registry, once from the project.
# This doubles vitest/tsc processes and causes WSL OOM crashes.
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
    cat >&2 <<'ERRMSG'
!! KAIZEN HOOK BLOCKED — computer-level install detected !!

kaizen@kaizen is in ~/.claude/settings.json enabledPlugins.
This causes EVERY hook to fire TWICE, doubling all vitest/tsc
processes. This has crashed WSL with OOM multiple times.

FIX: Remove the computer-level install:

  python3 -c "
import json, pathlib
p = pathlib.Path.home() / '.claude' / 'settings.json'
d = json.loads(p.read_text())
d.get('enabledPlugins', {}).pop('kaizen@kaizen', None)
p.write_text(json.dumps(d, indent=2))
print('Done: removed kaizen@kaizen from user-level settings')
"

Kaizen hooks are provided per-project by .claude-plugin/plugin.json
or by project-scoped installation via /kaizen-setup.
ERRMSG
    exit 2
  fi
}

# Run the guard on source — no explicit call needed
_kaizen_scope_guard
