#!/usr/bin/env bash
# Kaizen host-project pre-push entry (installed by /kaizen-setup, epic #1059).
#
# This script lives in the kaizen repo/plugin. pre-commit hosts invoke it as a
# remote-repo hook; husky/lefthook/raw/standalone hosts invoke it through the
# thin `.kaizen-hooks/pre-push` wrapper written by /kaizen-setup.
#
# Wrapper installs may pass CLAUDE_PLUGIN_ROOT or substitute a captured plugin
# path. Remote pre-commit installs run this file from pre-commit's own clone, so
# the entry also resolves the kaizen root relative to itself before falling back
# to the Claude plugin cache.

set -eu

# ── Agent-env gate ─────────────────────────────────────────────────────
# Exit silently for human-driven git operations. Only AI-agent sessions
# invoke kaizen's review gate. See epic #1059 "agent-only gating".
if [ -z "${CLAUDECODE:-}" ] && [ -z "${CLAUDE_PROJECT_DIR:-}" ] \
   && [ -z "${CODEX_CI:-}" ] \
   && [ -z "${CODEX_SESSION:-}" ] && [ -z "${KAIZEN_SESSION:-}" ]; then
  exit 0
fi

# ── Resolve kaizen plugin root ─────────────────────────────────────────
# Primary: env var at invocation time (Claude Code or the thin wrapper sets this).
KAIZEN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"

# Secondary: this script's repo checkout (remote pre-commit provider path).
# npm/pre-commit may invoke this through a bin symlink, so resolve symlinks
# before walking back to the package root.
SOURCE="${BASH_SOURCE[0]:-$0}"
while [ -L "$SOURCE" ]; do
  SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$SOURCE")" && pwd)
  TARGET=$(readlink "$SOURCE")
  case "$TARGET" in
    /*) SOURCE="$TARGET" ;;
    *) SOURCE="$SOURCE_DIR/$TARGET" ;;
  esac
done

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$SOURCE")" && pwd)
SELF_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
if [ ! -d "$KAIZEN_ROOT" ] && [ -f "$SELF_ROOT/.claude-plugin/plugin.json" ]; then
  KAIZEN_ROOT="$SELF_ROOT"
fi

# Tertiary: baked-in path from wrapper install time.
# kaizen-setup.ts substitutes __KAIZEN_PLUGIN_ROOT__ with the absolute path.
if [ ! -d "$KAIZEN_ROOT" ]; then
  KAIZEN_ROOT="__KAIZEN_PLUGIN_ROOT__"
fi

# Fallback 2: search the Claude plugin cache for kaizen.
if [ ! -d "$KAIZEN_ROOT" ]; then
  CACHE_ROOT="${HOME}/.claude/plugins/cache"
  if [ -d "$CACHE_ROOT" ]; then
    CANDIDATE=$(find "$CACHE_ROOT" -maxdepth 5 -name "plugin.json" -path "*kaizen*" 2>/dev/null | head -1 || true)
    if [ -n "$CANDIDATE" ]; then
      KAIZEN_ROOT=$(dirname "$(dirname "$CANDIDATE")")
    fi
  fi
fi

# If still not found, fail-open (do not block the push).
if [ ! -d "$KAIZEN_ROOT" ]; then
  echo "kaizen: plugin root not found; pre-push gate skipped" >&2
  exit 0
fi

HOOK_TS="$KAIZEN_ROOT/src/hooks/pre-push.ts"
if [ ! -f "$HOOK_TS" ]; then
  echo "kaizen: hook source missing at $HOOK_TS; pre-push gate skipped" >&2
  exit 0
fi

# ── Dispatch ───────────────────────────────────────────────────────────
if [ -x "$KAIZEN_ROOT/node_modules/.bin/tsx" ]; then
  exec "$KAIZEN_ROOT/node_modules/.bin/tsx" "$HOOK_TS" "$@"
fi

if command -v npx >/dev/null 2>&1; then
  exec npx --no-install tsx "$HOOK_TS" "$@"
fi

# No tsx available — fail-open.
echo "kaizen: tsx not found; pre-push gate skipped" >&2
exit 0
