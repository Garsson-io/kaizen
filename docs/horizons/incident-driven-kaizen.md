# Horizon: Incident-Driven Kaizen

*"Specs are hypotheses. Incidents are data. When they conflict, trust the data."*

## Problem

The kaizen system says "has incidents > theoretical" in `/pick-work` scoring, but has no data structure to measure this. 98% of open kaizen issues have zero comments. When an agent encounters friction matching an existing issue, there's no enforcement or habit to record it. Incidents evaporate — the same issue gets re-discovered, re-discussed, and sometimes re-filed as a duplicate.

Without incident data:
- **Prioritization is opinion-based.** `/pick-work` can't distinguish "mentioned once as theoretical" from "happened 5 times this week."
- **Level escalation is reactive.** An L1 instruction stays L1 until a human notices it failed repeatedly. No signal triggers escalation.
- **Duplicate issues accumulate.** Agents file new issues for friction that already has a tracking issue, because finding the existing issue is harder than filing a new one.
- **Evidence doesn't compound.** Each agent session starts fresh. Friction encountered in session A doesn't inform session B's priorities.

## Taxonomy

| Level | Name | Signal | Mechanism | Status |
|-------|------|--------|-----------|--------|
| **L0** | No tracking | Friction evaporates after the session | Nothing | Was here |
| **L1** | Manual recording | Agent adds incident comments when it notices a match | Reflection prompt asks "does this match an existing issue?" | **Current target** |
| **L2** | Prompted recording | Reflection gate checks whether agent searched for existing issues before filing new ones | Hook validates search-before-file | Next step |
| **L3** | Structured incidents | Incident comments follow a schema; `incident-count:N` label auto-maintained | Hook + label automation on `gh issue comment` | Visible from here |
| **L4** | Incident-driven scoring | `/pick-work` reads incident count/recency as a first-class scoring signal | `cli-kaizen` exposes incident metadata; pick-work uses it | Visible from here |
| **L5** | Mid-work detection | Agent detects "this friction matches kaizen #N" during work (not just at reflection checkpoints) and records it without breaking flow | Lightweight MCP tool or background agent | Horizon |
| **L6** | Escalation triggers | Incident thresholds auto-escalate issue level (e.g., 3 incidents at L1 → auto-propose L2) | Mechanistic rule engine | Horizon |

## You Are Here

**L0 → L1.** We just learned this lesson (2026-03-19, kaizen #111 session). One agent has it in memory. The kaizen-reflect.sh prompt now asks agents to check for existing issues before filing new ones.

## L1: What we're doing now (instructions + prompt update)

**Changes:**
- Update `kaizen-reflect.sh` reflection prompt to ask: "For each impediment — does it match an existing open issue? If yes, add an incident comment. If no, file a new issue."
- Document the incident comment format (convention, not enforcement):
  ```
  ## Incident #N (YYYY-MM-DD)
  **PR/Context:** #NNN or description
  **Impact:** [time wasted | blocked | wrong output | human notified]
  **Details:** What happened, what the agent was doing, how it was resolved
  ```
- Update `/accept-case` awareness: when gathering evidence, count incident comments on the issue

**Why L1 is enough to start:** We need data before we can design the enforcement. The first few weeks of manual incident recording will reveal: how often do agents actually match to existing issues? What's the false-positive rate? Do incidents cluster around a few issues or spread evenly? This data informs L2 design.

**Signal to escalate to L2:** If agents consistently skip incident recording despite the prompt (same pattern as kaizen #104 — reflections without action), that's the signal that L1 instructions aren't sufficient.

## L2: What comes next (search-before-file enforcement)

**Problem L2 solves:** Agent identifies friction, files a new kaizen issue, but an existing issue already covers it. Duplicate filed, incident data lost on the original.

**Rough shape:**
- Before `gh issue create --repo Garsson-io/kaizen` succeeds through the gate, require evidence that the agent searched for existing issues (e.g., `gh search issues` or `gh issue list --search` must have been called in the current session)
- Not blocking — warning level. "Did you check if this matches an existing issue? Found N open issues with related keywords: [list]"

**Open question:** How to detect "related" without false positives? Keyword matching on titles? Label overlap? This needs data from L1 to answer.

## L3–L4: Visible but not designed

**L3 (structured incidents):**
- Problem: Incident comments are freeform text. Counting requires parsing prose.
- Need: Structured format that tools can parse. `incident-count:N` label maintained automatically.
- Open question: Who maintains the label — a CI action on issue comment? A hook? The agent itself?

**L4 (scoring integration):**
- Problem: `/pick-work` says "has incidents > theoretical" but can't measure it.
- Need: `cli-kaizen list` exposes incident count. Scoring uses it as a numeric signal.
- Open question: How to weight incident recency? 3 incidents last week vs 3 incidents last quarter should score differently.

## L5–L6: Horizon

**L5 (mid-work detection):** The hardest gap. Agents mid-work are focused on the task. Recording friction on a side issue breaks flow. Possible approaches: lightweight "friction note" tool that queues for later matching, background agent that listens for friction signals. Needs L1–L4 data to know if this is even necessary — maybe reflection checkpoints are frequent enough.

**L6 (auto-escalation):** If an L1 issue accumulates 3+ incidents, auto-propose level escalation. This is the promise of incident-driven kaizen: the system notices repeated failures and demands structural fixes. But designing this now would be premature — we need the data infrastructure (L3–L4) first.

## What We Can't See Yet

Beyond L6, the system starts to exhibit genuine learning: not just tracking incidents but detecting patterns across incidents (clustering), predicting which issues will recur (based on code area, complexity, agent type), and preemptively suggesting fixes before incidents happen. That's L7+ territory in the autonomous kaizen horizon — when the kaizen system itself becomes predictive rather than reactive.

## Relationship to Other Horizons

This horizon intersects with **Autonomous Kaizen** (`.claude/kaizen/horizon.md`):
- L4 here (incident-driven scoring) directly feeds L6 there (autonomous work selection)
- L6 here (auto-escalation) is a prerequisite for L7 there (autonomous implementation — the system needs to know WHAT to implement)
- Incident data is the fuel that makes autonomous kaizen possible. Without it, autonomous selection is just random backlog ordering.
