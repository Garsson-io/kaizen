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
# Non-blocking. Silent on success. Exits 0 even on write failure.

set -u
source "$(dirname "$0")/lib/resolve-kaizen-dir.sh" 2>/dev/null || exit 0

# Resolve tsx from the kaizen repo's node_modules, then fall back to npx.
# Stay silent if neither is available — this hook must never break startup.
TS="${KAIZEN_DIR}/scripts/kaizen-doctor.ts"
LOCAL_TSX="${KAIZEN_DIR}/node_modules/.bin/tsx"
if [ -x "${LOCAL_TSX}" ]; then
  "${LOCAL_TSX}" "${TS}" snapshot >/dev/null 2>&1 || true
elif command -v npx >/dev/null 2>&1; then
  npx --prefix "${KAIZEN_DIR}" tsx "${TS}" snapshot >/dev/null 2>&1 || true
fi
exit 0
