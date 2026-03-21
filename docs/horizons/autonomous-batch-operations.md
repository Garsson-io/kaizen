# Horizon: Autonomous Batch Operations

*"The system that improves itself while you sleep is the system that wins."*

## Problem

Today, kaizen improvement happens one session at a time, always with a human nearby. The overnight-dent script (`scripts/overnight-dent.sh`) is the first step toward unattended batch operations — but it's a bare loop with no memory, no reporting, no safety rails, and no strategic intelligence. It runs `/make-a-dent` repeatedly but doesn't know what happened, can't tell anyone, and has no circuit breakers.

Without autonomous batch operations:
- **Improvement velocity is human-gated** — agents only work when Aviad is awake and watching
- **Night hours are wasted** — 8+ hours of compute time sit idle every day
- **No run accountability** — if a batch run creates a bad PR, there's no trail connecting it to the guidance that spawned it
- **Failure cascades silently** — a misconfigured run loops forever, burning tokens with no output
- **No strategic steering** — the system can't look at what it accomplished and adjust what it works on next

The vision: a batch runner that operates like a disciplined team lead. It picks work, delegates to agents, tracks what they produce, reports to the admin, detects problems, adjusts course, and leaves the codebase measurably better every morning. Not a cron job — a trusted night shift.

## Taxonomy

| Level | Name | What the system can do | Mechanism |
|-------|------|------------------------|-----------|
| **L0** | Manual | Human starts each session, watches it | Interactive `claude-wt` |
| **L1** | Basic loop | Script loops `/make-a-dent` with guidance. Logs to files. | `overnight-dent.sh` (current state) |
| **L2** | Tagged & tracked | Each run gets a unique tag. PRs, issues, and cases created are extracted and logged. Batch creates a summary issue. | Output parsing, `--output-format json`, GitHub issue per batch |
| **L3** | Governed | Cost caps (per-run and total), consecutive failure detection, tight-loop prevention, graceful shutdown on signals. | Budget tracking, exit code analysis, cooldown escalation, SIGTERM handler |
| **L4** | Reporting | Admin gets a structured report after each run and a batch summary. Telegram notification with PRs shipped, issues filed, money spent. | IPC messaging to admin channel, structured summaries |
| **L5** | Strategic | Ultrathink before the batch: assess backlog, choose high-value guidance. Gap analysis every N runs. Adaptive work selection. | Pre-batch planning phase, `/gap-analysis` integration, guidance evolution |
| **L6** | Self-steering | System measures what previous batches accomplished (PRs merged, issues closed, rework rate) and adjusts strategy autonomously. | Outcome tracking, feedback loop, strategy refinement |
| **L7** | Fleet | Multiple parallel batch streams, each working an orthogonal domain. Coordination to prevent merge conflicts. | Multi-process orchestration, WIP deconfliction, domain partitioning |

## You Are Here

**L3: Governed + Observable.** Trampoline/runner split: `overnight-dent.sh` (bash trampoline with `git pull` self-update between runs) delegates to `overnight-dent-run.ts` (TypeScript runner with `--output-format stream-json` real-time observability). Features: batch IDs, per-run tagging, output parsing, stream-json milestone display, heartbeat during silence, `OVERNIGHT_STOP:` loop control (agent can stop the batch), cross-run state in `state.json`, cumulative context. Safety: consecutive failure detection, fast-fail escalating cooldown, graceful SIGTERM/SIGINT shutdown. Not yet implemented: total budget enforcement, admin notifications, strategic planning.

## What Exists

| Component | Level | Location |
|-----------|-------|----------|
| `overnight-dent.sh` | L3 (trampoline) | `scripts/overnight-dent.sh` |
| `overnight-dent-run.sh` | L3 (wrapper) | `scripts/overnight-dent-run.sh` |
| `overnight-dent-run.ts` | L3 (runner) | `scripts/overnight-dent-run.ts` |
| `claude-wt.sh` | Foundation | `scripts/claude-wt.sh` |
| `/make-a-dent` skill | Foundation | `.claude/skills/make-a-dent/SKILL.md` |
| `/gap-analysis` skill | Foundation (L5 prereq) | `.claude/skills/gap-analysis/SKILL.md` |
| `--max-budget-usd` flag | L1 cost cap | Claude CLI |
| `--output-format stream-json` | L3 enabler | Claude CLI |
| IPC messaging | L4 enabler | `docs/ipc-messaging.md` |
| Cost governance horizon | Related | `docs/horizons/cost-governance.md` |

## L1→L2: Tagged & Tracked (next step)

**Problem L2 solves:** After a batch run, you open the log directory and see timestamped files with raw claude output. You have no idea which runs produced PRs, which filed issues, or which created cases. You have to grep through logs manually.

**What L2 delivers:**

1. **Run tagging.** Each run gets a unique ID (`batch-YYMMDD-HHMM-XXXX/run-N`). The prompt passed to the agent includes this tag so it appears in commit messages and PR descriptions.

2. **Output parsing.** After each run, extract:
   - PRs created (URLs)
   - Issues filed (URLs)
   - Issues closed (URLs)
   - Cases created (names)
   - Exit code and error category (success, budget exceeded, crash, timeout)

3. **Per-run report.** After each run completes, print a structured summary:
   ```
   Run #3 | 4m23s | $2.14 | exit: budget_exceeded
     PRs:    #234 (fix: hook interaction tests)
     Issues: #267 (filed), #251 (closed)
     Case:   260321-0234-k267-hook-gate-format
   ```

4. **Batch summary issue.** When the batch completes (all runs done or stopped), create a GitHub issue in Garsson-io/kaizen documenting:
   - Guidance prompt
   - Number of runs, total duration, total cost
   - All PRs created (with status: open/merged/closed)
   - All issues filed and closed
   - Failure modes encountered
   - Label: `batch-run`, `autonomous`

**Signal to escalate to L3:** A batch run burns through budget without producing value (e.g., 5 runs, $25, zero PRs). Or a run crashes and the next run picks the same broken issue, creating a tight loop.

## L2→L3: Governed (safety & cost)

**Problem L3 solves:** The batch runner has no immune system. A broken issue causes every run to crash. A misconfigured guidance prompt causes tight loops. There's no total budget across runs, only per-run caps.

**What L3 delivers:**

1. **Consecutive failure detection.** If N consecutive runs exit with non-zero (default N=3), stop the batch. Something is systematically wrong.

2. **Total batch budget.** `--total-budget N.NN` caps total spend across all runs. Tracked by summing per-run costs.

3. **Tight-loop prevention.** If a run completes in under 60 seconds with no meaningful output (no PRs, no issues, no commits), it's probably failing fast. Exponential cooldown: 30s → 60s → 120s → 240s → stop.

4. **Graceful shutdown.** SIGTERM/SIGINT handler: finish current run, write summary, create batch issue, exit cleanly. Don't kill the agent mid-work.

5. **Issue dedup guard.** Track which kaizen issues were attempted. If the same issue appears in consecutive failed runs, skip it and move on. Pass an exclusion list to the agent: "Do NOT work on issues #X, #Y — they failed in previous runs."

6. **Stale worktree cleanup.** After each run, check if the worktree was cleaned up. If claude-wt left a dirty worktree, log it but don't force-clean (other processes may claim it).

**Signal to escalate to L4:** The admin wakes up and has to dig through GitHub to find what happened overnight. Or a batch silently stopped at 2 AM and nobody knew until morning.

## L3→L4: Reporting (admin notifications)

**Problem L4 solves:** The batch runs all night. The admin wakes up and has no idea what happened without checking logs and GitHub manually.

**What L4 delivers:**

1. **Per-run Telegram notification.** After each successful run (PR created), send a brief message to the admin channel:
   ```
   [overnight-dent] Run #3 complete
   PR: github.com/Garsson-io/nanoclaw/pull/234
   Case: k267-hook-gate-format | $2.14 | 4m23s
   ```

2. **Batch summary notification.** When the batch finishes:
   ```
   [overnight-dent] Batch complete: 7 runs, 5h12m, $18.40
   PRs shipped: #234, #236, #238
   Issues filed: #267, #269
   Issues closed: #251, #253, #258
   Stopped: max-runs reached
   ```

3. **Alert on anomaly.** If the batch stops due to consecutive failures or budget exhaustion, send an alert immediately (don't wait for morning):
   ```
   [overnight-dent] STOPPED: 3 consecutive failures
   Last error: case creation collision on #251
   Guidance: "focus on hooks reliability"
   Runs completed: 2/unlimited | $4.20 spent
   ```

**Signal to escalate to L5:** The admin keeps tweaking the guidance prompt because the system picks suboptimal work. Or the system exhausts one domain and keeps trying issues in an area where all remaining work is blocked.

## L4→L5: Strategic (ultrathink & gap analysis)

**Problem L5 solves:** The human provides a static guidance prompt. The system has no ability to assess what's valuable, adapt to what it's already done, or strategically diversify across domains.

**What L5 delivers:**

1. **Pre-batch ultrathink.** Before the first run, spawn a planning session (Opus, high effort) that:
   - Reads the kaizen backlog
   - Checks WIP (active cases, open PRs)
   - Runs `/gap-analysis` (or reads a recent one)
   - Produces a ranked list of domains and specific issues to target
   - The human's guidance becomes a *constraint* ("focus on hooks") not a *command*

2. **Gap analysis every N runs.** Every 5th run (configurable), instead of `/make-a-dent`, run `/gap-analysis` to reassess:
   - What domains still have high-value open work?
   - What did the previous runs accomplish? Did they shift the gap landscape?
   - Should the guidance evolve? (e.g., "hooks are clean now, shift to testing infra")

3. **Adaptive exclusion.** Maintain a running context across runs:
   - Issues attempted (succeeded or failed)
   - Domains worked (to encourage diversity)
   - PRs awaiting merge (avoid working on code that'll conflict)

4. **Run-specific guidance.** Instead of passing the same prompt every time, generate per-run guidance that incorporates what previous runs did:
   ```
   Run 6 guidance: "Previous runs fixed 3 hook issues. Hooks domain is mostly clean.
   Shift to testing infra — 7 open issues, no active work. Avoid issue #251 (failed in run 2)."
   ```

**Signal to escalate to L6:** The system is good at executing guidance but can't evaluate whether the guidance was valuable. PRs get merged but don't measurably improve the codebase metrics.

## L5→L6: Self-Steering

**Problem L6 solves:** The system does what it's told (well) but doesn't know if what it's doing matters. It can't close the loop between "what was done" and "did it help."

**What L6 delivers:**

1. **Outcome tracking.** After each batch, measure:
   - PRs merged vs reverted vs abandoned
   - Issues that stayed closed vs reopened
   - New incidents in domains that were "fixed"
   - Cost per merged PR (efficiency metric)

2. **Strategy adjustment.** Based on outcome data:
   - Domains where PRs consistently merge → continue investing
   - Domains where PRs get reverted → flag for human review, stop autonomous work there
   - Domains with diminishing returns → rotate to fresh territory

3. **Guidance generation.** The system writes its own guidance prompt based on measured gaps and historical success rates. The human's role shifts from "tell it what to do" to "approve the plan."

## L7: Fleet (distant horizon)

Multiple parallel batch streams, each in its own tmux session, each working an orthogonal domain. A coordinator agent prevents merge conflicts, balances load, and ensures domain coverage. The admin sees a dashboard of all active streams, their progress, and their aggregate cost.

This requires Observability L4+ and Cost Governance L3+ as prerequisites. Not designed here.

## What We Can't See Yet

Beyond L7, the batch runner becomes a development organization. It has standup meetings (gap analysis), sprint planning (ultrathink), execution (make-a-dent), retrospectives (kaizen reflection), and resource allocation (cost governance). The human's role is board-level: set direction, approve budgets, review outcomes. The system handles everything else.

This is the end state of the Zen of Kaizen: *"The goal is not to be done. The goal is to be better at not being done."*

## The Inspirational View

Imagine waking up to this:

```
Good morning. While you slept:

7 runs completed over 6h14m. Total cost: $31.20

Shipped:
  PR #234: fix hook gate/clear format mismatch (3 bugs, 2 interaction tests)
  PR #236: add missing allowlist entries for container MCP tools
  PR #238: enforce co-committed test policy in pre-push hook

Filed:
  Issue #267: [L2] Hook state files need TTL cleanup
  Issue #269: [L2] Container timeout should scale with task complexity

Closed:
  #251, #253, #258 (all fixed by PR #234)

Gap analysis (run 5): hooks domain 80% clean. Testing infra now highest-value.
  → Adjusted guidance for runs 6-7 to target testing.

Next recommended batch: "testing infrastructure — interaction test framework"
  Estimated: 5 runs, ~$25, targets 4 open issues.
  Approve? [yes / modify / skip]
```

That's L5. Every night, the codebase gets measurably better. Every morning, the admin reviews what happened, approves the next batch, and goes back to product work. The system that improves itself while you sleep is the system that wins.

## Relationship to Other Horizons

- **Cost Governance L2+ is prerequisite for L3** — per-case budgets enable per-run budgets
- **Observability L2+ is prerequisite for L5** — structured telemetry enables outcome tracking
- **Resilience L2+ is prerequisite for L3** — state preservation enables graceful shutdown
- **Human-Agent Interface L2+ is prerequisite for L4** — structured summaries enable admin reports
- **Autonomous Kaizen L5+ is the destination** — batch operations are how autonomous kaizen actually runs
- **Incident-Driven Kaizen feeds L3** — failure patterns from incidents inform stop conditions
