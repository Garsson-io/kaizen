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
| **L1** | Tracking | "This case cost $X." Per-case token recording. | `api_usage` table, periodic reports |
| **L2** | Budgets | Per-case token budget. Warning at threshold. Hard cap. | Budget field in case, agent receives remaining budget |
| **L3** | Proportional gating | Expensive operations require justification. Low-value tasks get smaller budgets. | Task-class-to-budget mapping |
| **L4** | Optimization | Detect waste: re-reading files, redundant CI, oversized context. | Analytics on token-per-outcome |
| **L5** | Cost-quality tradeoffs | "I could write more tests for $5, but marginal improvement is small — skip." Auditable. | Decision framework with cost as explicit input |
| **L6** | Autonomous resource management | System adjusts parallelism, model choice, context strategy based on cost-per-quality-unit. | Self-optimizing resource allocation |

## You Are Here

**L1.** `api_usage` and `usage_categories` tables exist. Session cost visible in agent responses. No enforcement, no budgets, no alerts. Session-dev-agents spec mentions "max cost per session ($5 default?)" with a question mark — unresolved.

## What Exists

| Component | Level | Location |
|-----------|-------|----------|
| `api_usage` table | L1 | `store/messages.db` |
| `usage_categories` table | L1 | `store/messages.db` |
| Container timeout | L1 (time proxy) | `src/config.ts` |
| Usage tracking skill | L1 (reference) | `.claude/skills/usage-tracking/` |

## L1→L2: Per-Case Budgets (next step)

**Problem L2 solves:** A dev agent session running `/implement-spec` burns $15 when the budget was $5. Today: nobody notices until weekly review. L2: agent warned at $4, hard-stopped at $5.

**Rough shape:** Budget field in case record. Agent prompt includes remaining budget. MCP tool enforces hard cap by refusing to spawn new sessions when budget exhausted.

**Signal to escalate to L3:** Budget caps alone cause too many sessions killed mid-work because all tasks get the same budget regardless of complexity.

## L3–L4: Visible but not designed

**L3 (proportional gating):** Problem: a docs-only fix gets the same $5 budget as a complex refactor. Need: task classification that maps to budget tiers. Kaizen issues labeled `level-1` get $2, `level-3` get $10. Open question: who classifies — `/accept-case`, the agent itself, or automatic from labels?

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
