# Horizon: Resilience

*"The fix isn't done until the outcome is verified. But what happens when the fixer crashes mid-fix?"*

## Problem

Agents fail in ways humans don't: context overflow, API outages mid-session, hallucinated file paths, infinite tool loops, killed containers. When an agent crashes mid-work, the aftermath is unpredictable: half-committed changes, orphaned worktrees, stale IPC files, inconsistent case status. Recovery is manual archaeology.

Without resilience:
- **Half-finished work creates cleanup toil** — human discovers mess, reconstructs intent, finishes or rolls back
- **Transient failures become permanent** — API rate limit causes session death instead of retry
- **Cascading failures spread** — one crashed agent leaves state that confuses the next agent
- **Autonomous operation is unsafe** — can't run agents unsupervised if a crash requires human cleanup

## Taxonomy

| Level | Name | What survives a failure | Mechanism |
|-------|------|------------------------|-----------|
| **L0** | Fail-and-forget | Nothing. Human discovers and cleans up. | None |
| **L1** | Failure detection | System knows a session failed. Alerts humans. WIP state preserved. | Push-before-die, timeout detection, IPC reaper |
| **L2** | State preservation | Uncommitted changes, partial PRs, worktree state all recoverable without archaeology. | Recovery manifests, structured WIP snapshots |
| **L3** | Automatic retry | Transient failures retried with backoff. Permanent failures classified and escalated. | Error classification, retry policies |
| **L4** | Graceful degradation | Subsystem down → system continues in reduced mode, queues work. | Circuit breakers, fallback paths, work queues |
| **L5** | Proactive resilience | System periodically verifies recovery paths work. | Chaos testing for agent systems |
| **L6** | Self-healing | Orphaned worktrees, stale state, inconsistent cases detected and repaired continuously. | Background reconciliation process |

## You Are Here

**L1-L2 (partial).** Auto-dent harness provides wall-time timeout per run with SIGTERM/SIGKILL escalation. Heartbeat monitoring detects stalled agents. Watchdog (`auto-dent-ctl.ts`) halts batches with stale heartbeats. Post-result grace period prevents hung processes after work completes. Worktree isolation ensures crashed runs don't corrupt the main repo. Failure classification (`classifyFailure`) categorizes crashes for root-cause analysis.

Gaps: No automatic retry of transient failures. No recovery manifests for mid-work crashes. No circuit breakers for external service outages (GitHub API, Claude API).

## What Exists

| Component | Level | Location |
|-----------|-------|----------|
| Wall-time watchdog (SIGTERM/SIGKILL) | L1 | `scripts/auto-dent-run.ts` |
| Post-result grace timeout | L1 | `scripts/auto-dent-run.ts` (`POST_RESULT_GRACE_MS`) |
| Heartbeat monitoring | L1 | `scripts/auto-dent-run.ts` (heartbeat interval) |
| Watchdog (stale heartbeat → halt) | L2 | `scripts/auto-dent-ctl.ts` (`checkBatchHealth`) |
| Worktree isolation per run | L2 | `scripts/auto-dent-run.ts` (worktree creation) |
| Failure classification | L1 | `scripts/auto-dent-score.ts` (`classifyFailure`) |
| Batch halt mechanism | L1 | `scripts/auto-dent-ctl.ts` (halt file) |
| Worktree disk usage tracking | L1 | `src/worktree-du.ts` |

## L2→L3: Automatic Retry (next step)

**Problem L3 solves:** Agent hits a transient failure (API rate limit, network timeout, GitHub 502). Today: the run is scored as a failure and the batch moves on. L3: transient failures are classified and retried with backoff before being marked as failures.

**Rough shape:** Extend `classifyFailure` to distinguish transient vs permanent failures. Transient failures get one retry with exponential backoff. Recovery manifests (`{ caseId, branch, lastPhase, intent }`) enable the retry to pick up mid-work rather than starting from scratch.

**Signal to escalate to L4:** The same external service outages (GitHub API, Claude API) cause cascading failures across multiple runs rather than being handled gracefully.

## L3–L4: Visible but not designed

**L3 (automatic retry):** Problem: agent hits Claude API rate limit, session dies. Today: human restarts. Need: error classification (transient vs permanent), retry with backoff for transient, escalation for permanent. Open question: where does retry logic live — harness-level (restart container) or agent-level (retry within session)?

**L4 (graceful degradation):** Problem: GitHub API is down for 30 minutes. Today: all agents fail that need GitHub. Need: queue operations for later, continue work that doesn't need the down service. Open question: which operations can be safely deferred and which must fail fast?

## L5–L6: Horizon

**L5 (proactive resilience):** Chaos testing adapted for AI agents. "What happens if we kill an agent mid-PR-review?" "What happens if the SQLite DB is locked for 10 seconds?" Intentional failure injection to verify recovery paths.

**L6 (self-healing):** Background process that continuously reconciles: finds orphaned worktrees, stale branches without cases, inconsistent case status between SQLite and GitHub. Repairs automatically or escalates to human for ambiguous cases.

## What We Can't See Yet

Beyond L6, resilience becomes predictive — the system identifies fragile paths before they fail, based on complexity metrics, dependency counts, and historical failure rates. This overlaps with Observability L6 (predictive) and feeds into Autonomous Kaizen (the system avoids fragile work patterns, not just recovers from them).

## Relationship to Other Horizons

- **Resilience enables Autonomous Kaizen L7+** — can't run agents unsupervised if crashes require human cleanup
- **State Integrity enables Resilience** — can't recover what you can't reconcile
- **Observability feeds Resilience** — failure detection requires knowing what happened
- **Cost Governance interacts with Resilience L3** — retry policies have cost implications
