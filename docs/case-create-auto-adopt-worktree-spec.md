# Case Creation Auto-Adopt Worktree — Specification

## 1. Problem Statement

Case systems that manage git worktrees often assume they are the sole worktree lifecycle manager. When `case_create` runs, it unconditionally creates a new git worktree — even when the caller is already inside one. This produces duplicate worktrees, orphaned branches, and requires manual cleanup.

**Manual flags** (like `--branch-name`/`--worktree-path`) let callers explicitly say "use this existing worktree." But this is a Level 1 fix — it shifts the burden to the caller. Every new tool that creates worktrees (Claude Code's `EnterWorktree`, future CI tools, other agents) would need to know about and pass these flags.

**The real fix:** case creation should auto-detect that it's already running inside a worktree and adopt it. The information is already available from git.

### Concrete incidents

| Date | What broke | Impact | Root cause |
|------|-----------|--------|------------|
| Session 1 | `case-create` from worktree created nested worktree | Multiple retry attempts + manual DB cleanup per case, orphaned worktrees | `createCaseWorkspace` unconditionally calls `git worktree add` |
| Session 1 | Same bug occurred twice in one session | ~15 min wasted total | No detection of "already in a worktree" |

## 2. Desired End State

When `case_create` is called from inside an existing worktree:
1. It detects that `process.cwd()` (or the equivalent) is a worktree, not the main checkout
2. It uses the current worktree path and branch name automatically
3. It does NOT create a new worktree
4. The case record is linked to the existing worktree

When `case_create` is called from the main checkout:
- Behavior is unchanged — it creates a new worktree as before

When explicit `--branch-name`/`--worktree-path` flags are passed:
- They take precedence over auto-detection

**Out of scope:**
- Worktree cleanup/lifecycle management (separate concern)
- Multi-case-per-worktree support (not needed)

## 3. Architecture

### Detection mechanism

Git provides everything needed:

```bash
# Are we in a worktree? Compare git-common-dir to the default .git
git rev-parse --git-common-dir   # /path/to/main/.git (always)
git rev-parse --show-toplevel    # /path/to/worktree (if in worktree)
git rev-parse --abbrev-ref HEAD  # current branch name
```

If `show-toplevel` is not a parent of `git-common-dir`, we're in a worktree. The worktree path is `show-toplevel`, the branch is `abbrev-ref HEAD`.

### Where detection runs

There are multiple entry points for case creation. Each needs different handling:

| Entry point | Runs where | Can use `process.cwd()` | Auto-detect approach |
|------------|-----------|------------------------|---------------------|
| CLI tool | Host, directly | Yes — the CLI runs in the caller's cwd | Detect at startup via git commands |
| IPC handler | Host, via service | No — service always runs from main checkout | Caller must pass flags |
| MCP tool | Remote | No — different git topology | Caller must pass flags |

**Key insight:** Auto-detection only makes sense for the CLI path. IPC and MCP callers don't share `process.cwd()` with the case creation logic — the service process runs from the main checkout regardless of where the requesting agent is.

### Implementation

In the CLI entry point, before workspace creation:

```typescript
// Auto-detect: if running from inside a worktree and no explicit flags,
// adopt the current worktree
if (!branchName && !worktreePath) {
  const detected = detectCurrentWorktree();
  if (detected) {
    resolved = deps.resolveWorktree(detected.worktreePath, detected.branchName);
  }
}
```

The `detectCurrentWorktree()` function:

```typescript
function detectCurrentWorktree(): { worktreePath: string; branchName: string } | null {
  try {
    const gitCommonDir = execSync('git rev-parse --git-common-dir', { encoding: 'utf-8' }).trim();
    const toplevel = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
    const mainRoot = path.dirname(path.resolve(gitCommonDir));

    // If toplevel equals main root, we're in the main checkout — no auto-adopt
    if (path.resolve(toplevel) === mainRoot) return null;

    const branchName = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
    return { worktreePath: toplevel, branchName };
  } catch {
    return null;
  }
}
```

This function belongs in the case management module or in a shared `git-paths` utility.

## 4. What Exists vs What Needs Building

### Already Solved

| Capability | Status |
|------------|--------|
| Manual worktree adoption via explicit flags | Done |
| Worktree path validation | Done |
| Fallback to new worktree when no existing one detected | Done |

### Needs Building

| Component | What | Why it doesn't exist yet |
|-----------|------|-------------------------|
| `detectCurrentWorktree()` | Git-based worktree detection function | Initial implementation focused on explicit flags, not auto-detection |
| CLI auto-adopt | Call detection before workspace creation | Same |
| Tests | Unit tests for detection (in worktree vs main checkout) | Same |

## 5. Open Questions

1. **Should auto-detect be on by default or opt-in?** The risk of auto-detecting is that someone running `case-create` from a worktree that belongs to a *different* case might accidentally link to the wrong worktree. Mitigation: check if the worktree already has an active case linked to it, and if so, don't auto-adopt (treat it as "occupied"). Lean: on by default with the occupied-check guard.

2. **Should this live in the case module or a shared `git-paths` utility?** A shared `git-paths` utility is a natural fit. But it could ship in the case module now and move later. Lean: ship in place now, refactor when the utility is built.

3. **What about a `--new-worktree` escape hatch?** If auto-detection causes surprises, callers need a way to force new worktree creation. A `--new-worktree` flag would explicitly bypass detection. Lean: add it, default off.
