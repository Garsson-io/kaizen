# Artifact Lifecycle — From Issue to Merged PR

Every step in the kaizen workflow produces artifacts. Every review dimension consumes artifacts. If an artifact isn't persisted, it can't be reviewed — and if it can't be reviewed, it can be wrong without anyone knowing.

## The Artifact Chain

```
ISSUE (problem)
  ↓ created by: human, auto-dent, kaizen-file-issue
  ↓ persisted: GitHub Issues
  ↓ consumed by: evaluate, plan-coverage

EVALUATION (go/no-go + scope)
  ↓ created by: kaizen-evaluate
  ↓ persisted: issue comment
  ↓ consumed by: implement (scope decisions)

PLAN (solution approach + testing strategy)
  ↓ created by: kaizen-implement step 1
  ↓ persisted: .claude/plans/issue-N.md (during session)
  ↓            → PR description (after PR creation)
  ↓ consumed by: plan-coverage, plan-fidelity, test-plan dimensions

CODE + TESTS
  ↓ created by: kaizen-implement steps 2-4 (TDD RED → GREEN)
  ↓ persisted: Git (branch, commits)
  ↓ consumed by: all code dimensions (logic, error-handling, dry, test-quality)

REVIEW FINDINGS
  ↓ created by: kaizen-review-pr (subagent dimensions)
  ↓ persisted: .claude/reviews/pr-N.json (during session)
  ↓            → PR comment (after review)
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

## Artifact Formats

### Plan (.claude/plans/issue-N.md)

Created at session start, BEFORE any code is written. This is the first deliverable.

```markdown
# Plan: <issue title>

Issue: #N
Created: <timestamp>

## Approach
What to build and how. Key architectural decisions.

## Testing Strategy
- Pyramid levels needed: [unit | integration | E2E]
- SUT (System Under Test): what component is the focus
- Key invariants to test
- For bug fixes: what category of bug to prevent

## Scope
- What's in this PR
- What's deferred (with mechanism: follow-up issue number)

## Risk Assessment
- Which review dimensions matter most for this PR
- What could go wrong
```

The plan is reviewed by `plan-coverage` (does it address the issue?) before implementation starts. After PR creation, the plan content flows into the PR description (Architecture + Test Plan sections).

### Review Findings (.claude/reviews/pr-N.json)

Created during review, updated after each subagent returns.

```json
{
  "pr_url": "https://github.com/.../pull/N",
  "issue_num": "N",
  "timestamp": "2026-03-25T...",
  "dimensions_expected": ["requirements", "logic-correctness", ...],
  "dimensions_completed": ["requirements"],
  "findings": [
    {
      "dimension": "requirements",
      "status": "DONE",
      "requirement": "...",
      "detail": "..."
    }
  ],
  "coverage_complete": false,
  "fix_rounds": 0
}
```

Updated incrementally as subagents return. Coverage gate checks `dimensions_completed` against `dimensions_expected`. After review passes, a summary is posted as a PR comment.

## Persistence Principle

**Every artifact that a review dimension reads must be persisted to disk.** If it only exists in the agent's context window, it will be lost on crash, compaction, or session end. The persistence locations:

| Artifact | During session | After PR creation |
|----------|---------------|-------------------|
| Plan | `.claude/plans/issue-N.md` | PR description |
| Test plan | Part of plan file | PR description "Test Plan" section |
| Review findings | `.claude/reviews/pr-N.json` | PR comment |
| Review briefing | Ephemeral (computed) | N/A (cheap to recompute) |
| Code + tests | Git working tree | Git (committed) |
| Evaluation | Issue comment | Issue comment |

## Who Creates What

| Skill | Artifact | Must persist before proceeding |
|-------|----------|-------------------------------|
| kaizen-evaluate | Evaluation (GO/NO-GO) | Issue comment |
| kaizen-implement step 1 | Plan + Test Plan | `.claude/plans/issue-N.md` |
| kaizen-implement step 1 | Review briefing | Ephemeral (logged to console) |
| kaizen-implement steps 2-4 | Code + Tests | Git commit |
| kaizen-review-pr | Dimension findings | `.claude/reviews/pr-N.json` |
| kaizen-write-pr | PR description | GitHub PR body |
| kaizen-reflect | Impediments | GitHub Issues |

## Data Categories for Dimensions

Each dimension declares `needs:` in its frontmatter. These map to artifacts:

| Data need | Artifact | How subagent accesses it |
|-----------|----------|------------------------|
| `diff` | Code changes | `gh pr diff <url>` |
| `issue` | Issue (problem) | `gh issue view <N>` |
| `pr` | PR metadata + description | `gh pr view <url>` |
| `plan` | Plan artifact | `.claude/plans/issue-N.md` or PR description |
| `tests` | Test output | `npm test` or test files in diff |
| `codebase` | Existing code | `grep`, `glob` on repo |
| `session` | Session transcript | JSONL log file |
| `git-history` | Commit history | `git log`, `git blame` |
