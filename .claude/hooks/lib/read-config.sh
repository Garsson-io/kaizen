#!/bin/bash
# read-config.sh — Read kaizen.config.json from shell hooks
# Usage: source "$(dirname "${BASH_SOURCE[0]}")/lib/read-config.sh"
# Provides: KAIZEN_REPO, HOST_REPO, HOST_NAME, KAIZEN_CASE_CLI, KAIZEN_NOTIFICATION_CHANNEL

# Find project root by walking up from current directory
_find_project_root() {
  local dir="${CLAUDE_PROJECT_DIR:-$(pwd)}"
  while [ "$dir" != "/" ]; do
    [ -f "$dir/kaizen.config.json" ] && echo "$dir" && return 0
    dir="$(dirname "$dir")"
  done
  echo "${CLAUDE_PROJECT_DIR:-.}"
}

KAIZEN_PROJECT_ROOT="$(_find_project_root)"
KAIZEN_CONFIG="$KAIZEN_PROJECT_ROOT/kaizen.config.json"

if [ -f "$KAIZEN_CONFIG" ] && command -v jq &>/dev/null; then
  KAIZEN_REPO=$(jq -r '.kaizen.repo // "Garsson-io/kaizen"' "$KAIZEN_CONFIG")
  HOST_REPO=$(jq -r '.host.repo // ""' "$KAIZEN_CONFIG")
  HOST_NAME=$(jq -r '.host.name // ""' "$KAIZEN_CONFIG")
  KAIZEN_CASE_CLI=$(jq -r '.host.caseCli // ""' "$KAIZEN_CONFIG")
  KAIZEN_NOTIFICATION_CHANNEL=$(jq -r '.notifications.channel // "none"' "$KAIZEN_CONFIG")
else
  # Defaults when no config exists
  KAIZEN_REPO="Garsson-io/kaizen"
  HOST_REPO=""
  HOST_NAME=""
  KAIZEN_CASE_CLI=""
  KAIZEN_NOTIFICATION_CHANNEL="none"
fi
