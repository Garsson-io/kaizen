# Workflow Tasks Reference

Every kaizen skill creates tasks at start using TaskCreate. This gives the user visibility into progress and prepares the agent for all steps — including ones that come after the current skill.

> **Hook inventory:** See [`hook-catalog.md`](docs/hook-catalog.md) for the complete hook list, gate patterns, and TS migration status.

## Why every skill creates tasks

1. **Progress visibility** — the user sees what phase you're in
2. **No forgotten steps** — review, reflection, cleanup are pre-committed
3. **Handoff preparation** — tasks for follow-up skills are visible before they start
4. **Consistent behavior** — every skill works the same way

## How to use

Each skill's SKILL.md has a `## Workflow Tasks` section with the task list. When the skill starts:

1. Create ALL tasks from the list using TaskCreate
2. Mark each task `in_progress` when you start it
3. Mark each task `completed` when done
4. If a task doesn't apply (e.g., TDD for docs-only work), mark it `deleted` with a reason

For skills with ≤2 tasks, skip TaskCreate — it adds overhead without value.

## Task lists by skill

### /kaizen-write-plan (6 tasks)

| # | Task | Description |
|---|------|-------------|
| 1 | Collision detection | Check GitHub labels, open PRs, git log for existing work (PATH B ONLY) |
| 2 | Read artifacts | Read issue body + deep-dive artifacts (Path A) or issue body only (Path B) |
| 3 | Problem validation + incidents | Confirm problem exists, gather incidents with specific data (PATH B ONLY) |
| 4 | Scope + architecture | Assess implementation scope, architecture fitness, hypotheses |
| 5 | Form grounded plan | 5 steps → write plan → store-grounding |
| 6 | Admin approval | Plan coverage review, present to admin, get GO/NO-GO |

**Path A (from deep-dive):** skip tasks 1, 3 — deep-dive already ran collision detection and validated the problem.
**Path B (admin-specified):** run all 6 tasks.

**What comes next:**
- **GO → single PR:** `/kaizen-implement` — reads grounding, enters worktree, executes
- **GO → multi-PR:** `/kaizen-plan` first (breaks into sub-issues), then `/kaizen-implement` per sub-issue
- **Needs spec:** `/kaizen-prd` first, then back to write-plan
- **NO-GO:** Close with reason

### /kaizen-plan (5 tasks)

| # | Task | Description |
|---|------|-------------|
| 1 | Understand scope | Read spec end-to-end, list components, models, integration points |
| 2 | Decompose into PRs | Apply ordering (schema → infra → features → integration), find boundaries |
| 3 | Map dependencies | Build dependency table with phases, identify parallelism, critical path |
| 4 | Create GitHub sub-issues | Update epic with implementation plan, create thin sub-issues linked to epic |
| 5 | Validate plan | Every component has a home, no cycles, high-risk PRs are small, first phase has no deps |

**What comes next:** `/kaizen-implement` for sub-issue #1. Evaluate is already done — go directly to implementation. After each sub-issue PR merges, continue to next sub-issue (default: CONTINUE, not STOP).

### /kaizen-prd (5 tasks)

| # | Task | Description |
|---|------|-------------|
| 1 | Understand initiative | Ask about problem space, solution space, constraints, threat models |
| 2 | Iterative discovery | State understanding, ask pointed questions, repeat until model stable |
| 3 | Write spec document | 9-section spec in `docs/{name}-spec.md` or issue body |
| 4 | Create GitHub issue | Epic anchor issue with spec (issue-only) or pointer to spec file |
| 5 | Create docs-only PR | Branch + spec file + commit + PR (skip for issue-only PRDs) |

**What comes next:** `/kaizen-write-plan` (to form a grounded plan) or `/kaizen-plan` (to break into sub-issues), then `/kaizen-implement`.

### /kaizen-implement (11 tasks)

| # | Task | Description |
|---|------|-------------|
| 1 | Assess architecture/tooling fitness | Validate language, runtime, libraries, E2E harness. Re-examine spec freshness. |
| 2 | Write failing tests (TDD RED) | Express target invariants as tests. They must fail before implementation. |
| 3 | Implement (TDD GREEN) | Make failing tests pass with simplest correct change. Full test suite green. |
| 4 | Self-review: `/kaizen-review-pr` | Read `.claude/kaizen/review-criteria.md`. Check all dimensions (DRY, testability, tooling, security, failure modes). Cite findings with confidence 0-100. Drop < 75. |
| 0 | Read grounding + enter worktree | `retrieve-grounding #N` → read canonical plan. `EnterWorktree`. Post brief execution note via `store-plan`. |
| 1 | Assess architecture/tooling fitness | Validate language, runtime, libraries, E2E harness per grounding. |
| 2 | Write failing tests (TDD RED) | Express target invariants from grounding's test plan. Must fail before implementation. |
| 3 | Implement (TDD GREEN) | Make failing tests pass with simplest correct change. Full test suite green. |
| 4 | Push + create PR | Run `/kaizen-write-pr` to draft PR body (Story Spine), then `gh pr create`. Add `status:has-pr` label. |
| 5 | `/kaizen-review-pr` | Spawn review subagents for all dimensions. Classify MUST-FIX / SHOULD-FIX. Store findings. |
| 6 | Review fix loop (max 3 rounds) | Fix findings → commit → push → re-run review. Repeat until clean or escalate. |
| 7 | Wait for CI | `gh pr checks` — watch for failures, fix and push if needed. |
| 8 | Merge (squash via GitHub) | `gh pr merge --squash` — merges on origin side. Then `git pull` in main to sync local. Verify PR state is "merged". |
| 9 | Kaizen reflection | Launch kaizen-bg subagent with session impediments. Wait for KAIZEN_IMPEDIMENTS to clear gate. |
| 10 | Cleanup | `ExitWorktree remove` — verify branch deleted, issue closed. No dirty files, no abandoned worktrees. |

**Disciplines (enforced):**
- **One PR at a time** — implement is called with a single issue/sub-issue number.
- **No dirty files** — every changed file committed and pushed before ExitWorktree.
- **No abandoned worktrees** — ExitWorktree always called, even on failure.
- **EnterWorktree only** — not `claude-wt` (that's a shell alias for interactive use).

**Hooks that fire during implementation:**
- **PreToolUse(Edit/Write):** `enforce-case-exists` (blocks edits without case), `enforce-worktree-writes` (blocks edits in main checkout)
- **PreToolUse(Bash):** `pr-quality-checks` (warns on source commits without tests, checks verification, practices, code quality), `check-dirty-files` (blocks push with dirty files), `block-git-rebase`
- **PostToolUse(Bash):** `pr-review-loop` (initiates review after PR create), `reflect` (prompts for reflection)
- **Stop:** `stop-gate.ts` (unified gate — blocks stop with any pending gate: review, reflection, post-merge), `verify-before-stop` (reminds about tsc + vitest)

**Adapt the list:** Not every task applies. Docs-only PRs skip TDD (#2-3). But the default is ALL tasks — delete explicitly with a reason, don't silently skip.

### /kaizen-review-pr (4 tasks)

| # | Task | Description |
|---|------|-------------|
| 1 | Gather context | Load review criteria from `.claude/kaizen/review-criteria.md`, read full diff, read linked issues, scan failure modes |
| 2 | Review (subagents or sequential) | Small PR (≤50 lines): sequential single-agent. Medium (50-300): 2-3 agents. Large (>300): 5 parallel agents (DRY, testability, tooling, security, horizons). |
| 3 | Filter and classify findings | Drop confidence < 75. MUST-FIX ≥ 90 (blocks merge). SHOULD-FIX 75-89 (fix before merge). |
| 4 | Fix loop (max 3 rounds) | Fix each finding, commit+push, re-review from task #1. Repeat until clean or 3 rounds. |

**Hooks enforcing review:**
- `pr-review-loop-ts.sh` — state machine tracking review rounds
- `enforce-pr-review-ts.sh` → `enforce-pr-review.ts` — blocks non-review commands during review
- `kaizen-stop-gate.sh` → `stop-gate.ts` — unified stop gate (blocks stop with any pending gate)

**What comes next:** After review is clean → merge. After merge → `/kaizen-reflect` is mandatory (stop hook blocks without it).

### /kaizen-reflect (5 tasks)

| # | Task | Description |
|---|------|-------------|
| 1 | Reflect on work | Review what happened: impediments, friction, what slowed down, what went well |
| 2 | Identify impediments | Be specific (exact moment, not category). Group by shared root cause if 2+ share one. |
| 3 | Classify enforcement level | L1 (instructions), L2 (hooks), L2.5 (MCP tools), L3 (mechanistic). Apply escalation rules. |
| 4 | File issues / incidents | Search for duplicates first. Disposition: fixed-in-pr, filed, incident, or positive/no-action. No waivers. |
| 5 | Meta-reflection | 5-question ladder: specific friction → generalized → kaizen system change → self-improvement → mechanism. Post-cycle ultrathink. |

**What comes next:** Cleanup (worktree + branch deletion). If sub-issues remain from `/kaizen-plan`, loop back to `/kaizen-implement` for next sub-issue.

### /kaizen-deep-dive (6 tasks)

| # | Task | Description |
|---|------|-------------|
| 1 | WIP deconfliction | Map worktrees, cases, PRs. Build occupied/available domain map. Choose target from available. |
| 2 | Problem-space exploration (parallel agents) | Agent A: issue archaeology — what issues exist, what pattern. Agent B: code exploration — which components, boundaries, untested seams. |
| 3 | Find the category | Identify root cause pattern, compound fix. Write meta-issue body with Problem/RootCause/ConcreteBugs/CompoundFix/Scope. |
| 4 | Store metadata attachment | `store-metadata --issue {N}` with YAML: linked symptoms, priority, area, connected issues. |
| 5 | Validate against user request | Confirm meta-issue matches what was asked for. Adjust if needed. |
| 6 | Hand off to write-plan | Invoke `/kaizen-write-plan #N` (Path A — skip Phases 0-3, jump to Phase 4). |

**What comes next:** `/kaizen-write-plan #N` (Path A) — reads meta-issue body + metadata + connected issues in one call via `retrieve-deep-dive`.

### /kaizen-gaps (6 tasks)

| # | Task | Description |
|---|------|-------------|
| 1 | Gather landscape (parallel agents) | Agent A: issues + structure. Agent B: incidents + friction. |
| 2 | Cluster by root cause | Group issues with common roots. Identify clusters of 3+ (high-value for deep-dive). |
| 3 | Classify gaps | Testing gaps, tooling gaps, taxonomy/horizon gaps. Failure mode analysis (FM1-FM12). |
| 4 | Analyze concentration | Per-horizon: open issues, incidents, active work. Over/under-concentrated, orphaned. |
| 5 | Identify unnamed dimensions | Incident clusters not in existing horizons. Missing axes. Evaluate: new horizon vs axis vs feature. |
| 6 | Present actionable output | 3 lists: low-hanging fruit, feature PRD candidates, meta/horizon PRD candidates. Present to admin. |

**What comes next:** Low-hanging fruit → file issues → `/kaizen-write-plan`. Feature PRDs → `/kaizen-prd`. Meta/horizon PRDs → `/kaizen-prd` in horizon mode.

### /kaizen-audit-issues (5 tasks)

| # | Task | Description |
|---|------|-------------|
| 1 | Gather all open issues | Fetch up to 200 issues with labels, assignees, timestamps |
| 2 | Audit labels and epics | Find unlabeled issues, suggest labels. Check epic health: staleness, sub-issues, premature closures. |
| 3 | Audit incidents and density | Count incidents per issue. Flag high-incident issues without active work. |
| 4 | Audit horizons and staleness | Issues per horizon, concentration. Issues untouched 30+ days. |
| 5 | Produce report and offer fixes | Structured report. Offer to apply labels, reopen epics, file meta-incidents. |

**What comes next:** Findings feed into `/kaizen-gaps` for deeper analysis, or directly into `/kaizen-deep-dive` to fix high-incident issues.

### /kaizen-cleanup (3 tasks)

| # | Task | Description |
|---|------|-------------|
| 1 | Analyze state | List worktrees, branches, cases, Docker images, disk usage, staleness |
| 2 | Present dry-run | Show what would be removed. Wait for user confirmation. |
| 3 | Execute cleanup | Remove stale worktrees, merged branches, Docker prune, git gc, mark stale cases done |

**What comes next:** Nothing — standalone utility. Run periodically or when disk is full.

### /kaizen-wip (3 tasks)

| # | Task | Description |
|---|------|-------------|
| 1 | Scan worktrees and PRs | `git worktree list`, `gh pr list`, per-worktree status |
| 2 | Scan branches and cases | Unmerged branches, merged-not-deleted, active cases with issue links |
| 3 | Present summary | Concise table with recommendations (commit dirty, delete merged, etc.) |

**What comes next:** Pick up existing work via `/kaizen-implement`, or `/kaizen-deep-dive` to find new work.

### /kaizen-setup (4 tasks)

| # | Task | Description |
|---|------|-------------|
| 1 | Detect installation method | Plugin, submodule, or fresh install |
| 2 | Create config and policies | `kaizen.config.json` + `.claude/kaizen/policies-local.md` |
| 3 | Configure hooks/symlinks | Merge hook registrations (submodule) or skip (plugin). Symlinks for skills/agents. |
| 4 | Inject CLAUDE.md and verify | Add kaizen section to CLAUDE.md. Run verification script. |

**What comes next:** Nothing — standalone setup. Run `/kaizen-update` to pull future updates.

### /kaizen-update (3 tasks)

| # | Task | Description |
|---|------|-------------|
| 1 | Pull updates | `git submodule update --remote` or `git pull` |
| 2 | Install and re-setup | `npm install`, re-run symlinks/hooks (idempotent) |
| 3 | Show changelog | `git log --oneline -10`, report new skills |

**What comes next:** Nothing — standalone update.

### /kaizen-zen (no tasks)

Single step: print `.claude/kaizen/zen.md`. Too trivial for task tracking.

## Entry point decision tree

```
Want autonomous category fix?
  → /kaizen-deep-dive (finds root cause, creates meta-issue)
      → /kaizen-write-plan #N (Path A — skip Phases 0-3)

Have a specific issue number?
  → /kaizen-write-plan #N (Path B — full phases 0-6)

Plan approved by admin?
  → /kaizen-implement #N (reads grounding, enters worktree, executes)

Large work planned with sub-issues?
  → /kaizen-implement for sub-issue #1

Need to define the problem first?
  → /kaizen-prd (iterative discovery → spec)
      → /kaizen-write-plan #N

Want strategic analysis of the whole backlog?
  → /kaizen-gaps (finds patterns, recommends work)

Want to audit issue hygiene?
  → /kaizen-audit-issues (labels, epics, staleness)
```

## The full dev workflow sequence

```
/kaizen-deep-dive  →  /kaizen-write-plan  →  /kaizen-implement
    (6 tasks)              (6 tasks)              (11 tasks)
                                                      │
                           ┌──────────────────────────┘
                           ↓
                    retrieve-grounding #N → read canonical plan
                           ↓
                    EnterWorktree → isolated branch
                           ↓
                    store-plan (brief execution note)
                           ↓
                    TDD RED → GREEN
                           ↓
                    push + /kaizen-write-pr + gh pr create
                           ↓
                    /kaizen-review-pr  ←──────────────┐
                        (4 tasks)                     │ max 3 rounds
                           │                          │
                           ↓                          │
                    Fix MUST-FIX / SHOULD-FIX ────────┘
                           ↓
                    Wait for CI ← fix failures
                           ↓
                    gh pr merge --squash (on origin, pull clean)
                           ↓
                    ExitWorktree remove
                           ↓
                    /kaizen-reflect
                        (5 tasks)
                           ↓
                    Sub-issues remain? → loop to /kaizen-implement
                    Done? → session complete
```
