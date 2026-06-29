#!/bin/bash
# kaizen-session-snapshot — SessionStart hook.
#
# Writes ~/.claude/kaizen-snapshots/<project-hash>.json with sha256 hashes
# of restart-sensitive config files. kaizen-doctor's `restart-needed`
# check diffs live state against this snapshot.
#
# Delegates to scripts/kaizen-doctor.ts — the earlier pure-bash version
# interpolated the project path raw into a heredoc, producing invalid
# JSON on paths with quotes or newlines.
#
# Non-blocking. Silent on success. Exits 0 even on write/check failure.

set -u
source "$(dirname "$0")/lib/resolve-kaizen-dir.sh" 2>/dev/null || exit 0
source "$(dirname "$0")/lib/resolve-tsx-bin.sh" 2>/dev/null || exit 0

# Resolve tsx through the same shell contract used by TS hook shims. Stay
# fail-open if unavailable — this hook must never break startup — but do not
# shell through `npx ... 2>/dev/null`, which recreates #1131's empty-stderr
# diagnostic black hole.
TS="${KAIZEN_DIR}/scripts/kaizen-doctor.ts"
TSX_BIN="$(resolve_tsx_bin "$KAIZEN_DIR" || true)"
if [ -n "$TSX_BIN" ]; then
  "$TSX_BIN" "$TS" snapshot >/dev/null 2>&1 || true
  "$TSX_BIN" "$TS" hook-syntax --quiet || true
fi
exit 0
