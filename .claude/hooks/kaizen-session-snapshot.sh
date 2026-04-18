#!/bin/bash
# kaizen-session-snapshot — SessionStart hook.
#
# Writes ~/.claude/kaizen-snapshots/<project-hash>.json containing sha256
# hashes of restart-sensitive config files. kaizen-doctor's
# `restart-needed` check diffs the live state against this snapshot to
# tell the agent "Claude Code needs a restart" when mid-session changes
# have drifted the on-disk state (see #1061).
#
# Non-blocking. Silent on success. Exits 0 even on write failure — this
# hook must never interrupt a session.

set -u
PROJECT_ROOT="$(pwd)"
HOME_DIR="${HOME}"
SNAP_DIR="${HOME_DIR}/.claude/kaizen-snapshots"

mkdir -p "${SNAP_DIR}" 2>/dev/null || exit 0

# sha256 of project root path — 16 hex chars, stable per project
HASH=$(printf '%s' "${PROJECT_ROOT}" | sha256sum 2>/dev/null | cut -c1-16)
[ -z "${HASH}" ] && exit 0
SNAP_FILE="${SNAP_DIR}/${HASH}.json"

hash_file() {
  if [ -f "$1" ]; then
    sha256sum "$1" 2>/dev/null | awk '{print $1}'
  else
    echo "null"
  fi
}

# Files whose content, if changed mid-session, requires a Claude Code
# restart. settings.json is intentionally excluded — inline hook entries
# hot-reload; enabledPlugins drift is caught by kaizen-doctor's other checks.
H_PLUGIN=$(hash_file "${PROJECT_ROOT}/.claude-plugin/plugin.json")
H_INSTALLED=$(hash_file "${HOME_DIR}/.claude/plugins/installed_plugins.json")
H_MARKETS=$(hash_file "${HOME_DIR}/.claude/plugins/known_marketplaces.json")

quote() {
  # Emit "null" literal (unquoted) if arg is the string "null", else quote it.
  if [ "$1" = "null" ]; then echo "null"; else echo "\"$1\""; fi
}

TS=$(date -Iseconds 2>/dev/null || date)

cat > "${SNAP_FILE}" <<EOF
{
  "ts": "${TS}",
  "project": "${PROJECT_ROOT}",
  "hashes": {
    "project-plugin-manifest": $(quote "${H_PLUGIN}"),
    "installed-plugins": $(quote "${H_INSTALLED}"),
    "known-marketplaces": $(quote "${H_MARKETS}")
  }
}
EOF

exit 0
