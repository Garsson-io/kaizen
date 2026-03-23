# Horizon: Observability

*"You can't improve what you can't see."*

## Problem

Agent sessions are black boxes. A PR appears — no visibility into what the agent did, why it chose that approach, what it tried and rejected, or how much it cost. Debugging requires reading conversation logs (ephemeral) or reconstructing from git history (incomplete). Patterns across sessions (which issue types take longest, which produce rework) are invisible.

Without observability:
- **Incident detection is delayed.** Failures surface only when a human reads the output.
- **Cost optimization is impossible.** Can't reduce what you can't measure.
- **Capability assessment is opinion-based.** "Agents are good at X" is a guess, not data.
- **The kaizen system is flying blind.** Reflection quality can't be measured; meta-reflection has nothing to reflect on.

## Taxonomy

| Level | Name | What you can answer | Mechanism |
|-------|------|---------------------|-----------|
| **L0** | Blind | "Did something happen?" (maybe) | Nothing. Check git log. |
| **L1** | Output logs | "What happened?" (after the fact) | Session logs captured. CI results recorded. Structured scoring. |
| **L2** | Structured telemetry | "How much did this cost? What did the agent touch?" | Token cost, wall time, tool calls, files touched — per case, queryable. |
| **L3** | Decision tracing | "Why did the agent choose this approach?" | Key decisions logged with rationale, alternatives, context. Audit trail. |
| **L4** | Anomaly detection | "Is this session behaving unusually?" | Baselines established. Alerts on unusual duration, scope, token burn. |
| **L5** | Pattern analytics | "Which issue types produce the most rework across all sessions?" | Cross-case analysis. Correlation between issue characteristics and outcomes. |
| **L6** | Predictive | "This case will probably fail — here's why." | Historical patterns predict failure modes before agent starts. |

## You Are Here

**L2 (partial).** Auto-dent provides structured telemetry for batch operations: per-run `RunScore` with cost, duration, tool calls, PR count, efficiency metrics, and failure classification. `BatchScore` aggregates across runs. Phase markers (`AUTO_DENT_PHASE`) emit structured progress during runs. Heartbeat monitoring and watchdog detect stalled sessions. Cost anomaly detection flags runs that exceed rolling averages. Post-hoc scoring evaluates PR quality after creation. Structured JSON stream output from each run is parsed and scored.

Gaps: No cross-batch analytics queryable from a single interface. No decision tracing (why the agent chose approach A over B). Interactive sessions outside auto-dent have no telemetry.

## What Exists

| Component | Level | Location |
|-----------|-------|----------|
| `RunScore` (per-run metrics) | L2 | `scripts/auto-dent-score.ts` |
| `BatchScore` (aggregate metrics) | L2 | `scripts/auto-dent-score.ts` |
| Phase markers (`AUTO_DENT_PHASE`) | L1-L2 | Emitted by agents, parsed by `scripts/auto-dent-run.ts` |
| Cost anomaly detection | L2 | `scripts/auto-dent-score.ts` (`detectCostAnomaly`) |
| Failure classification | L2 | `scripts/auto-dent-score.ts` (`classifyFailure`) |
| Heartbeat monitoring | L1 | `scripts/auto-dent-run.ts` (heartbeat interval) |
| Watchdog (stale heartbeat detection) | L1 | `scripts/auto-dent-ctl.ts` (`checkBatchHealth`) |
| Batch trend analysis | L2 | `scripts/auto-dent-score.ts` (`analyzeBatchTrend`) |
| Mode diversity scoring | L2 | `scripts/auto-dent-score.ts` |
| Post-hoc PR scoring | L2 | `scripts/auto-dent-run.ts` (`runPostHocScoring`) |
| In-flight PR comment updates | L1 | `scripts/auto-dent-run.ts` |
| Batch reflection summary | L1 | `scripts/auto-dent-ctl.ts` (`buildBatchReflection`) |

## L2→L3: Decision Tracing (next step)

**Problem L3 solves:** "The agent created a PR that refactored X instead of fixing Y. Why?" Today: reconstruct from git diffs and PR description. L3: key decision points logged with rationale at natural checkpoints.

**Rough shape:** Structured decision events emitted at case start (issue selection rationale), scope changes (why scope expanded/narrowed), and PR creation (what alternatives were considered). Stored alongside run scores. Queryable across batches.

**Signal to escalate to L4:** Repeated incidents where unexpected agent behavior is only understood after manual log archaeology, AND decision traces exist but anomalies aren't auto-detected.

## L3–L4: Visible but not designed

**L3 (decision tracing):** Problem: agent chose approach A over B. Why? Today: lost when conversation ends. Need: key decision points logged with rationale at natural checkpoints (case start, PR creation, scope changes). Open question: how to capture decisions without overwhelming the storage?

**L4 (anomaly detection):** Problem: agent is stuck in a loop or touching unusual files. Today: nobody knows until the session times out or the PR is weird. Need: baseline behavior profiles, alerts when a session deviates.

## L5–L6: Horizon

**L5 (pattern analytics):** Cross-case correlation. "Issues involving container changes have 40% higher rework rate." Needs L2-L3 data to be meaningful.

**L6 (predictive):** "Based on 30 similar cases, this one will likely take 3x the budget and fail on CI." Needs L5 patterns as training data.

## What We Can't See Yet

Beyond L6, observability starts enabling genuine organizational learning: detecting drift in agent behavior over time, measuring whether kaizen improvements actually improved outcomes, and identifying meta-patterns (seasonal trends, architectural areas that generate disproportionate friction). This territory overlaps with Autonomous Kaizen L8 (self-modifying process) — the system needs to see itself clearly to modify itself wisely.

## Relationship to Other Horizons

- **Observability feeds Incident-Driven Kaizen** — can't track incidents you can't see
- **Observability feeds Cost Governance** — can't budget what you can't measure
- **Observability enables Autonomous Kaizen L6+** — autonomous work selection needs data on what works
- **Observability enables Security L4+** — anomaly detection requires behavioral baselines
- **Observability feeds State Integrity** — inconsistency detection requires knowing what state each agent saw
