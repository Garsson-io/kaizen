#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# kaizen-worktree-setup.sh — SessionStart hook.
#
# Symlinks node_modules and dist from the main repo into a fresh worktree.
# Fixes: worktrees missing node_modules (MODULE_NOT_FOUND errors, 116MB waste
# per npm install) and dist (hook compilation failures). See kaizen #705.
#
# Runs only in worktrees (not main checkout). Idempotent — only symlinks when
# the artifact is absent. Copy-on-write safe: npm install / npm run build
# replace symlinks with real directories automatically.
#
# SessionStart hook — always exits 0 (advisory only, never blocks).

GIT_COMMON=$(git rev-parse --git-common-dir 2>/dev/null)

# Skip when running in the main checkout (git-common-dir points to .git directly)
[ "$GIT_COMMON" = ".git" ] && exit 0

# Resolve main repo root from the shared .git directory
MAIN_REPO=$(dirname "$GIT_COMMON")

for artifact in node_modules dist; do
  if [ ! -e "$artifact" ] && [ -e "$MAIN_REPO/$artifact" ]; then
    ln -s "$MAIN_REPO/$artifact" "$artifact"
  fi
done

exit 0
