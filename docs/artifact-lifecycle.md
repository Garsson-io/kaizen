# Artifact Lifecycle — From Issue to Merged PR and Back

Every step in the kaizen workflow produces artifacts. Every review dimension consumes artifacts. If an artifact isn't persisted, it can't be reviewed — and if it can't be reviewed, it can be wrong without anyone knowing.

## Placement Rules

| Location | What goes here | Why | Examples |
|----------|---------------|-----|---------|
| **Repo (committed)** | Tooling that outlasts any session | Shared, versioned, evolves over time | Skills, hooks, dimension prompts, source code, docs, zen.md |
| **Issue tracker** | Per-issue work artifacts | Discoverable, attached to issues, survives crashes, plugin-safe | Plans, evaluations, reflections, incident reports |
| **PR** | Per-PR artifacts | Final record of the work, visible to reviewers | PR description (Story Spine), review findings (comments) |
| **Session-local (gitignored)** | Temp state within a session | Not worth versioning, cleaned up with worktree | Review state machine, fix logs, cached fetches |

**The repo is for tooling, not work artifacts.** Kaizen never commits per-issue files to the host repo (plugin mode).

## Complete Artifact Table

| Artifact | Created by | Persisted at | Consumed by (immediate) | Re-reviewed by (periodic) | Resilience |
|----------|-----------|-------------|------------------------|--------------------------|------------|
| **Issue** | Human, auto-dent explore, kaizen-file-issue, kaizen-reflect | GitHub Issues | kaizen-write-plan, plan-coverage dimension | kaizen-audit-issues (label health, staleness), kaizen-gaps (pattern clusters) | Permanent. Survives everything. |
| **Grounding** (`<!-- kaizen:grounding -->`) | kaizen-write-plan Phase 5 | Issue comment (attachment marker) | kaizen-implement Step 0 (`retrieve-grounding`); review dims needing full plan | kaizen-audit-issues (do planned issues have grounding?) | Survives session crash — stored before implementation starts. Never overwritten — write-plan is sole writer. |
| **Plan** (`<!-- kaizen:plan -->`) | kaizen-implement Step 0 | Issue comment (attachment marker) | review-battery.ts `retrievePlan()` — all review dimensions, plan-fidelity | (not re-reviewed) | Brief execution note: "confirmed grounding #N, high-priority dims: X, Y". Implement is sole writer. |
| **Code + Tests** | kaizen-implement steps 2-4 | Git (branch, commits) | All code dimensions (logic, error-handling, dry, test-quality, scope-fidelity), CI | git log, git blame, future kaizen-deep-dive investigating patterns | Survives crash if committed. Uncommitted work lost with worktree — but plan on issue lets next session rebuild. |
| **Review findings** | kaizen-review-pr subagents | PR comment (primary), session state `.claude/reviews/pr-N.json` (transient) | Fix loop, human reviewer, merge decision | kaizen-gaps (what do reviews keep catching? → improve skills/hooks), auto-dent batch analysis (review_verdict in run metrics) | PR comment survives everything. Session state lost on crash — but review is cheap to re-run ($0.13/dimension). |
| **PR description** | kaizen-write-pr | GitHub PR body | pr-description dimension, human reviewer | kaizen-audit-issues (do PRs tell stories?), future agents reading PR for context | Permanent once posted. Updated via `gh pr edit`. |
| **CI results** | GitHub Actions | GitHub Checks | Merge decision | CI history analysis | Permanent. |
| **Reflection** | kaizen-reflect | New GitHub Issues + session log | kaizen-deep-dive (next work selection), kaizen-gaps (pattern analysis) | kaizen-audit-issues (are reflections producing actionable issues?) | New issues are permanent. Session log available if session ID known. |

## The Recursive Loops

Artifacts don't just flow forward (issue → plan → code → review → merge). They feed BACK:

```
                    ┌──────────────────────────────────────────┐
                    │                                          │
                    ▼                                          │
ISSUE ──→ PLAN ──→ CODE ──→ REVIEW ──→ PR ──→ MERGE ──→ REFLECT
  ▲         │        │         │        │                   │
  │         │        │         │        │                   │
  │         ▼        ▼         ▼        ▼                   │
  │    plan-coverage  logic   review   pr-description       │
  │    plan-fidelity  dry     findings  dimension           │
  │    test-plan      error   coverage                      │
  │                   test-q  gate                          │
  │                                                         │
  └─────────────── NEW ISSUES ◄─────────────────────────────┘
                        │
                        ▼
              ┌─────────────────┐
              │ TOOLING EVOLVES │
              │ dimensions      │
              │ skills          │
              │ hooks           │
              │ zen.md          │
              └─────────────────┘
```

### Loop 1: Reflection → New Issues → New Work
kaizen-reflect produces impediments → filed as new issues → surfaced by kaizen-deep-dive → planned by kaizen-write-plan → worked on by kaizen-implement → reflected on again. This is the core improvement cycle.

### Loop 2: Review Findings → Dimension Improvement
Review findings reveal patterns: "the logic-correctness dimension keeps missing async errors" → update the dimension prompt → future reviews are better. The dimensions are living documents.

### Loop 3: Audit → Tooling Updates
kaizen-audit-issues and kaizen-gaps periodically scan all issues, PRs, and review findings for patterns: "30% of PRs have scope-fidelity PARTIAL findings about unrequested refactors" → update kaizen-implement instructions → agents refactor less → scope-fidelity pass rate improves.

### Loop 4: Zen Evolution
Session learnings produce new principles (e.g., "The diff is proof. The description is the argument." from this session) → added to zen.md → all skills reference zen.md → agent behavior changes → new learnings → new principles.

## Tooling Artifacts (committed, evolving)

These live in the repo and evolve based on the recursive loops above:

| Artifact | Location | Created by | Updated by | How it improves |
|----------|----------|-----------|-----------|-----------------|
| **Dimension prompts** | `prompts/review-*.md` | kaizen-implement (this session) | Any session that finds false positives/negatives | FP/FN data from review findings → adjust prompt → re-test on known PRs |
| **Skills** | `.claude/skills/*/SKILL.md` | kaizen-prd → kaizen-implement | kaizen-reflect, kaizen-deep-dive | Impediments from reflections → skill updates (e.g., this session added Story Spine to implement) |
| **Hooks** | `.claude/hooks/`, `src/hooks/` | kaizen-implement | Escalation from L1→L2 | When instructions fail repeatedly → build hook enforcement |
| **Review criteria** | `.claude/kaizen/review-criteria.md` | Manual | kaizen-review-pr (adds FM-N patterns) | Each review that catches a new failure mode → new learned pattern |
| **Zen principles** | `.claude/kaizen/zen.md` | Aviad + Claude | Session learnings | Non-obvious insights from sessions → new principles with provenance |
| **This document** | `docs/artifact-lifecycle.md` | This session | Future sessions | As the process evolves, artifact locations and flows may change |

## Observability

How to inspect the state of each artifact type:

| Question | How to answer |
|----------|--------------|
| Which open issues have no plan? | `gh issue list --state open` → check each for plan comment |
| Which PRs have no review findings? | `gh pr list --state open` → check each for review battery comment |
| What dimensions keep finding gaps? | Parse review battery PR comments across a batch → aggregate by dimension |
| Which dimensions have high false positive rates? | Compare findings against human review decisions (merged despite MISSING?) |
| Are reflections producing actionable issues? | `kaizen-audit-issues` → check issues filed by reflect vs issues actually worked on |
| Is the plan-to-PR fidelity improving? | Track plan-fidelity pass rate across batches |

## Resilience Analysis

What happens when things fail:

| Failure | What's lost | What survives | Recovery |
|---------|------------|---------------|----------|
| Session crash mid-planning | Nothing — plan posted as issue comment first | Plan, issue, evaluation | Next session reads plan from issue, continues |
| Session crash mid-implementation | Uncommitted code | Plan (issue comment), committed code, tests | Next session reads plan, picks up from last commit |
| Session crash mid-review | Session review state | PR exists, code committed | Re-run review ($0.13/dimension, cheap) |
| Worktree deleted | Session-local state (`.claude/reviews/`) | All GitHub artifacts (issues, PRs, comments) | Create new worktree, everything on GitHub is intact |
| GitHub outage | Can't read issue/PR | Local code, git history | Wait for GitHub, retry |

**Design principle**: every artifact that matters is on GitHub (issues, PRs, comments). Session-local state is always recomputable. The most expensive thing to lose is uncommitted code — commit early, commit often.

## Dogfood vs Plugin Mode

| Artifact | Dogfood (`KAIZEN_REPO == HOST_REPO`) | Plugin (`KAIZEN_REPO != HOST_REPO`) |
|----------|--------------------------------------|-------------------------------------|
| Issue | `gh issue` on kaizen repo | `gh issue` on `$ISSUES_REPO` (may be kaizen or host) |
| Plan (issue comment) | Comment on kaizen issue | Comment on `$ISSUES_REPO` issue |
| Attachment (named marker comment) | Comment on kaizen issue/PR | Comment on `$ISSUES_REPO` issue or `$HOST_REPO` PR |
| Code + PR | PR on kaizen repo | PR on `$HOST_REPO` |
| Review findings | PR comment on kaizen repo | PR comment on `$HOST_REPO` |
| Dimension prompts | `prompts/` in kaizen repo | `prompts/` in kaizen repo (plugin provides) |
| Skills | `.claude/skills/` in kaizen repo | Installed by `kaizen-setup` into host |
| Session state | Gitignored in kaizen worktree | Gitignored in host worktree |

**Key rule**: kaizen never commits per-issue/per-PR files to ANY repo. Per-issue → issue tracker. Per-PR → PR. Per-session → gitignored temp.

## Data Categories for Dimensions

Each dimension declares `needs:` in frontmatter. How subagents access each:

| Data need | Source artifact | How to access | Persistence |
|-----------|---------------|--------------|-------------|
| `diff` | Code changes | `gh pr diff <url>` | Git (permanent) |
| `issue` | Issue body | `gh issue view <N> --json body` | GitHub (permanent) |
| `pr` | PR metadata + body | `gh pr view <url> --json body` | GitHub (permanent) |
| `grounding` | Grounding (canonical plan from write-plan) | `npx tsx src/cli-structured-data.ts retrieve-grounding --issue <N> --repo "$ISSUES_REPO"` | GitHub (permanent) |
| `plan` | Plan (brief execution note from implement) | `npx tsx src/cli-structured-data.ts retrieve-plan --issue <N> --repo "$ISSUES_REPO"` | GitHub (permanent) |
| `attachment` | Named machine-readable data on issue/PR (plans, metadata, review findings) | `npx tsx src/cli-section-editor.ts read-attachment --issue <N> --repo "$ISSUES_REPO" --name <name>` or `list-attachments` | GitHub (permanent — issue/PR comments with `<!-- kaizen:<name> -->` marker) |
| `tests` | Test output | `npm test` or test files in diff | Ephemeral (re-runnable) |
| `codebase` | Existing code | `grep`, `glob` on repo | Git (permanent) |
| `session` | Session transcript | JSONL log file | Session-local (available if session ID known) |
| `git-history` | Commits, blame | `git log`, `git blame` | Git (permanent) |
