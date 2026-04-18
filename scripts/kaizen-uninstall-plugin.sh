#!/bin/bash
# kaizen-uninstall-plugin — idempotent uninstall of a Claude Code plugin.
#
# Usage:
#   scripts/kaizen-uninstall-plugin.sh               # uninstalls kaizen@kaizen
#   scripts/kaizen-uninstall-plugin.sh --plugin foo@bar
#   scripts/kaizen-uninstall-plugin.sh --home /tmp/fake-home   # for tests
#
# After uninstall, prints a loud "RESTART CLAUDE CODE NOW" banner. Mid-session
# changes to plugin state do NOT take effect until restart (see #1061).
#
# Safe to run multiple times — each step is idempotent.

set -euo pipefail

PLUGIN="kaizen@kaizen"
HOME_DIR="${HOME}"
PROJECT_ROOT="$(pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --plugin) PLUGIN="$2"; shift 2 ;;
    --home)   HOME_DIR="$2"; shift 2 ;;
    --project) PROJECT_ROOT="$2"; shift 2 ;;
    -h|--help)
      sed -n '1,12p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

SHORT_NAME="${PLUGIN%%@*}"
SETTINGS="${PROJECT_ROOT}/.claude/settings.json"
INSTALLED="${HOME_DIR}/.claude/plugins/installed_plugins.json"
CACHE_DIR="${HOME_DIR}/.claude/plugins/cache/${SHORT_NAME}"

step() { echo "→ $*"; }
ok()   { echo "  ✓ $*"; }
skip() { echo "  · $*"; }

# Step 1: remove enabledPlugins entry from project settings.json
step "clearing enabledPlugins[\"${PLUGIN}\"] from ${SETTINGS}"
if [[ -f "${SETTINGS}" ]]; then
  tmp="$(mktemp)"
  node -e "
    const fs=require('fs');
    const d=JSON.parse(fs.readFileSync('${SETTINGS}','utf-8'));
    let changed=false;
    if (d.enabledPlugins && d.enabledPlugins['${PLUGIN}'] !== undefined) {
      delete d.enabledPlugins['${PLUGIN}'];
      if (Object.keys(d.enabledPlugins).length===0) delete d.enabledPlugins;
      changed=true;
    }
    fs.writeFileSync('${tmp}', JSON.stringify(d,null,2));
    process.exit(changed?0:3);
  " && { mv "${tmp}" "${SETTINGS}"; ok "removed enabledPlugins entry"; } \
    || { rm -f "${tmp}"; skip "enabledPlugins entry already absent"; }
else
  skip "no ${SETTINGS}"
fi

# Step 2: remove installed_plugins.json record
step "clearing installed_plugins.json record for ${PLUGIN}"
if [[ -f "${INSTALLED}" ]]; then
  tmp="$(mktemp)"
  node -e "
    const fs=require('fs');
    const d=JSON.parse(fs.readFileSync('${INSTALLED}','utf-8'));
    let changed=false;
    if (d.plugins && d.plugins['${PLUGIN}'] !== undefined) {
      delete d.plugins['${PLUGIN}'];
      changed=true;
    }
    fs.writeFileSync('${tmp}', JSON.stringify(d,null,2));
    process.exit(changed?0:3);
  " && { mv "${tmp}" "${INSTALLED}"; ok "removed installed_plugins record"; } \
    || { rm -f "${tmp}"; skip "record already absent"; }
else
  skip "no ${INSTALLED}"
fi

# Step 3: remove cache dir — with prefix scope check
step "removing cache dir ${CACHE_DIR}"
EXPECTED_PREFIX="${HOME_DIR}/.claude/plugins/cache/"
if [[ -d "${CACHE_DIR}" ]]; then
  # Scope check: refuse if the resolved path doesn't live under the expected
  # prefix. Protects against --plugin containing path-traversal input.
  case "${CACHE_DIR}" in
    "${EXPECTED_PREFIX}"*) : ;;
    *) echo "REFUSED: ${CACHE_DIR} is outside ${EXPECTED_PREFIX}" >&2; exit 4 ;;
  esac
  rm -rf "${CACHE_DIR}"
  ok "cache dir removed"
else
  skip "cache dir already absent"
fi

# Step 4: npm install if project has package.json and node_modules missing
if [[ -f "${PROJECT_ROOT}/package.json" && ! -d "${PROJECT_ROOT}/node_modules" ]]; then
  step "running npm install (node_modules missing)"
  (cd "${PROJECT_ROOT}" && npm install --silent) && ok "npm install complete"
else
  skip "npm install not needed"
fi

# Step 5: loud banner. Exit after printing — caller reads banner and restarts.
cat <<'BANNER'

╔══════════════════════════════════════════════════════════════════════════════╗
║  RESTART CLAUDE CODE NOW                                                     ║
║                                                                              ║
║  Plugin hook registry is loaded at session start and is now stale.           ║
║  Mid-session plugin changes do NOT take effect until Claude Code restarts.   ║
║  Uninstall is INCOMPLETE until you restart.                                  ║
║                                                                              ║
║  See: https://github.com/Garsson-io/kaizen/issues/1061                       ║
╚══════════════════════════════════════════════════════════════════════════════╝

BANNER

exit 0
