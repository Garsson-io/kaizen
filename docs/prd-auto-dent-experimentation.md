# PRD: Auto-Dent Experimentation Framework

**Status:** Draft
**Author:** Aviad + Claude
**Date:** 2026-03-23
**Related:** #295 (Observability Horizon), #501 (Phase Markers)

## Problem

Auto-dent runs autonomously, but we have no way to **measure** whether changes
to prompts, hooks, skills, or workflow improve outcomes. When we modify the
deep-dive prompt or add a new hook, we can't answer: "did that make runs more
productive?" We're flying blind.

Andrej Karpathy's [autoresearch](https://github.com/karpathy/autoresearch)
demonstrated a powerful pattern: bounded autonomous experiments with a clear
scoring metric, run overnight, producing measurable improvements. Auto-dent
already has the loop — it just lacks the **experiment** and **scoring**
infrastructure.

## Inspiration: Karpathy's Autoresearch

Autoresearch gives an AI agent a training setup and lets it experiment overnight:

1. **Bounded runs** — each experiment runs for exactly 5 minutes
2. **Single metric** — val_bpb (lower = better), comparable across runs
3. **Keep/discard** — only improvements survive to the next iteration
4. **program.md** — humans program the *research direction*, not the code
5. **~100 experiments/night** — massive parallel exploration

The key insight: **the human programs the experiment specification, the agent
programs the implementation.** The loop produces measurable results.

## Vision: Auto-Dent as an Experimentation Platform

Auto-dent already has:
- A bounded run loop with state tracking
- Stream-json observability with phase markers
- Cross-run state (state.json)
- A test harness for replay and live probes

What's missing is the ability to **vary inputs** and **score outputs**.

### The Experiment Loop

```
┌─────────────────────────────────────────────┐
│  experiment.md (human-authored)              │
│  - hypothesis: "adding X to prompt improves Y"│
│  - variants: [baseline, treatment]           │
│  - metric: success_rate / cost / phases_hit  │
│  - budget: N runs per variant                │
└──────────────────┬──────────────────────────┘
                   │
          ┌────────▼────────┐
          │  Experiment      │
          │  Runner          │
          │                  │
          │  For each variant:│
          │    Run N times   │
          │    Capture stream│
          │    Score results │
          └────────┬────────┘
                   │
          ┌────────▼────────┐
          │  Scoreboard      │
          │                  │
          │  Compare variants│
          │  Statistical sig │
          │  Recommend winner│
          └─────────────────┘
```

### What We Can Experiment On

| Dimension | Example variants |
|-----------|-----------------|
| **Prompt** | Deep-dive vs. targeted prompt; with/without batch context |
| **Phase markers** | With vs without; effect on workflow coherence |
| **Hooks** | With/without specific enforcement hooks |
| **Skills** | Different skill chains (evaluate→implement vs. direct) |
| **Budget** | $2 vs $5 per run — diminishing returns? |
| **Model** | Opus vs Sonnet for different task types |
| **Guidance** | Focused ("hooks only") vs broad ("all epics") |

### Scoring Metrics

Each run already produces structured data via phase markers and state.json:

| Metric | Source | What it measures |
|--------|--------|-----------------|
| **success_rate** | exit code + PR created | Did the run produce output? |
| **cost** | result message | Efficiency |
| **phases_completed** | phase markers | Workflow coherence (did it follow the full flow?) |
| **time_to_first_pr** | timestamps | Speed to value |
| **pr_merge_rate** | post-run hygiene | Quality (do PRs actually merge?) |
| **issues_per_dollar** | state.json | ROI |
| **stop_rate** | AUTO_DENT_STOP | Does the agent know when to stop? |

### Experiment Specification (experiment.md)

Following Karpathy's program.md pattern, experiments are defined in markdown:

```markdown
# Experiment: Phase markers improve workflow coherence

## Hypothesis
Adding AUTO_DENT_PHASE markers to the prompt will increase
the number of completed workflow phases per run.

## Variants
- baseline: current prompt without phase marker instructions
- treatment: prompt with phase marker instructions (PR #502)

## Metric
Primary: phases_completed (count of distinct phases per run)
Secondary: success_rate, cost

## Budget
- 5 runs per variant
- $3 max per run
- Timeout: 10 minutes per run

## Variant config
### baseline
prompt_template: prompts/deep-dive-v1.md
hooks: default

### treatment
prompt_template: prompts/deep-dive-v2-phases.md
hooks: default
```

### Architecture

```
scripts/
  auto-dent-harness.ts      ← exists: stream simulation, replay, live probe
  auto-dent-experiment.ts   ← new: experiment runner
  auto-dent-score.ts        ← new: scoring functions
  experiments/              ← new: experiment specs (*.md)
  prompts/                  ← new: prompt variants
```

**Experiment runner** reads an experiment.md, runs each variant N times using
`runLiveProbe()` from the harness, collects `StreamCapture` results, and
passes them to the scorer.

**Scorer** computes metrics from `StreamCapture` + state.json, compares
variants, and produces a report.

**The harness is the foundation.** Everything builds on `runStream()`,
`replayLog()`, and `runLiveProbe()` — the three layers already implemented
in auto-dent-harness.ts.

## Implementation Phases

### Phase 1: Scoring (current PR scope)
- [x] Phase markers in prompt + parser
- [x] Test harness with message builders + assertions
- [x] Log replay capability
- [x] Live smoke test
- [ ] Score functions: extract metrics from StreamCapture

### Phase 2: Experiment Runner
- [ ] Experiment spec parser (experiment.md → config)
- [ ] Multi-variant runner (N runs per variant)
- [ ] Results aggregation + comparison
- [ ] Report generation (markdown table)

### Phase 3: Prompt Variants
- [ ] Extract current prompt to external template
- [ ] Variant injection mechanism
- [ ] Hook enable/disable per variant

### Phase 4: Continuous Experimentation
- [ ] Auto-experiment mode: run experiments overnight
- [ ] Scoreboard persistence (experiments.json)
- [ ] Winner promotion: auto-update prompts when treatment wins
- [ ] GitHub issue with experiment results

## Design Principles

1. **Bounded** — every experiment has a budget ceiling (runs × cost/run)
2. **Comparable** — same metric, same conditions, just the variable changes
3. **Observable** — phase markers + stream capture make everything visible
4. **Replayable** — captured logs can be re-scored with new metrics
5. **Human-in-the-loop** — humans write experiment.md, agents run experiments

## Risks

- **Cost**: even bounded experiments cost money. Start with $0.05 smoke probes.
- **Flakiness**: agent behavior is non-deterministic. Need N>3 runs per variant.
- **Side effects**: real runs create PRs/issues. Need dry-run variant support.
- **Metric gaming**: agents optimize for the metric, not the goal. Keep metrics
  grounded in real outcomes (merged PRs, not just created PRs).

## References

- [Karpathy's autoresearch](https://github.com/karpathy/autoresearch) — the inspiration
- [Fortune: Why everyone is talking about Karpathy's autonomous AI research agent](https://fortune.com/2026/03/17/andrej-karpathy-loop-autonomous-ai-agents-future/)
- [VentureBeat: Run hundreds of AI experiments a night](https://venturebeat.com/technology/andrej-karpathys-new-open-source-autoresearch-lets-you-run-hundreds-of-ai)
