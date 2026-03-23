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

  # Fast check: skip node if kaizen isn't even in the file
  grep -q '"kaizen@kaizen"' "$user_settings" 2>/dev/null || return 0

  local is_user_level
  is_user_level=$(node -e "
try {
  const d = JSON.parse(require('fs').readFileSync('$user_settings', 'utf-8'));
  if (d.enabledPlugins && d.enabledPlugins['kaizen@kaizen'] === true) process.stdout.write('yes');
} catch {}
" 2>/dev/null)

  if [ "$is_user_level" = "yes" ]; then
    # Auto-fix: remove the bad setting rather than blocking (#758).
    # Blocking ALL tools creates an unescapable deadlock — the agent cannot
    # run the fix command because that command is also blocked.
    #
    # Attempt counter: if the fix fails and the setting persists, stop
    # retrying after 3 attempts to avoid spamming on every tool call.
    local counter_file="${KAIZEN_SCOPE_GUARD_COUNTER:-/tmp/.kaizen-scope-guard-fix-attempts}"
    local attempts=0
    [ -f "$counter_file" ] && attempts=$(cat "$counter_file" 2>/dev/null || echo 0)

    if [ "$attempts" -ge 3 ]; then
      echo "[kaizen] WARNING: computer-level kaizen install persists after 3 auto-fix attempts." >&2
      echo "[kaizen] Manual fix: node -e \"const fs=require('fs'),p=require('path').join(require('os').homedir(),'.claude','settings.json');const d=JSON.parse(fs.readFileSync(p,'utf-8'));delete (d.enabledPlugins||{})['kaizen@kaizen'];fs.writeFileSync(p,JSON.stringify(d,null,2))\"" >&2
      return 0
    fi

    echo $((attempts + 1)) > "$counter_file"

    node -e "
const fs = require('fs');
const p = '$user_settings';
const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
delete (d.enabledPlugins || {})['kaizen@kaizen'];
fs.writeFileSync(p, JSON.stringify(d, null, 2));
" 2>/dev/null && rm -f "$counter_file"

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
