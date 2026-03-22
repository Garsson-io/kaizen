# PRD: Promote Overnight-Dent to Formal Horizon with Maturity Axes

**Issue:** TBD (created with this PRD)
**Author:** Claude (autonomous)
**Date:** 2026-03-22
**Status:** Draft
**Discussion:** [#476](https://github.com/Garsson-io/kaizen/discussions/476)

---

## 1. Problem Statement

Overnight-dent is kaizen's label for autonomous batch operations -- multi-hour unattended runs that pick issues, implement fixes, and create PRs. It currently has **22 open issues** (more than any formal horizon) but is structured as a single-axis runner capability taxonomy, not a multi-dimensional quality horizon.

### What exists today

The existing horizon doc (`docs/horizons/autonomous-batch-operations.md`) defines a single progression axis: **runner sophistication** (L0 manual -> L1 basic loop -> L2 tagged -> L3 governed -> L4 reporting -> L5 strategic -> L6 self-steering -> L7 fleet). This is a valuable taxonomy but it treats batch autonomy as a linear feature ladder rather than a quality space with multiple independent dimensions.

Epic #275 ("Horizon: Autonomous Batch Operations") tracks this runner progression. Epic #295 ("Overnight-Dent Observability") is scoped narrowly to one facet. Neither provides a framework for classifying the full problem space.

### What this costs

- **No dimensional analysis.** A batch run can be L3 on runner sophistication but L0 on failure recovery. The single axis hides this.
- **No taxonomy for 22 issues.** Issues carry the `overnight-dent` label but aren't classified by which quality dimension they improve. A PR cleanup issue (#362) and an overlapping scope detection issue (#299) live in the same bucket despite being orthogonal problems.
- **No cross-horizon mapping.** Batch runs are the largest exerciser of hooks, skills, worktrees, and testing -- but this relationship isn't formalized. When a batch run breaks, we file an `overnight-dent` issue, not a resilience or testability issue.
- **No success criteria.** What does a "mature" batch operation look like? The current taxonomy answers "it has a strategic planner" (L5). But a strategic planner with no failure recovery and no quality gates is not mature -- it's sophisticated and fragile.

### Evidence from gap analysis (discussion #476)

- 22 issues carry the `overnight-dent` label -- more than any `horizon/*` label
- Root-cause cluster B (overnight-dent operational maturity) has 18 issues
- Root-cause cluster J (stale batch tracking) has 14 issues (now closed)
- The issues span at least 5 distinct quality dimensions (lifecycle, safety, failure handling, observability, quality)

### Why this is a horizon, not a feature

Per the Zen of Kaizen: *"The horizon you can name, you can climb. The horizon you can't name climbs you."*

Batch autonomy passes all horizon criteria:
- **Infinite game.** There is always more to improve about unattended operation reliability.
- **Fundamental quality dimension.** It affects every other horizon -- batch runs exercise hooks, skills, worktrees, and testing.
- **Multiple orthogonal axes.** Lifecycle completeness, scope safety, failure recovery, observability, throughput, and quality assurance are independent dimensions that can improve separately.
- **Existing critical mass.** 22 open issues, more than most named horizons.

---

## 2. Horizon Definition

**Name:** `horizon/batch-autonomy`

The label generalizes beyond "overnight-dent" (a specific script) to cover any unattended operation: scheduled batch runs, background improvement sessions, fleet operations.

**Thesis:** Autonomous batch operations are a fundamental quality dimension of kaizen. As the system matures, more work should be safely delegable to unattended runs with predictable outcomes. Maturity is measured not by runner sophistication alone, but across six orthogonal axes that together define what "trustworthy autonomy" means.

**Relationship to existing taxonomy:** The current `docs/horizons/autonomous-batch-operations.md` remains valuable as the **runner capability axis** (Axis 0, below). The new maturity model adds five cross-cutting axes that apply regardless of runner sophistication level.

---

## 3. Maturity Axes

### Axis 0: Runner Capability (existing taxonomy)

The progression from manual to fleet operation, as already defined in `docs/horizons/autonomous-batch-operations.md`. This axis remains unchanged.

| Level | Name | Description |
|-------|------|-------------|
| L0 | Manual | Human starts each session, watches it |
| L1 | Basic loop | Script loops with guidance, logs to files |
| L2 | Tagged & tracked | Run IDs, output parsing, batch summaries |
| L3 | Governed | Cost caps, failure detection, tight-loop prevention, graceful shutdown |
| L4 | Reporting | Admin notifications, anomaly alerts |
| L5 | Strategic | Pre-batch planning, gap analysis, adaptive guidance |
| L6 | Self-steering | Outcome tracking, strategy adjustment, autonomous guidance |
| L7 | Fleet | Parallel streams, coordination, domain partitioning |

**Current state: L3** (governed + observable, trampoline/runner split)

### Axis 1: Lifecycle Completeness

Does the system handle the full lifecycle of each batch item? A batch run isn't just execution -- it's plan, execute, verify, merge, cleanup, and report.

| Level | Name | Description | Signal to advance |
|-------|------|-------------|-------------------|
| L0 | Fire-and-forget | Run starts, creates artifacts, exits. No cleanup. | Orphaned worktrees or PRs found after batch |
| L1 | Execution tracking | Each run is tagged, artifacts (PRs, issues) are logged | Artifacts exist but aren't cleaned up when obsolete |
| L2 | Cleanup | Worktrees removed after run, stale PRs closed, state files cleaned | Batch ends but summary doesn't account for all artifacts |
| L3 | Full lifecycle | Plan -> execute -> verify -> merge-readiness check -> cleanup -> report. Every artifact accounted for from creation to disposition | Manual intervention required during lifecycle |

**Current state: L1.** Runs are tagged and tracked (batch IDs, output parsing). But cleanup is manual -- orphaned worktrees accumulate (#362), unmerged PRs pile up (#368), and there's no lifecycle tracking of individual artifacts from creation to disposition.

### Axis 2: Scope Safety

Can the system avoid stepping on its own feet? Scope safety covers both inter-run deconfliction (two runs don't pick the same issue) and intra-run risk assessment (a run doesn't pick work that's too large or too risky for unattended execution).

| Level | Name | Description | Signal to advance |
|-------|------|-------------|-------------------|
| L0 | No deconfliction | Runs can pick overlapping work, create conflicting PRs | Two runs work on the same issue, or batch creates a PR that conflicts with an in-flight PR |
| L1 | Issue locking | Attempted issues are tracked across runs, exclusion list prevents re-picking | Run picks an issue that's too large or complex for unattended operation |
| L2 | Scope assessment | Before starting, evaluate issue complexity. Skip issues that are epics, multi-PR, or require human judgment | Scope assessment is correct but risk isn't -- a medium-complexity issue turns out to break things |
| L3 | Risk-aware selection | Factor in blast radius, dependency count, and historical success rate per issue type | No further deconfliction issues |

**Current state: L0-L1.** The runner tracks attempted issues across runs and passes exclusion lists, but overlapping scope across concurrent batch runs is undetected (#299). No scope assessment or risk evaluation exists.

### Axis 3: Failure Recovery

What happens when a batch item fails? OOM, merge conflict, CI failure, and crash are all different failure modes requiring different responses.

| Level | Name | Description | Signal to advance |
|-------|------|-------------|-------------------|
| L0 | Crash and orphan | Run fails, leaves dirty state, next run may hit the same problem | Failed run leaves orphaned worktree or partial PR |
| L1 | Log and skip | Failure is logged, issue is added to exclusion list, next run continues | Same failure mode recurs across batches because root cause isn't diagnosed |
| L2 | Classify and retry | Failures are categorized (OOM, merge conflict, test failure, crash). Transient failures retry with backoff. Permanent failures skip. | Failures are handled but not routed for fix |
| L3 | Diagnose and route | After classification, file a kaizen issue describing the failure mode. Route to the appropriate horizon (OOM -> resilience, merge conflict -> scope safety) | No further undiagnosed failure patterns |

**Current state: L1.** Consecutive failure detection exists (L3 runner). Failed issues are excluded from future runs. But failures aren't classified by type, there's no retry logic, and failure patterns aren't routed to the appropriate horizon for systematic fix.

### Axis 4: Observability

Can a human understand what happened during a batch run without reading raw logs?

| Level | Name | Description | Signal to advance |
|-------|------|-------------|-------------------|
| L0 | Git log only | The only record of what happened is git history and raw log files | Human has to grep logs to understand what a batch did |
| L1 | Tracking issues | Batch creates a GitHub issue summarizing what happened | Summary exists but doesn't capture enough detail for diagnosis |
| L2 | Structured reports | Per-run reports with timing, cost, artifacts created, failure classification. Machine-readable format. | Reports exist but require human initiative to check |
| L3 | Dashboard | Real-time or near-real-time visibility: active runs, cumulative cost, PR pipeline status. Push notifications for anomalies. | No further observability gaps |

**Current state: L1-L2.** The runner produces structured per-run output (stream-json milestones, heartbeat during silence, batch tracking issues). But reports are scattered across individual GitHub issues rather than aggregated, and there's no push notification or dashboard.

### Axis 5: Throughput Efficiency

What percentage of batch time and cost produces merged PRs versus waste (failed PRs, stale worktrees, duplicate work, cold-start overhead)?

| Level | Name | Description | Signal to advance |
|-------|------|-------------|-------------------|
| L0 | Unmeasured | No data on what percentage of batch work produces value | Can't answer "what's our merge rate?" |
| L1 | Measured | Track: runs attempted, PRs created, PRs merged, cost per merged PR, waste categories | Data shows efficiency below 50% |
| L2 | Efficient (>50%) | More than half of batch cost produces merged PRs. Cold-start optimized, scope selection improved. | Efficiency plateau -- remaining waste is structural |
| L3 | Highly efficient (>80%) | Waste is minimal. Failed runs are rare. Cold-start is near-zero. Issue selection consistently picks achievable work. | Approaching theoretical maximum |

**Current state: L0.** No systematic measurement of batch efficiency exists. Anecdotal evidence suggests significant waste: unmerged PRs (#368), cold-start overhead (~4-5 minutes per run per #295), overlapping scope (#299). But we can't quantify it because we don't measure it.

### Axis 6: Quality Assurance

Are batch-produced PRs as good as interactive ones? Quality here means: tests pass, review checklist passes, no regressions introduced, commit messages are clear, scope matches the issue.

| Level | Name | Description | Signal to advance |
|-------|------|-------------|-------------------|
| L0 | No review | PRs are created and left for human review with no automated quality checks | Batch PRs routinely fail review or introduce regressions |
| L1 | Self-review | Agent runs `/kaizen-review-pr` before finishing. Basic checklist. | Self-review passes but human review finds issues self-review missed |
| L2 | Automated quality gates | CI runs, test coverage checked, hook compliance verified, scope-vs-issue alignment checked -- all before PR is marked ready | Quality gates pass but PRs are still lower quality than interactive ones |
| L3 | Indistinguishable | Batch PRs meet the same quality bar as interactive PRs. Merge rate, revert rate, and rework rate are equivalent. | No quality gap between batch and interactive work |

**Current state: L0-L1.** The existing hooks (kaizen-verify-before-stop, pr-policy) provide some quality enforcement. But there's no batch-specific quality gate, no measurement of batch PR quality versus interactive PR quality, and the self-review step is inconsistently applied.

---

## 4. Current State Assessment

| Axis | Name | Current | Target (6 months) |
|------|------|---------|--------------------|
| 0 | Runner Capability | L3 | L4-L5 |
| 1 | Lifecycle Completeness | L1 | L2-L3 |
| 2 | Scope Safety | L0-L1 | L2 |
| 3 | Failure Recovery | L1 | L2 |
| 4 | Observability | L1-L2 | L2-L3 |
| 5 | Throughput Efficiency | L0 | L1-L2 |
| 6 | Quality Assurance | L0-L1 | L2 |

**Summary:** The runner itself is relatively mature (L3), but the surrounding quality dimensions are L0-L1. The system can run autonomously but can't tell you how well it ran (L0 efficiency), can't recover gracefully from failure (L1 recovery), and can't guarantee output quality (L0-L1 QA). This is a classic case of capability outrunning maturity.

---

## 5. Relationship to Other Horizons

Batch autonomy is the **execution arm** of autonomous kaizen. It doesn't exist in isolation -- it exercises and stresses every other horizon. This relationship map is critical for understanding where batch failures should be routed.

| Horizon | Relationship | Interaction |
|---------|-------------|-------------|
| **Autonomous Kaizen** | Parent dimension | Batch autonomy is how autonomous kaizen actually runs at scale. Improvements here directly increase autonomous kaizen's capability ceiling. |
| **Testability** | Largest exerciser | Batch runs are the biggest consumer of the test suite. When tests are flaky, batch runs are the first to suffer. Batch-specific test issues (#343, #345, #346) are really testability issues discovered through batch execution. |
| **Resilience** | Largest source of corrupted state | Batch failures produce the most orphaned state: worktrees, PRs, partial commits. Resilience improvements (state preservation, cleanup) directly improve batch lifecycle completeness. |
| **Observability** | Most data, least visibility | Batch runs produce more telemetry than any other mode of operation, but observability tooling is designed for interactive use. Batch-specific observability (#295) is the bridge. |
| **Cost Governance** | Budget enforcement prerequisite | Per-run and per-batch budgets (Axis 0 L3) depend on cost governance infrastructure. Cost governance L2+ (per-case budgets) enables fine-grained batch cost control. |
| **Worktree-First Infrastructure** | Operational prerequisite | Every batch run creates worktrees. Worktree cleanup failures directly cause lifecycle completeness failures. Worktree-first infrastructure improvements reduce batch waste. |
| **State Integrity** | Cross-run state management | Batch state (`state.json`, exclusion lists, run counters) is a state integrity problem. Collision detection and freshness guarantees apply directly. |
| **Human-Agent Interface** | Reporting channel | Batch reports are the primary consumer of human-agent interface improvements. Admin notifications (Axis 0 L4) require structured summaries. |

### Routing rule

When a batch run reveals a problem, classify it by axis first, then by horizon:
- **Axis 1 (lifecycle):** If it's about cleanup -> route to resilience. If it's about tracking -> route to observability.
- **Axis 2 (scope):** Route to batch-autonomy (scope safety is batch-specific).
- **Axis 3 (failure):** Route to resilience for recovery mechanisms. Route to batch-autonomy for failure classification logic.
- **Axis 4 (observability):** Route to observability horizon for infrastructure. Route to batch-autonomy for batch-specific report format.
- **Axis 5 (efficiency):** Route to batch-autonomy (efficiency is batch-specific measurement).
- **Axis 6 (quality):** Route to testability for test issues. Route to batch-autonomy for quality gate design.

---

## 6. Taxonomy for Existing Issues

The 22 open `overnight-dent` issues should be re-classified by axis. Below is a proposed mapping based on issue titles and descriptions.

### Axis 1: Lifecycle Completeness

| Issue | Title | Sub-axis |
|-------|-------|----------|
| #362 | Integrate pr-cleanup into overnight-dent batch harness | Cleanup |
| #368 | Hypothesis: overnight-dent leaves unmerged PRs behind | Cleanup |
| #318 | Auto-close PRs whose kaizen issues are already resolved | Artifact disposition |

### Axis 2: Scope Safety

| Issue | Title | Sub-axis |
|-------|-------|----------|
| #299 | Detect overlapping kaizen issue scope across batch runs | Inter-run deconfliction |

### Axis 3: Failure Recovery

| Issue | Title | Sub-axis |
|-------|-------|----------|
| #335 | Run 4: Kaizen waiver quality enforcement | Run-level failure |

### Axis 4: Observability

| Issue | Title | Sub-axis |
|-------|-------|----------|
| #363 | Document pr-cleanup command in CLAUDE.md | Documentation |

### Axis 6: Quality Assurance

| Issue | Title | Sub-axis |
|-------|-------|----------|
| #343 | index-response-deps.test.ts mock fragility | Test quality (discovered by batch) |
| #345 | Vitest Proxy-based auto-mock causes hangs | Test quality (discovered by batch) |
| #346 | index-response-deps mocks require manual updates | Test quality (discovered by batch) |

### Cross-cutting / Runner Capability (Axis 0)

| Issue | Title | Sub-axis |
|-------|-------|----------|
| #331 | Migrate worktree-du.sh to TypeScript | Infrastructure migration |

### Re-routing candidates

Issues #343, #345, and #346 carry the `overnight-dent` label because they were discovered during batch runs, but they are fundamentally **testability** issues. Under the new taxonomy, they should:
1. Retain the `overnight-dent` label (provenance: discovered during batch)
2. Add the `horizon/testability` label (substance: testing infrastructure)
3. Not be counted toward batch-autonomy maturity assessment

This distinction between "discovered by batch" and "about batch" is important. The `overnight-dent` label currently conflates both.

---

## 7. Implementation

### Phase 1: Define and classify (this PRD)

**Deliverables:**
1. This PRD, reviewed and merged
2. GitHub issue created as tracking epic
3. Update `docs/horizons/autonomous-batch-operations.md` to reference the multi-axis model
4. Update `docs/horizons/README.md` to note the axis expansion
5. Create `horizon/batch-autonomy` label (or reuse `horizon/autonomous-batch-ops`)
6. Re-label existing 22 issues with axis classification

**Effort:** Small. Documentation and label changes only.

### Phase 2: Instrument measurement (Axis 5 L0 -> L1)

**Deliverables:**
1. Add per-batch metrics collection: runs attempted, PRs created, PRs merged, cost per merged PR
2. Add waste categorization: cold-start time, failed runs, stale artifacts
3. Produce efficiency report at batch end

**Why this is first:** You can't improve what you don't measure. Axis 5 (throughput efficiency) is at L0 -- unmeasured. Moving it to L1 provides data for all other axis improvements.

**Effort:** Medium. Requires instrumentation in `overnight-dent-run.ts`.

### Phase 3: Address lowest-maturity axes

Priority order based on current state and impact:

1. **Axis 1 L1 -> L2 (Lifecycle Completeness: Cleanup).** Close the pr-cleanup gap (#362, #368). Automate worktree and PR cleanup at batch end.
2. **Axis 3 L1 -> L2 (Failure Recovery: Classify and retry).** Categorize failure modes. Retry transient failures. Skip permanent ones.
3. **Axis 2 L1 -> L2 (Scope Safety: Scope assessment).** Evaluate issue complexity before starting. Skip issues that are too large for unattended operation.
4. **Axis 6 L1 -> L2 (Quality Assurance: Automated quality gates).** Add batch-specific quality checks before marking PRs ready.

**Effort:** Each is a focused PR. Can be done incrementally, potentially by batch runs themselves (dogfooding).

---

## 8. What's Explicitly NOT in Scope

- **Rewriting the existing horizon doc.** The L0-L7 runner capability taxonomy in `docs/horizons/autonomous-batch-operations.md` is good. This PRD adds dimensions alongside it, not replacing it.
- **Implementing any axis improvements.** This PRD defines the model and proposes classification. Implementation is Phase 2-3.
- **Changing the `overnight-dent` label semantics.** The label remains as provenance ("discovered by batch"). New axis labels are additive.
- **Fleet operations (Axis 0 L7).** Distant horizon. Not designed here.

---

## 9. Success Criteria

This PRD succeeds when:

1. Every `overnight-dent` issue can be classified by axis (not just "it's a batch thing")
2. The current state assessment per axis is published and accepted
3. Improvement work can target a specific axis and level, with clear "done" criteria
4. Batch runs can be evaluated against a multi-dimensional maturity model, not just runner sophistication
5. Cross-horizon routing is documented -- batch failures flow to the right horizon for systematic fix
