# Horizon: Cost Governance

*"The most dangerous agent is the one that spends money as fast as the API allows, with nobody watching."*

## Problem

AI agents consume expensive API tokens with no natural governor. Human teams are slow and salaried — their cost is fixed. Agents can spin up sessions, call models, and burn tokens at API speed. A kaizen loop that creates infinite improvement suggestions, each spawning agent sessions, has no ceiling. Today, total cost is unknown until the invoice arrives.

Without cost governance:
- **Runaway sessions go undetected** — agent loops or expands scope without limit
- **No cost-quality tradeoffs** — every task gets maximum resources regardless of value
- **Budget surprises** — "we spent $500 on kaizen this month" is discovered after the fact
- **Autonomous operation is financially risky** — can't let agents run unsupervised without budgets

## Taxonomy

| Level | Name | What's controlled | Mechanism |
|-------|------|-------------------|-----------|
| **L0** | No awareness | Nothing. Invoice arrives. | None |
| **L1** | Tracking | "This case cost $X." Per-run cost recording. | `RunScore.cost_usd`, batch summaries |
| **L2** | Budgets | Per-case token budget. Warning at threshold. Hard cap. | Budget field in case, agent receives remaining budget |
| **L3** | Proportional gating | Expensive operations require justification. Low-value tasks get smaller budgets. | Task-class-to-budget mapping |
| **L4** | Optimization | Detect waste: re-reading files, redundant CI, oversized context. | Analytics on token-per-outcome |
| **L5** | Cost-quality tradeoffs | "I could write more tests for $5, but marginal improvement is small — skip." Auditable. | Decision framework with cost as explicit input |
| **L6** | Autonomous resource management | System adjusts parallelism, model choice, context strategy based on cost-per-quality-unit. | Self-optimizing resource allocation |

## You Are Here

**L1-L2 (partial).** Auto-dent tracks `cost_usd` per run via Claude's `total_cost_usd` in result messages. `BatchScore.total_cost_usd` aggregates across runs. Cost anomaly detection (`detectCostAnomaly`) flags runs exceeding rolling average thresholds. Batch reflection summaries include total cost. Efficiency metrics (`cost_per_pr`, PRs-per-dollar) are computed per run.

Gaps: No per-case budgets or hard caps. No cost-aware mode selection (expensive modes aren't deprioritized based on spend). No cross-batch cost trending.

## What Exists

| Component | Level | Location |
|-----------|-------|----------|
| Per-run cost tracking (`cost_usd`) | L1 | `scripts/auto-dent-score.ts` (`RunScore`) |
| Batch cost aggregation | L1 | `scripts/auto-dent-score.ts` (`BatchScore.total_cost_usd`) |
| Cost anomaly detection | L2 | `scripts/auto-dent-score.ts` (`detectCostAnomaly`) |
| Cost efficiency metrics | L1 | `scripts/auto-dent-score.ts` (`cost_per_pr`, `efficiency`) |
| Wall-time timeout (cost proxy) | L1 | `scripts/auto-dent-run.ts` (wall-time watchdog) |
| Batch reflection with cost summary | L1 | `scripts/auto-dent-ctl.ts` (`buildBatchReflection`) |

## L2→L3: Per-Case Budgets & Proportional Gating (next step)

**Problem L3 solves:** Cost anomaly detection flags expensive runs after the fact, but doesn't prevent them. A docs-only fix and a complex refactor get the same budget. Today: `--max-budget-usd` is a flat cap per run. L3: task classification maps to budget tiers, and the harness enforces per-case budgets proactively.

**Rough shape:** Task-class-to-budget mapping derived from issue labels (`level-1` → $2, `level-3` → $10). Agent prompt includes remaining budget. Hard cap enforcement via cost tracking during the run.

**Signal to escalate to L4:** Budget caps cause too many runs killed mid-work because the system can't distinguish "this task legitimately needs more budget" from "this task is wasting money."

## L3–L4: Visible but not designed

**L3 (proportional gating):** Problem: a docs-only fix gets the same $5 budget as a complex refactor. Need: task classification that maps to budget tiers. Kaizen issues labeled `level-1` get $2, `level-3` get $10. Open question: who classifies — `/kaizen-evaluate`, the agent itself, or automatic from labels?

**L4 (optimization):** Problem: agent re-reads the same 500-line file 6 times in a session, burning tokens. Need: analytics that identify wasteful patterns and suggest caching or context management strategies.

## L5–L6: Horizon

**L5 (cost-quality tradeoffs):** The system makes explicit tradeoff decisions: "writing 3 more edge case tests would cost $4 in tokens but reduce change failure rate by 2% — skip." These decisions are logged and auditable, not hidden in agent reasoning.

**L6 (autonomous resource management):** System dynamically chooses: Haiku for simple label checks ($0.001), Sonnet for code review ($0.10), Opus for complex refactoring ($1.00). Parallelism adjusted based on queue depth and budget remaining for the period.

## What We Can't See Yet

Beyond L6, cost governance becomes a strategic tool: the system allocates budget across horizons based on measured ROI. "Investing $50/week in Testability improvements saves $200/week in rework. Investing $50/week in Security improvements has no measurable savings yet — defer." This requires Observability L5 (pattern analytics) as a prerequisite.

## Relationship to Other Horizons

- **Cost Governance constrains Autonomous Kaizen** — autonomous agents need budgets to prevent runaway
- **Observability feeds Cost Governance** — can't budget what you can't measure
- **Cost Governance interacts with Resilience L3** — retry policies have cost implications
- **Human-Agent Interface L3** (structured approval) — budget delegation is a trust decision
