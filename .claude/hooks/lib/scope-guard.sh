#!/bin/bash
# Part of kAIzen Agent Control Flow
# scope-guard.sh — Prevents double-firing when kaizen is installed at BOTH levels
#
# Problem: If kaizen@kaizen is in BOTH ~/.claude/settings.json (user level)
# AND the project has .claude-plugin/plugin.json (project level), every hook
# fires TWICE — doubling vitest/tsc processes and causing WSL OOM crashes.
#
# Fix: When CLAUDE_PLUGIN_ROOT is set (project-level plugin active), remove
# the redundant user-level entry. When only user-level exists (host projects),
# leave it alone — that's the intended install path.
#
# Design: auto-remove the bad setting and emit a warning to stderr (exit 0).
# Never block — blocking ALL tools creates an unescapable deadlock (#758).
#
# Usage (add to every hook, after fast-exit checks):
#   source "$(dirname "$0")/lib/scope-guard.sh"

_kaizen_scope_guard() {
  local user_settings="$HOME/.claude/settings.json"
  [ -f "$user_settings" ] || return 0

  # Only act when BOTH levels are active (double-install):
  # user-level (kaizen@kaizen in ~/.claude/settings.json) AND
  # project-level (.claude-plugin/plugin.json in the current project).
  # If the project doesn't have its own plugin.json, the user-level
  # install is the only source — don't remove it.
  local project_plugin="${CLAUDE_PROJECT_DIR:-.}/.claude-plugin/plugin.json"
  [ -f "$project_plugin" ] || return 0

  # Fast check: skip node if kaizen isn't even in user settings
  grep -q '"kaizen@kaizen"' "$user_settings" 2>/dev/null || return 0

  local is_user_level
  is_user_level=$(node -e "
try {
  const d = JSON.parse(require('fs').readFileSync('$user_settings', 'utf-8'));
  if (d.enabledPlugins && d.enabledPlugins['kaizen@kaizen'] === true) process.stdout.write('yes');
} catch {}
" 2>/dev/null)

  if [ "$is_user_level" = "yes" ]; then
    # Double-install detected: user-level + project-level.
    # Remove the user-level entry to prevent double-firing.
    local counter_file="${KAIZEN_SCOPE_GUARD_COUNTER:-/tmp/.kaizen-scope-guard-fix-attempts}"
    local attempts=0
    [ -f "$counter_file" ] && attempts=$(cat "$counter_file" 2>/dev/null || echo 0)

    if [ "$attempts" -ge 3 ]; then
      echo "[kaizen] WARNING: double kaizen install persists after 3 auto-fix attempts." >&2
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
[kaizen] WARNING: double kaizen install detected — removed user-level entry.

kaizen@kaizen was in both ~/.claude/settings.json (user level) and this
project's plugin.json (project level). This causes every hook to fire twice.

Auto-fixed: removed kaizen@kaizen from user-level settings.
The project-level plugin.json provides hooks for this project.
ERRMSG
    return 0
  fi
}

# Run the guard on source — no explicit call needed
_kaizen_scope_guard
