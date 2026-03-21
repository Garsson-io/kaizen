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
| **L1** | Output logs | "What happened?" (after the fact) | Session logs captured. CI results recorded. pino logger. |
| **L2** | Structured telemetry | "How much did this cost? What did the agent touch?" | Token cost, wall time, tool calls, files touched — per case, queryable. |
| **L3** | Decision tracing | "Why did the agent choose this approach?" | Key decisions logged with rationale, alternatives, context. Audit trail. |
| **L4** | Anomaly detection | "Is this session behaving unusually?" | Baselines established. Alerts on unusual duration, scope, token burn. |
| **L5** | Pattern analytics | "Which issue types produce the most rework across all sessions?" | Cross-case analysis. Correlation between issue characteristics and outcomes. |
| **L6** | Predictive | "This case will probably fail — here's why." | Historical patterns predict failure modes before agent starts. |

## You Are Here

**L1.** pino logger in most modules. `api_usage` table tracks token counts. `task_run_logs` records scheduled task outcomes. Session logs are ephemeral (lost when conversation ends). No structured event capture, no cross-session analytics.

## What Exists

| Component | Level | Location |
|-----------|-------|----------|
| pino logger | L1 | `src/` (most modules) |
| `api_usage` table | L1 | `store/messages.db` |
| `task_run_logs` table | L1 | `store/messages.db` |
| `usage_categories` table | L1 | `store/messages.db` |
| Telemetry spec | Design | `docs/kaizen-telemetry-and-investigations-spec.md` |

## L1→L2: Structured Telemetry (next step)

**Problem L2 solves:** "This case cost $12" and "the agent modified 47 files" are knowable from a DB query, not archaeology.

**Rough shape:** Structured event emission on tool calls, file operations, and session boundaries. Stored in SQLite per-case. Queryable via `cli-kaizen` or MCP tool.

**Signal to escalate to L3:** If post-incident analysis repeatedly requires reconstructing "what was the agent thinking?" from git diffs because structured events don't capture the reasoning.

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
