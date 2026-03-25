# Artifact Lifecycle — From Issue to Merged PR

Every step in the kaizen workflow produces artifacts. Every review dimension consumes artifacts. If an artifact isn't persisted, it can't be reviewed — and if it can't be reviewed, it can be wrong without anyone knowing.

## Where Things Live

| Location | What goes here | Why |
|----------|---------------|-----|
| **Repo (committed)** | Tooling: skills, hooks, dimension prompts, source code, docs | Outlasts any single session. Shared. Versioned. |
| **Issue tracker (GitHub)** | Per-issue artifacts: plans, evaluations, reflections | Discoverable. Attached to issues. Survives session crashes. Works in plugin mode. |
| **PR (GitHub)** | Per-PR artifacts: description (solution story), review findings | The final record. Review comments visible to humans. |
| **Session-local (gitignored)** | Temp state: review state machine, fix logs, cached data | Within-session only. Not committed. Cleaned up with worktree. |

**The repo is for tooling, not work artifacts.** Plans, findings, and evaluations are per-issue/per-PR — they belong in the issue tracker, not the codebase. This is especially important in **plugin mode** where kaizen should never commit files to the host repo.

## The Artifact Chain

```
ISSUE (problem)
  ↓ created by: human, auto-dent, kaizen-file-issue
  ↓ persisted: GitHub Issues
  ↓ consumed by: evaluate, plan-coverage

EVALUATION (go/no-go + scope)
  ↓ created by: kaizen-evaluate
  ↓ persisted: issue comment (gh issue comment N --body "...")
  ↓ consumed by: implement (scope decisions)

PLAN (solution approach + testing strategy)
  ↓ created by: kaizen-implement step 1
  ↓ persisted: issue comment (primary) + session cache (for dimension access)
  ↓            → absorbed into PR description after PR creation
  ↓ consumed by: plan-coverage, plan-fidelity, test-plan dimensions

CODE + TESTS
  ↓ created by: kaizen-implement steps 2-4 (TDD RED → GREEN)
  ↓ persisted: Git (branch, commits)
  ↓ consumed by: all code dimensions (logic, error-handling, dry, test-quality)

REVIEW FINDINGS
  ↓ created by: kaizen-review-pr (subagent dimensions)
  ↓ persisted: PR comment (primary) + session state (for fix loop)
  ↓ consumed by: fix loop, human reviewer

PR DESCRIPTION (solution story)
  ↓ created by: kaizen-write-pr
  ↓ persisted: GitHub PR body
  ↓ consumed by: pr-description dimension, human reviewer

REFLECTION (impediments + lessons)
  ↓ created by: kaizen-reflect
  ↓ persisted: GitHub Issues, session log
  ↓ consumed by: future sessions, kaizen-pick
```

## Plan Format

Posted as an **issue comment** before any code is written. This is the first deliverable.

```markdown
## Implementation Plan

**Approach**: What to build and how. Key architectural decisions. Why this approach.

**Testing Strategy**:
- Pyramid levels: [unit | integration | E2E] — which and why
- SUT: what component is the focus
- Invariants: what must ALWAYS be true
- For bug fixes: what category of bug to prevent

**Scope**:
- In this PR: [concrete list]
- Deferred: [with mechanism — follow-up issue #N]

**Risk Assessment**:
- High-priority dimensions for this PR (from high_when signals)
- Suggested review subagent grouping
```

The plan lives in three places across its lifecycle:
1. **Issue comment** — posted immediately, persistent, discoverable (primary)
2. **Session cache** — dimension subagents read it during review (transient)
3. **PR description** — absorbed into Story Spine narrative after PR creation (final)

## Review Findings Format

Posted as a **PR comment** after each review round.

```markdown
## Review Battery: Round N

| Dimension | Status | Findings |
|-----------|--------|----------|
| requirements | PASS | 4 DONE |
| logic-correctness | FAIL | 1 MISSING: off-by-one in parser |
| ... | ... | ... |

Coverage: 10/10 dimensions reviewed
Overall: FAIL (2 MISSING findings)
```

Session state (fix loop tracking, which dimensions completed) lives in gitignored temp:
- `.claude/reviews/pr-N.json` — not committed, cleaned up with worktree

## Session-Local State (gitignored)

These files exist during a session and are NOT committed:

| File | Purpose | Cleaned up |
|------|---------|-----------|
| `.claude/reviews/pr-N.json` | Review state machine (coverage tracking, fix rounds) | With worktree |
| `.claude/reviews/pr-N-fix-round*.log` | Fix session logs | With worktree |
| `.claude/review-fix/` | review-fix CLI state | With worktree |

Add to `.gitignore`:
```
.claude/reviews/
.claude/review-fix/
```

## Data Categories for Dimensions

Each dimension declares `needs:` in frontmatter. How subagents access each:

| Data need | Source artifact | How to access |
|-----------|---------------|--------------|
| `diff` | Code changes | `gh pr diff <url>` |
| `issue` | Issue (problem) | `gh issue view <N> --json body` |
| `pr` | PR metadata | `gh pr view <url> --json body` |
| `plan` | Plan (issue comment) | `gh issue view <N> --json comments` → find plan comment |
| `tests` | Test output | `npm test` or test files in diff |
| `codebase` | Existing code | `grep`, `glob` on repo |
| `session` | Session transcript | JSONL log file (session-local) |
| `git-history` | Commits, blame | `git log`, `git blame` |

## Dogfood vs Plugin Mode

| Artifact | Dogfood (kaizen repo) | Plugin (host repo) |
|----------|----------------------|-------------------|
| Plan | Issue comment on `$KAIZEN_REPO` | Issue comment on `$ISSUES_REPO` |
| Review findings | PR comment on `$KAIZEN_REPO` | PR comment on `$HOST_REPO` |
| Session state | Gitignored in worktree | Gitignored in worktree |
| Dimension prompts | `prompts/` in kaizen repo | `prompts/` in kaizen repo (plugin provides them) |
| Skills | `.claude/skills/` in kaizen repo | Installed by kaizen-setup |

**Key rule**: kaizen never commits per-issue/per-PR artifacts to the host repo. Everything per-issue goes to the issue tracker. Everything per-session goes to gitignored temp.
