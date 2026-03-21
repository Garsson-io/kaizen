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

**L1.** Container timeout (`CONTAINER_TIMEOUT`). IPC reaper removes stale files >1hr. Cursor rollback on agent error. Push-before-die in session-dev-agents spec (not yet implemented). 30+ catch blocks in `index.ts` with inconsistent error classification.

## What Exists

| Component | Level | Location |
|-----------|-------|----------|
| Container timeout | L1 | `src/config.ts` (CONTAINER_TIMEOUT) |
| IPC file reaper | L1 | `src/ipc.ts` |
| Cursor rollback | L1 | `src/index.ts` |
| Error catch blocks | L0-1 | `src/index.ts` (~30 catches, inconsistent) |
| Download retry | L1 | `src/download-coalesce.ts` |
| Push-before-die | L1 (spec'd) | `docs/session-based-dev-agents-spec.md` |

## L1→L2: Recovery Manifests (next step)

**Problem L2 solves:** Agent crashes mid-PR. Today: human reconstructs from git reflog and orphaned branches. L2: structured recovery metadata makes pickup automatic.

**Rough shape:** On session start, write a recovery manifest: `{ caseId, branch, lastToolCall, intent, startedAt }`. On clean exit, delete it. On next session start, check for orphaned manifests and offer recovery. The manifest tells the recovering agent what was happening and where to pick up.

**Signal to escalate to L3:** Agents keep dying on the same transient failures (API rate limits, network timeouts) rather than retrying.

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
