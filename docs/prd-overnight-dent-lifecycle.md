# PRD: Overnight-Dent Lifecycle Manager

**Issue:** TBD
**Author:** Claude (autonomous)
**Date:** 2026-03-22
**Status:** Draft
**Horizon:** [Autonomous Batch Operations](horizons/autonomous-batch-operations.md) (L3 current, targets L4)

---

## 1. Problem Statement

### Current State: Fire-and-Forget Batch Execution

The overnight-dent runner (`scripts/overnight-dent.sh` trampoline + `overnight-dent-run.ts` TypeScript runner) is kaizen's highest-throughput improvement channel. It picks issues, creates worktrees, files PRs, and ships fixes autonomously. But it has no lifecycle management for the artifacts it creates.

A batch run produces:
- **Tracking issues** (`[Batch] Run N progress...`) for each run
- **PRs** against the kaizen repo
- **Worktrees** with branches for each piece of work
- **Cases** in the kaizen case system

None of these artifacts have defined completion criteria. None are cleaned up. None are summarized.

### Concrete Cost

Evidence from gap analysis (discussion #476):

| Waste category | Count | Examples |
|----------------|-------|---------|
| Stale batch tracking issues manually closed | 14 | #307, #310, #316, #329, #330, #336, #338, #339, #341, #342, #344, #361, #364, #369 |
| Open issues in root-cause cluster B (batch operational maturity) | 18 | Tracked in #476 |
| Unmerged PRs from batch runs accumulating | Unknown | #368: hypothesis that overnight-dent leaves unmerged PRs |
| Stale worktrees consuming disk | Unknown | #417: worktree disk accumulation |
| Overlapping scope between concurrent runs | Recurring | #299: scope overlap detection missing |
| Manual PR cleanup needed | Ongoing | #282, #318, #362, #363 |

### Why This Matters

Batch operations are kaizen's primary mechanism for compound improvement — they run while the human sleeps and should leave the codebase measurably better every morning. But without lifecycle management, they also produce the highest waste: stale artifacts that obscure what actually shipped, consume disk, and require human triage. The improvement channel that should be the most autonomous is currently the most human-dependent for cleanup.

From the Zen: *"Later without a signal is never."* Every batch artifact without a TTL or completion criterion is a "later" without a signal.

---

## 2. Lifecycle Model

A batch run moves through five stages. Each stage has entry criteria, exit criteria, a timeout, and defined artifacts.

```
PLAN --> EXECUTE --> MERGE --> CLEANUP --> REPORT
```

### Stage: PLAN

| Attribute | Value |
|-----------|-------|
| **Entry criteria** | Human or scheduler initiates a batch run with guidance |
| **Exit criteria** | Run list generated, scope locks acquired, no conflicts with active runs |
| **Timeout** | 5 minutes (planning should be fast) |
| **Artifacts produced** | Batch manifest (run ID, guidance, target issues, exclusion list) |
| **Artifacts consumed** | Kaizen backlog, active batch state, WIP from previous runs |

The plan stage checks for scope conflicts with any in-progress batch. If another run is already working on an issue, that issue is excluded. The batch manifest becomes the source of truth for what this run intends to do.

### Stage: EXECUTE

| Attribute | Value |
|-----------|-------|
| **Entry criteria** | Batch manifest exists, no scope conflicts |
| **Exit criteria** | All planned runs completed (success, failure, or budget-exceeded) |
| **Timeout** | Configurable total batch timeout (default: 8 hours) |
| **Artifacts produced** | Per-run: tracking issue, PR (if successful), worktree, case |
| **Artifacts consumed** | Batch manifest, per-run guidance |

This is the current overnight-dent core loop. The lifecycle manager wraps it with artifact tracking — every PR, issue, worktree, and case created is registered in the batch manifest.

### Stage: MERGE

| Attribute | Value |
|-----------|-------|
| **Entry criteria** | All execute runs completed |
| **Exit criteria** | All PRs resolved (merged, closed, or labeled stale) |
| **Timeout** | 48 hours from batch completion |
| **Artifacts produced** | Per-PR resolution status (merged/closed/stale) |
| **Artifacts consumed** | PR list from execute stage |

The merge stage monitors PRs created during the batch. After the timeout, unmerged PRs are labeled `stale:batch` and flagged for human review. This replaces the current manual triage.

### Stage: CLEANUP

| Attribute | Value |
|-----------|-------|
| **Entry criteria** | Merge stage complete (all PRs resolved or timed out) |
| **Exit criteria** | All temporary artifacts removed or archived |
| **Timeout** | 24 hours from merge completion |
| **Artifacts produced** | Cleanup log (what was removed and why) |
| **Artifacts consumed** | Batch manifest, PR resolution status |

Cleanup actions:
1. Close batch tracking issues (`[Batch] Run N...`) with a summary comment
2. Delete worktree directories for merged branches (respecting `/kaizen-cleanup` safety invariants)
3. Delete remote branches for merged PRs
4. Label stale PRs (unmerged after 48h) for human triage
5. Release scope locks on all issues

### Stage: REPORT

| Attribute | Value |
|-----------|-------|
| **Entry criteria** | Cleanup complete |
| **Exit criteria** | Summary posted |
| **Timeout** | 5 minutes |
| **Artifacts produced** | Batch summary (discussion comment or issue) |
| **Artifacts consumed** | All previous stage artifacts |

The report is the final artifact — a structured summary of what shipped, what failed, what's stale, and what was cleaned up. Posted as a comment on the batch's parent discussion or as a standalone summary issue.

---

## 3. Component Design

### 3.1 Completion Detector

**Purpose:** Determine when a batch run is done and what state it's in.

**State machine per batch run:**

```
RUNNING --> COMPLETE --> STALE
    |                     ^
    +--> FAILED ----------+
```

**Detection logic:**

| State | Condition |
|-------|-----------|
| **RUNNING** | At least one run is active (process alive, worktree locked) |
| **COMPLETE** | All runs finished; all PRs merged or closed |
| **STALE** | No progress for N hours (configurable, default: 6h during execution, 48h during merge) |
| **FAILED** | Consecutive failure threshold hit, or all runs exited with errors |

**Progress tracking:** The detector reads the batch manifest's `state.json` (which the existing runner already maintains) and augments it with PR status from the GitHub API. "No progress" means: no new commits, no PR status changes, no new issues filed, and no active worktree locks.

**Integration:** Runs as a post-batch check. Can also be invoked by `/kaizen-cleanup` to identify stale batches.

### 3.2 Artifact Cleaner

**Purpose:** Remove or archive batch artifacts that are no longer needed.

**Sweep cadence:** Runs after each batch completion and on-demand via `/kaizen-cleanup`.

**Cleanup rules:**

| Artifact | Condition to clean | Action |
|----------|-------------------|--------|
| Batch tracking issue (`[Batch] Run N...`) | PR merged or closed, or batch declared stale | Close with summary comment |
| Worktree directory | Branch merged into main, no lock file, no dirty files, no unpushed commits | Remove directory, delete remote branch |
| Unmerged PR | Open for > 48h after batch completion, no recent activity | Label `stale:batch`, comment with rationale |
| Remote branch | PR merged and worktree cleaned | Delete remote branch |
| Scope lock (label/comment on issue) | Batch complete or timed out | Remove lock |

**Safety:** The cleaner respects all safety invariants from `/kaizen-cleanup`:
- A lock file blocks removal, even if stale
- Only worktrees with merged branches and no dirty state are removed
- PRs are labeled stale, never force-closed (human decides)

### 3.3 Scope Deconflictor

**Purpose:** Prevent concurrent batch runs from working on the same issue.

**Lock mechanism:**

1. Before starting work on an issue, the runner adds a `batch-locked:<batch-id>` label
2. Other runners check for this label before picking the same issue
3. The label includes the batch ID so staleness can be determined

**Release mechanism:**

1. On successful PR creation: lock remains (issue is being worked on)
2. On PR merge: lock released (work complete)
3. On batch timeout: lock released after configurable TTL (default: 12h)
4. On batch failure: lock released immediately (issue is available for retry)

**Conflict resolution:** If a runner encounters a locked issue:
- Check if the locking batch is still active (process alive, recent progress)
- If active: skip the issue, pick another
- If stale (no progress for > TTL): release the lock, log the release, pick the issue

**Why labels, not comments:** Labels are queryable via GitHub API (`gh issue list --label batch-locked:*`), visible in issue lists, and easy to add/remove programmatically. Comments require parsing and are harder to discover.

### 3.4 Summary Reporter

**Purpose:** After cleanup, produce a structured summary of the batch run.

**Report format:**

```
Batch batch-260322-0100-a1b2 complete

Duration: 6h14m | Runs: 7 | Cost: $31.20

Shipped (merged):
  PR #450: fix hook gate/clear format mismatch
  PR #452: add missing allowlist entries
  PR #454: enforce co-committed test policy

Failed (closed):
  PR #451: OOM during vitest — needs investigation

Stale (unmerged after 48h):
  PR #453: refactor worktree-du to TypeScript — needs review

Skipped (deconflicted):
  #299: locked by batch-260321-2300-b2c3
  #345: failed in previous run, excluded

Cleaned up:
  3 tracking issues closed
  2 worktrees removed (4.2 GB reclaimed)
  2 remote branches deleted

Issues filed: #467 (L2 hook gap), #468 (test coverage)
Issues closed: #343, #362
```

**Delivery:** Posted as:
1. A comment on the batch's parent discussion (if initiated from a discussion)
2. A standalone summary issue labeled `batch-summary, overnight-dent`
3. (Phase 4+) Telegram notification per the L4 horizon spec

---

## 4. Integration Points

### 4.1 Existing Batch Runner

The lifecycle manager wraps the existing `overnight-dent.sh` / `overnight-dent-run.ts` stack. It does not replace the execution loop — it adds pre-execution (plan, deconflict) and post-execution (merge tracking, cleanup, report) stages.

```
Current:  overnight-dent.sh --> overnight-dent-run.ts --> [runs] --> done

Proposed: lifecycle-manager
            |-> PLAN (deconflict, manifest)
            |-> overnight-dent.sh --> overnight-dent-run.ts --> [runs]
            |-> MERGE (monitor PRs)
            |-> CLEANUP (sweep artifacts)
            |-> REPORT (post summary)
```

The runner's existing `state.json` is the data source for the lifecycle manager. No changes to `state.json` schema are needed in Phase 1 — the lifecycle manager reads it as-is and augments with GitHub API data.

### 4.2 `/kaizen-cleanup` Skill

The artifact cleaner shares logic with `/kaizen-cleanup`. Specifically:
- Worktree safety invariants (lock file, dirty state, unpushed commits) come from `src/worktree-du.ts`
- The cleanup skill can invoke the artifact cleaner on-demand: "clean up stale batch artifacts"
- The artifact cleaner reports the same metrics (disk reclaimed, branches deleted) that `/kaizen-cleanup` already surfaces

The cleanup skill gains a new mode: `--batch-artifacts` that targets overnight-dent waste specifically.

### 4.3 `/kaizen-reflect`

The summary report feeds into reflection. After a batch run, the next `/kaizen-reflect` invocation can reference:
- Which issues the batch attempted but failed on (potential root-cause analysis targets)
- Which PRs were merged (compound interest — what improved?)
- Which PRs are stale (why? what blocked them?)

This connects batch operations to the kaizen learning loop (see `docs/autonomous-kaizen-spec.md` section 3).

### 4.4 Horizon Integration

This PRD targets **Autonomous Batch Operations L3 -> L4** in the horizon taxonomy:
- **L3 (current):** Governed — cost caps, failure detection, cooldown
- **L4 (this PRD):** Reporting — structured summaries, artifact lifecycle, completion detection
- **L5 (future):** Strategic — pre-batch planning, adaptive guidance (out of scope)

The completion detector is a prerequisite for L5 strategic planning — you can't plan the next batch until you know the previous one is done.

---

## 5. Implementation Phases

### Phase 1: Completion Detection + Stale Labeling

**Goal:** Know when a batch is done. Label stale artifacts.

**Deliverables:**
1. Completion detector that reads `state.json` + GitHub PR status
2. Stale detection: PRs open > 48h labeled `stale:batch`
3. Tracking issues closed automatically when their PR is merged/closed
4. `batch-manifest.json` written at batch start with run plan

**Entry criteria:** Can be built immediately; no dependencies on new infrastructure.

**Exit criteria:** After a batch run, `batch-manifest.json` shows final state. Stale PRs are labeled within 48h. Batch tracking issues auto-close.

**Estimated scope:** 2-3 PRs.

### Phase 2: Artifact Cleanup Automation

**Goal:** Automatically clean up batch waste.

**Deliverables:**
1. Worktree cleanup for merged branches (reuses `worktree-du.ts` safety logic)
2. Remote branch deletion for merged PRs
3. Scope lock release on batch completion
4. Integration with `/kaizen-cleanup --batch-artifacts`

**Entry criteria:** Phase 1 complete (need completion detection to know when to clean).

**Exit criteria:** Zero stale worktrees from completed batches after 24h. `/kaizen-cleanup` reports batch artifact status.

**Estimated scope:** 2-3 PRs.

### Phase 3: Scope Deconfliction

**Goal:** Prevent concurrent runs from colliding.

**Deliverables:**
1. `batch-locked:<batch-id>` label mechanism
2. Lock check before issue pickup in runner
3. Stale lock detection and release
4. Exclusion list passed to agent runs

**Entry criteria:** Phase 1 complete (need batch IDs for lock labels).

**Exit criteria:** Two concurrent batch runs never work on the same issue. Stale locks auto-release after TTL.

**Estimated scope:** 1-2 PRs.

### Phase 4: Summary Reporting

**Goal:** Structured summary of every batch run.

**Deliverables:**
1. Summary report generated after cleanup
2. Posted as GitHub issue or discussion comment
3. Telegram notification (connects to L4 horizon)
4. Integration with `/kaizen-reflect` for next-batch learning

**Entry criteria:** Phases 1-3 complete (need full artifact data for meaningful summary).

**Exit criteria:** Every batch run produces a summary. Summary includes shipped/failed/stale/skipped/cleaned counts.

**Estimated scope:** 1-2 PRs.

### Dependency Graph

```
Phase 1: [completion detector] --> [stale labeling] --> [manifest]
              |
Phase 2: [worktree cleanup] --> [branch cleanup] --> [cleanup integration]
              |
Phase 3: [scope locks] --> [lock check] --> [stale lock release]
              |
Phase 4: [summary report] --> [notification] --> [reflect integration]
```

Phases 2 and 3 can run in parallel after Phase 1. Phase 4 depends on all prior phases.

---

## 6. Success Criteria

| Metric | Current | Target |
|--------|---------|--------|
| Stale batch tracking issues after 48h | 14+ (manual closure) | Zero |
| Batch worktrees cleaned after run completion | Manual only | Within 24h automatically |
| Summary report for batch runs | None | Every batch run |
| Scope collisions between concurrent runs | Recurring (#299) | Zero |
| Human time spent on batch artifact triage | 30+ min per batch | < 5 min (review summary only) |
| Unmerged PRs from batch runs without status | Unknown accumulation | All labeled within 48h |

### Definition of Done (for the full feature)

1. Every batch run produces a `batch-manifest.json` tracking all artifacts
2. Tracking issues auto-close when their PRs resolve
3. Stale PRs are labeled within 48h of batch completion
4. Worktrees from completed batches are cleaned within 24h
5. Concurrent runs never work the same issue
6. A structured summary is posted for every batch run
7. `/kaizen-cleanup` can show and clean batch-specific artifacts

---

## 7. What This PRD is NOT

- **Not a redesign of the batch runner itself** — the execution loop stays as-is
- **Not L5 strategic planning** — adaptive guidance, pre-batch ultrathink, and gap-analysis integration are out of scope (they depend on this lifecycle infrastructure)
- **Not fleet orchestration** — multi-stream parallelism (L7) is a distant horizon
- **Not cost governance** — budget tracking exists at L3; this PRD handles artifact lifecycle, not spend

---

## 8. Open Questions

**Q1: Should the lifecycle manager be a new script or integrated into the existing runner?**
- Option A: New `overnight-dent-lifecycle.ts` that wraps the existing runner
- Option B: Extend `overnight-dent-run.ts` with lifecycle stages
- **Lean: A.** Separation of concerns — the runner runs, the lifecycle manager manages. The runner shouldn't need to know about cleanup or reporting.

**Q2: How long should scope locks persist?**
- Option A: Until batch completion (could be 8+ hours)
- Option B: Per-run TTL (e.g., 2 hours per run)
- Option C: Until PR resolution (merged/closed)
- **Lean: C with B as fallback.** Lock until the PR is resolved, but auto-release after 12h if no PR was created (run failed before PR).

**Q3: Should stale PRs be auto-closed or just labeled?**
- Option A: Auto-close after 72h with a comment
- Option B: Label only; human decides
- Option C: Auto-close only if CI is failing; label if CI passes
- **Lean: B for Phase 1, C for later.** Auto-closing working code is wasteful. Labeling surfaces the problem; humans make the call.

**Q4: Where does the batch manifest live?**
- Option A: `.claude/state/batch/<batch-id>/manifest.json` in the worktree
- Option B: As a GitHub issue with structured YAML frontmatter
- Option C: Both — local for speed, GitHub for persistence
- **Lean: A for Phase 1.** Local state is fast and sufficient. If we need cross-machine access (fleet, L7), migrate to GitHub.

---

## 9. Relationship to Other Specs and Issues

| Reference | Relationship |
|-----------|-------------|
| [Autonomous Batch Operations horizon](horizons/autonomous-batch-operations.md) | This PRD implements L4 (reporting) components |
| [Autonomous Kaizen spec](autonomous-kaizen-spec.md) | Lifecycle events feed the kaizen learning loop (section 3) |
| Discussion #476 | Gap analysis that identified this need |
| #299 | Scope overlap — addressed by Phase 3 deconflictor |
| #318 | Auto-close stale PRs — addressed by Phase 1 stale labeling |
| #362 | PR cleanup integration — addressed by Phase 2 |
| #368 | Unmerged PRs hypothesis — addressed by Phase 1 completion detection |
| #417 | Worktree disk accumulation — addressed by Phase 2 cleanup |
| #282 | Stale PR sweep — addressed by Phase 1 stale labeling |
| `/kaizen-cleanup` skill | Phase 2 extends this with `--batch-artifacts` mode |
