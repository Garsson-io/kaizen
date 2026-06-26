#!/bin/bash
# Part of kAIzen Agent Control Flow — see .agents/kaizen/README.md
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

# Fix A (advisory) for #934/#939: warn when the .worktree-will-delete sentinel is present.
# worktree-du.ts writes this sentinel before calling git worktree remove, giving sessions
# a chance to notice the worktree is about to disappear.
# NOTE: A shell hook cannot change the Claude session's CWD — this is warning-only.
# Full re-anchoring (actual cd to main repo) requires Claude Code session support (#934).
if [ -f ".worktree-will-delete" ] 2>/dev/null; then
  MAIN_REPO_CANDIDATE=$(git rev-parse --show-toplevel 2>/dev/null || true)
  ANCHOR_MSG="${MAIN_REPO_CANDIDATE:+Consider moving to: $MAIN_REPO_CANDIDATE}"
  echo "kaizen-worktree-setup: ⚠️  Worktree marked for deletion — session CWD will become invalid. $ANCHOR_MSG" >&2
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

# Per-worktree kaizen.issue provisioning (#1111 advisory → #1113 mechanism).
# `kaizen.issue` is per-worktree state, but raw `git config kaizen.issue <N>` writes
# to the SHARED .git/config, so a fresh worktree starts with no binding of its own
# and inherits the previous run's value. This is the provisioning choke point.
#
# On a canonical case branch (`case/<date>-k<N>-*`) the branch token IS the
# authoritative issue, so we self-heal: bind it mechanically — no manual step,
# before the first edit. Writing --worktree scope only is concurrency-safe (it
# cannot clobber a sibling). On a tokenless branch (e.g. a `worktree-*` run
# worktree) there is nothing authoritative to derive from, so we fall back to the
# advisory warning when a leaked shared value would be inherited.
# Canonical logic + tests live in src/issue-binding.ts (selfHealBinding) — this is
# a fast bash mirror that avoids a node startup on every SessionStart.
WT_ISSUE=$(git config --worktree --get kaizen.issue 2>/dev/null || true)
if [ -z "$WT_ISSUE" ]; then
  CUR_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  BRANCH_TOKEN=$(printf '%s' "$CUR_BRANCH" | sed -n 's#^case/[0-9]\{6,\}-k\([0-9]\+\).*#\1#p')
  if [ -n "$BRANCH_TOKEN" ]; then
    # Authoritative source present — bind mechanically (L3 self-heal). The
    # worktree-scoped value wins the merged read, so this also overrides any
    # inherited (leaked) shared value.
    git config extensions.worktreeConfig true 2>/dev/null
    if git config --worktree kaizen.issue "$BRANCH_TOKEN" 2>/dev/null; then
      echo "kaizen-worktree-setup: 🔗 Auto-bound this worktree to #$BRANCH_TOKEN from its case branch (no manual step needed)." >&2
    else
      echo "kaizen-worktree-setup: ⚠️  Could not auto-bind kaizen.issue to #$BRANCH_TOKEN — bind manually: npx tsx src/cli-issue-binding.ts bind --issue $BRANCH_TOKEN" >&2
    fi
  else
    # Tokenless branch — nothing authoritative to bind to. Warn if a shared value
    # would leak in.
    MERGED_ISSUE=$(git config --get kaizen.issue 2>/dev/null || true)
    if [ -n "$MERGED_ISSUE" ]; then
      echo "kaizen-worktree-setup: ⚠️  Leaked kaizen.issue — this worktree inherits #$MERGED_ISSUE from shared config with no binding of its own." >&2
      echo "kaizen-worktree-setup:    Bind this worktree to its real issue: npx tsx src/cli-issue-binding.ts bind --issue <N>" >&2
    fi
  fi
fi

# Verify .githooks/pre-push presence (epic #1059, I-G).
# When a worktree is on a branch that doesn't have .githooks/ committed, git
# silently finds no hook and runs nothing. Surface the gap at session start.
if [ -f ".githooks/pre-push" ]; then
  if [ ! -x ".githooks/pre-push" ]; then
    echo "kaizen-worktree-setup: warning: .githooks/pre-push is not executable — review gate will not fire" >&2
  fi
else
  echo "kaizen-worktree-setup: warning: .githooks/pre-push not present on this branch — review gate will not fire (merge main or branch from origin/main)" >&2
fi

# Verify core.hooksPath is pointing at .githooks (epic #1059).
# The prepare script sets this on npm install, but worktrees may inherit an
# older value or have nothing set.
HOOKS_PATH=$(git config --get core.hooksPath 2>/dev/null || true)
if [ -z "$HOOKS_PATH" ] || [ "$HOOKS_PATH" != ".githooks" ]; then
  echo "kaizen-worktree-setup: hint: set 'git config core.hooksPath .githooks' (or 'npm install' to run prepare script)" >&2
fi

exit 0
