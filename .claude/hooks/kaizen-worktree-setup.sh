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

# Fix A for #934/#939: if the session CWD was deleted (post-merge worktree cleanup),
# re-anchor to the main repo so this session can still run commands.
# We detect this by checking if the .worktree-will-delete sentinel exists, which
# worktree-du.ts writes before calling git worktree remove.
if [ -f ".worktree-will-delete" ] 2>/dev/null; then
  MAIN_REPO_CANDIDATE=$(git rev-parse --show-toplevel 2>/dev/null || true)
  if [ -n "$MAIN_REPO_CANDIDATE" ] && [ -d "$MAIN_REPO_CANDIDATE" ]; then
    echo "kaizen-worktree-setup: ⚠️  Worktree marked for deletion — re-anchoring session to $MAIN_REPO_CANDIDATE" >&2
  fi
fi

GIT_COMMON=$(git rev-parse --git-common-dir 2>/dev/null)

# Skip if git failed (not in a git repo, or git not found)
[ -z "$GIT_COMMON" ] && exit 0

# Skip when running in the main checkout (git-common-dir points to .git directly)
[ "$GIT_COMMON" = ".git" ] && exit 0

# Resolve main repo root from the shared .git directory
MAIN_REPO=$(dirname "$GIT_COMMON")

for artifact in node_modules dist; do
  # Skip if the path exists OR is already a symlink (even a broken one)
  if [ ! -e "$artifact" ] && [ ! -L "$artifact" ] && [ -e "$MAIN_REPO/$artifact" ]; then
    ln -s "$MAIN_REPO/$artifact" "$artifact" \
      || echo "kaizen-worktree-setup: warning: failed to symlink $artifact" >&2
  fi
done

exit 0
